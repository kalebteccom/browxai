// In-process transport: drives the MCP server's `handlers` map directly in
// the same Node process. This is the SDK default — no subprocess, no IPC,
// no socket. Egress hygiene (URL sanitizer, `<SECRET_NAME>` substitution,
// capability gates, session isolation) is the SAME code path the MCP
// transport runs, because `handlers[name]` IS the wrapped registered
// handler — gate + sanitiser inclusive (see register() in src/server.ts).

import { createServer, type StartOptions } from "../server.js";
import { parseEnvelope, type SdkTransport } from "./transport.js";
import { registerTransport } from "./transport-registry.js";
import type { BrowxaiResult } from "./types.js";
import { docsUrl } from "../util/docs-links.js";

/**
 * Construct an in-process transport. The factory `await`s the underlying
 * `createServer()` (which does NOT start the MCP stdio loop — `server.start()`
 * is what does that, and the SDK never calls it) so the returned transport
 * is immediately ready to dispatch.
 */
export async function openInProcessTransport(opts: StartOptions = {}): Promise<SdkTransport> {
  const server = await createServer(opts);
  const handlers = server.handlers;
  let closed = false;

  const dispatch = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<BrowxaiResult> => {
    if (closed)
      throw new Error(
        `browxai-sdk: cannot call ${toolName}, the transport is closed. Create a new client.`,
      );
    const fn = handlers[toolName];
    if (!fn) {
      throw new Error(
        `browxai-sdk: unknown tool "${toolName}", it is not registered on the in-process server. ` +
          `Check the name against ${docsUrl.toolReference}. If it is listed there, this SDK build is older than the server's tool list.`,
      );
    }
    const result = await fn(args);
    return parseEnvelope(result.content);
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
