// Endpoint-attached transport: connect to an already-running browxai server
// over a Unix domain socket (macOS/Linux) or a Windows named pipe. The wire
// protocol is MCP-over-newline-delimited-JSON, byte-identical to stdio.
//
// Endpoint formats accepted:
//   unix:///absolute/path/to/sock     — Unix domain socket (mac/Linux)
//   pipe://./pipe/<name>              — Windows named pipe (\\.\pipe\<name>)
//
// The SDK does NOT own the server lifecycle on this path. `close()` ends the
// local connection only. The server is expected to have been launched
// out-of-band by the operator (e.g. `browxai serve --socket /tmp/foo.sock`).

import { createConnection, type Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NAME, VERSION } from "../server.js";
import { SocketTransport } from "../transport/socket-transport.js";
import { unwrapResult, type SdkTransport } from "./transport.js";
import { registerTransport } from "./transport-registry.js";
import type { BrowxaiContentItem } from "./types.js";

/**
 * Translate the SDK-public endpoint URL into a Node `net.connect` path. The
 * scheme namespace is intentionally small so a typo (e.g. `tcp://`) fails
 * loudly rather than silently mis-routing.
 */
export function resolveEndpointPath(endpoint: string): string {
  if (endpoint.startsWith("unix://")) {
    const path = endpoint.slice("unix://".length);
    if (!path) throw new Error(`browxai-sdk: invalid endpoint "${endpoint}" — empty unix:// path`);
    return path;
  }
  if (endpoint.startsWith("pipe://")) {
    // pipe://./pipe/foo  →  \\.\pipe\foo  (Windows named-pipe convention)
    const tail = endpoint.slice("pipe://".length).replace(/^\.\//, "");
    if (!tail) throw new Error(`browxai-sdk: invalid endpoint "${endpoint}" — empty pipe:// path`);
    return `\\\\.\\${tail.replace(/\//g, "\\")}`;
  }
  throw new Error(
    `browxai-sdk: unsupported endpoint scheme in "${endpoint}". ` +
      `Use unix:///path/to/sock, or pipe://./pipe/name on Windows.`,
  );
}

export interface SocketTransportOptions {
  /** SDK-public endpoint URL — see resolveEndpointPath above. */
  readonly endpoint: string;
}

export interface ConnectOptions {
  /** The MCP client name sent in the handshake. Defaults to `browxai-sdk`. */
  readonly clientName?: string;
  /** Give up on the handshake after this many milliseconds. Defaults to the MCP
   *  SDK's own limit. */
  readonly handshakeTimeoutMs?: number;
}

/**
 * Connect to a running daemon at a socket path (or a Windows pipe name) and finish
 * the MCP handshake. The SDK transport below and `browxai call` / `browxai tools`
 * both open their connection here, so there is one client. The caller owns the
 * returned client and closes it.
 */
export async function connectSocketClient(
  path: string,
  opts: ConnectOptions = {},
): Promise<Client> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection({ path }, () => resolve(s));
    s.once("error", (err) => reject(err));
  });
  const transport = new SocketTransport(socket);
  const client = new Client(
    { name: opts.clientName ?? `${NAME}-sdk`, version: VERSION },
    { capabilities: {} },
  );
  try {
    await client.connect(
      transport,
      opts.handshakeTimeoutMs === undefined ? undefined : { timeout: opts.handshakeTimeoutMs },
    );
  } catch (err) {
    socket.destroy();
    throw err;
  }
  return client;
}

export async function openSocketTransport(opts: SocketTransportOptions): Promise<SdkTransport> {
  const client = await connectSocketClient(resolveEndpointPath(opts.endpoint));
  let closed = false;

  const dispatch = async (toolName: string, args: Record<string, unknown>): Promise<unknown> => {
    if (closed)
      throw new Error(
        `browxai-sdk: cannot call ${toolName}, the transport is closed. Create a new client.`,
      );
    const res = await client.callTool({ name: toolName, arguments: args });
    const content = (res.content as BrowxaiContentItem[]) ?? [];
    return unwrapResult(content);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => undefined);
  };

  return { dispatch, close };
}

// RFC 0004 P4 / D6 — self-register under the "socket" mode. The factory carries
// the endpoint guard the old `case "socket"` arm enforced inline: a socket
// transport REQUIRES `opts.endpoint`, and the structured error message is
// byte-identical to the prior switch arm.
registerTransport("socket", {
  open: (opts) => {
    if (!opts.endpoint) {
      throw new Error(
        `browxai-sdk: transport "socket" requires an \`endpoint\`. ` +
          `Set { endpoint: "unix:///path/to/sock" } (or pipe://./pipe/<name> on Windows).`,
      );
    }
    return openSocketTransport({ endpoint: opts.endpoint });
  },
});
