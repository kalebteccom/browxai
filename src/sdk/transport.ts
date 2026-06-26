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

import type { BrowxaiResult } from "./types.js";

/** Lower-level transport contract. One method, idempotent close. */
export interface SdkTransport {
  /** Dispatch a single tool call and return the SDK envelope. */
  dispatch(toolName: string, args: Record<string, unknown>): Promise<BrowxaiResult>;
  /** Tear down the transport. Idempotent. */
  close(): Promise<void>;
}

// The concrete envelope decoder now lives in the ./envelope.js leaf so the
// transport adapters can depend on it without cycling through this barrel.
// Re-exported here so existing `./transport.js` importers keep resolving it.
export { parseEnvelope } from "./envelope.js";
