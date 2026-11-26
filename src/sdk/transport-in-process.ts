// In-process transport: drives the MCP server's handler maps directly in
// the same Node process. This is the SDK default — no subprocess, no IPC,
// no socket. Egress hygiene (URL sanitizer, `<SECRET_NAME>` substitution,
// capability gates, session isolation) is the SAME code path the MCP
// transport runs: a core tool is called through `wireHandlers`, the form the
// stdio server and the socket daemon serve, so a result and a thrown error's
// message are both masked for registered secrets (see register() in
// src/tools/host-build.ts). A tool that throws still rejects the SDK call,
// with the masked message.

import { createServer, type StartOptions } from "../server.js";
import { unwrapResult, type SdkTransport } from "./transport.js";
import { registerTransport } from "./transport-registry.js";
import { docsUrl } from "../util/docs-links.js";
import type { BrowxaiContentItem } from "./types.js";

/** The message of an error result: its text items, joined. */
function errorText(content: ReadonlyArray<BrowxaiContentItem>): string {
  return content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

/**
 * Construct an in-process transport. The factory `await`s the underlying
 * `createServer()` (which does NOT start the MCP stdio loop — `server.start()`
 * is what does that, and the SDK never calls it) so the returned transport
 * is immediately ready to dispatch.
 */
export async function openInProcessTransport(opts: StartOptions = {}): Promise<SdkTransport> {
  const server = await createServer(opts);
  const { handlers, wireHandlers } = server;
  let closed = false;

  const dispatch = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    if (closed)
      throw new Error(
        `browxai-sdk: cannot call ${toolName}, the transport is closed. Create a new client.`,
      );
    // `handlers` throws, and a thrown message would skip the mask, so a core
    // tool goes through its wire entry. A plugin tool has no wire entry and
    // catches its own errors. Own properties only: the maps are plain objects,
    // so a bare lookup of `constructor` would find a function on the prototype.
    const fn = Object.hasOwn(wireHandlers, toolName)
      ? wireHandlers[toolName]
      : Object.hasOwn(handlers, toolName)
        ? handlers[toolName]
        : undefined;
    if (!fn) {
      throw new Error(
        `browxai-sdk: unknown tool "${toolName}", it is not registered on the in-process server. ` +
          `Check the name against ${docsUrl.toolReference}. If it is listed there, this SDK build is older than the server's tool list.`,
      );
    }
    const result: { content: BrowxaiContentItem[]; isError?: boolean } = await fn(args);
    // The wire entry turns a throw into an error result. Only that path sets
    // `isError`, so it is turned back into the rejection callers had before.
    if (result.isError === true) throw new Error(errorText(result.content));
    return unwrapResult(result.content);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await server.shutdown().catch(() => undefined);
  };

  return { dispatch, close };
}

// RFC 0004 P4 / D6 — self-register under the "in-process" mode. The factory maps
// the SDK options to this opener's argument shape EXACTLY as the old
// `case "in-process"` arm did (`{ attachCdp, headless }`).
registerTransport("in-process", {
  open: (opts) => openInProcessTransport({ attachCdp: opts.attachCdp, headless: opts.headless }),
});
