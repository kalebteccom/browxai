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
import { SocketTransport } from "./socket-transport.js";
import { parseEnvelope, type SdkTransport } from "./transport.js";
import type { BrowxaiContentItem, BrowxaiResult } from "./types.js";

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
      `Supported: unix:///path/to/sock, pipe://./pipe/name. Other schemes are rejected so a typo fails loudly.`,
  );
}

export interface SocketTransportOptions {
  /** SDK-public endpoint URL — see resolveEndpointPath above. */
  readonly endpoint: string;
}

export async function openSocketTransport(opts: SocketTransportOptions): Promise<SdkTransport> {
  const path = resolveEndpointPath(opts.endpoint);
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = createConnection({ path }, () => resolve(s));
    s.once("error", (err) => reject(err));
  });
  const transport = new SocketTransport(socket);
  const client = new Client(
    { name: `${NAME}-sdk`, version: VERSION },
    { capabilities: {} },
  );
  await client.connect(transport);
  let closed = false;

  const dispatch = async (toolName: string, args: Record<string, unknown>): Promise<BrowxaiResult> => {
    if (closed) throw new Error(`browxai-sdk: dispatch on a closed transport (tool=${toolName})`);
    const res = await client.callTool({ name: toolName, arguments: args });
    const content = (res.content as BrowxaiContentItem[]) ?? [];
    return parseEnvelope(content);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => undefined);
  };

  return { dispatch, close };
}
