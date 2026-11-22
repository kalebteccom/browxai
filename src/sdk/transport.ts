// SDK transport interface — abstracts the wire between the SDK client and
// the browxai server. The single method is `dispatch(toolName, args)`: a
// tool name + JSON args → the tool's result, unwrapped (see unwrapResult). Three
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

/** Lower-level transport contract. One method, idempotent close. */
export interface SdkTransport {
  /** Dispatch a single tool call and return its unwrapped result. */
  dispatch(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  /** Tear down the transport. Idempotent. */
  close(): Promise<void>;
}

// The concrete result decoder now lives in the ./envelope.js leaf so the
// transport adapters can depend on it without cycling through this barrel.
// Re-exported here so existing `./transport.js` importers keep resolving it.
export { parseEnvelope, unwrapResult } from "./envelope.js";
