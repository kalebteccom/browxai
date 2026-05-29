// In-process transport: drives the MCP server's `handlers` map directly in
// the same Node process. This is the SDK default — no subprocess, no IPC,
// no socket. Egress hygiene (URL sanitizer, `<SECRET_NAME>` substitution,
// capability gates, session isolation) is the SAME code path the MCP
// transport runs, because `handlers[name]` IS the wrapped registered
// handler — gate + sanitiser inclusive (see register() in src/server.ts).

import { createServer, type StartOptions } from "../server.js";
import { parseEnvelope, type SdkTransport } from "./transport.js";
import type { BrowxaiResult } from "./types.js";

export interface InProcessOptions extends StartOptions {
  /** When true, suppress the server's MCP stdio binding — the SDK never wants
   *  the server.start() side-effect (which would attach to process.stdin/out).
   *  We only need the `handlers` map. */
}

export interface InProcessTransportHandle {
  /** Map of tool-name → wrapped handler that returns MCP content. */
  readonly handlers: Awaited<ReturnType<typeof createServer>>["handlers"];
  /** Underlying server's shutdown — closes every live session. */
  readonly shutdown: () => Promise<void>;
}

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

  const dispatch = async (toolName: string, args: Record<string, unknown>): Promise<BrowxaiResult> => {
    if (closed) throw new Error(`browxai-sdk: dispatch on a closed transport (tool=${toolName})`);
    const fn = handlers[toolName];
    if (!fn) {
      throw new Error(
        `browxai-sdk: unknown tool "${toolName}" — not registered on the in-process server. ` +
          `Either the tool name is wrong or the SDK's tool registry is out of sync with server.ts.`,
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
