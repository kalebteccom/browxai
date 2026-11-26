// Opens the connection `browxai call` and `browxai tools` make to a running
// `browxai serve --socket` daemon. The connection and the MCP handshake are the SDK's
// own (`connectSocketClient`), so the route has no client of its own. A failure is
// turned into one plain sentence that says what to do.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectSocketClient, resolveEndpointPath } from "../sdk/transport-socket.js";
import { SocketGuardError } from "../transport/socket-guard.js";

/** The daemon could not be reached. The message is meant to be printed as is. */
export class DaemonUnreachableError extends Error {}

/** How long the handshake may take before the daemon counts as unreachable. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** A socket path as given: a plain path or pipe name, or the SDK's `unix://` and
 *  `pipe://` endpoint form. */
export function socketPathOf(value: string): string {
  return /^(unix|pipe):\/\//.test(value) ? resolveEndpointPath(value) : value;
}

/** What a command prints when it was given no socket path. */
export const NO_SOCKET =
  "no socket path. Pass --socket PATH or set BROWX_SOCKET to the path the daemon listens on. " +
  "browxai never looks for one: start the daemon with `browxai serve --socket PATH`.";

/** Connect to the daemon at `socket`, or throw {@link DaemonUnreachableError}. */
export async function connectDaemon(socket: string | undefined): Promise<Client> {
  if (socket === undefined) throw new DaemonUnreachableError(NO_SOCKET);
  let path: string;
  try {
    path = socketPathOf(socket);
  } catch (err) {
    throw new DaemonUnreachableError(err instanceof Error ? err.message : String(err));
  }
  try {
    return await connectSocketClient(path, {
      clientName: "browxai-cli",
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    });
  } catch (err) {
    if (err instanceof SocketGuardError) throw new DaemonUnreachableError(err.message);
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      throw new DaemonUnreachableError(
        `nothing at ${path}. Start the daemon with \`browxai serve --socket ${path}\`.`,
      );
    }
    if (code === "ECONNREFUSED") {
      throw new DaemonUnreachableError(
        `nothing is listening on ${path} (connection refused). The socket file may be left over from a daemon that stopped.`,
      );
    }
    const why = err instanceof Error ? err.message : String(err);
    throw new DaemonUnreachableError(`could not connect to ${path}: ${why}`);
  }
}
