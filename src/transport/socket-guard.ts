// The check every client makes on a daemon's Unix socket before it connects, and the
// one function that opens the connection after it. `browxai call`, `browxai tools`, the
// SDK's socket transport and `browxai bridge` all connect here.
//
// The daemon creates its socket owned by the user who started it, at mode 0600
// (`listenPrivate` in src/cli/serve-socket.ts). A client sends tool arguments, which
// can hold a password or a session cookie, to whatever answers at the path it was
// given. So before connecting it confirms the path is what a daemon of this user
// would have made: a socket, not a symbolic link, owned by this user, and closed to
// group and others. Only the last path component is checked. The directory that
// holds it is the caller's choice.
//
// A Windows named pipe has no file mode and no owner to read, so the check is
// skipped for a pipe path and on Windows.

import { lstatSync, type Stats } from "node:fs";
import { createConnection, type Socket } from "node:net";

/** A Windows named pipe (`\\.\pipe\name`, or `//./pipe/name`). It has no file
 *  mode and no file on disk. */
export function isPipePath(path: string): boolean {
  return /^(\\\\|\/\/)[.?][\\/]pipe[\\/]/i.test(path);
}

/** The socket at the path is not one this user's daemon made. The message is meant
 *  to be printed as is. */
export class SocketGuardError extends Error {}

/** Mode bits that let the group or others reach the socket. */
const GROUP_AND_OTHER_BITS = 0o077;

/** What the guard reads. A test passes its own. */
export interface SocketGuardDeps {
  readonly lstat: (path: string) => Stats;
  /** The current user id, or undefined where the platform has none (Windows). */
  readonly uid: () => number | undefined;
  readonly platform: NodeJS.Platform;
}

const realDeps: SocketGuardDeps = {
  lstat: (path) => lstatSync(path),
  uid: () => process.getuid?.(),
  platform: process.platform,
};

/** Why the path fails the check, or undefined when it passes. */
function refusal(path: string, stat: Stats, uid: number): string | undefined {
  if (stat.isSymbolicLink()) {
    return `${path} is a symbolic link. Pass the path of the socket itself.`;
  }
  if (!stat.isSocket()) return `${path} is not a socket.`;
  if (stat.uid !== uid) {
    return `${path} is owned by another user (uid ${stat.uid}), and this is uid ${uid}.`;
  }
  if ((stat.mode & GROUP_AND_OTHER_BITS) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
    return `${path} has mode ${mode}, which lets other users reach it. A browxai daemon creates its socket at mode 600.`;
  }
  return undefined;
}

/**
 * Throw {@link SocketGuardError} unless `path` is a Unix socket owned by the current
 * user and closed to group and others. A path with nothing at it throws the `lstat`
 * error as is (`ENOENT`), so a caller can tell a missing daemon from a refused one.
 * A pipe path, and any path on Windows, passes unchecked.
 */
export function assertOwnSocket(path: string, deps: SocketGuardDeps = realDeps): void {
  if (deps.platform === "win32" || isPipePath(path)) return;
  const uid = deps.uid();
  if (uid === undefined) return;
  const why = refusal(path, deps.lstat(path), uid);
  if (why !== undefined) throw new SocketGuardError(`refusing to connect: ${why}`);
}

/** Check the socket at `path` with {@link assertOwnSocket}, then connect to it. */
export function connectOwnSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    try {
      assertOwnSocket(path);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const socket = createConnection({ path }, () => resolve(socket));
    socket.once("error", reject);
  });
}
