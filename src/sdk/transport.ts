// SDK transport interface — abstracts the wire between the SDK client and
// the browxai server. The single method is `dispatch(toolName, args)`: a
// tool name + JSON args → an MCP-shaped `{ content }` envelope. Three
// implementations exist:
//
//   1. InProcessTransport (src/sdk/transport-in-process.ts) — drives the
//      server's `handlers` map directly. No subprocess, no socket. Owns the
//      server lifecycle (`close` calls `server.shutdown()`).
//
//   2. StdioChildTransport (src/sdk/transport-stdio-child.ts) — spawns
//      `browxai` as a child process and speaks MCP-over-stdio to it via the
//      MCP SDK's StdioClientTransport. Owns the child lifecycle.
//
//   3. SocketTransport (src/sdk/transport-socket.ts) — attaches to an
//      already-running browxai server over a Unix socket (or named pipe on
//      Windows). The SDK does NOT own the server lifecycle; `close()` only
//      tears down the local connection.

import type { BrowxaiContentItem, BrowxaiResult } from "./types.js";

/** Lower-level transport contract. One method, idempotent close. */
export interface SdkTransport {
  /** Dispatch a single tool call and return the SDK envelope. */
  dispatch(toolName: string, args: Record<string, unknown>): Promise<BrowxaiResult>;
  /** Tear down the transport. Idempotent. */
  close(): Promise<void>;
}

/** Parse the first text item of an MCP content array as JSON, when applicable. */
export function parseEnvelope(content: ReadonlyArray<BrowxaiContentItem>): BrowxaiResult {
  for (const item of content) {
    if (item && item.type === "text") {
      try {
        const parsed = JSON.parse(item.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { content, data: parsed as Record<string, unknown> };
        }
      } catch {
        /* not JSON — a snapshot tree or other plain-text payload */
      }
      return { content };
    }
  }
  return { content };
}
