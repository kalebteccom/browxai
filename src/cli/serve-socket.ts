// Socket-path handling for `browxai serve`: where the socket lives, what may be
// removed before listening, and the permissions it is created with.

import { lstatSync, unlinkSync, type Stats } from "node:fs";
import type { Server } from "node:net";
import { resolve } from "node:path";

/** Thrown when the requested socket path cannot be used. The message is meant to
 *  be printed as is. */
export class SocketPathError extends Error {}

/** A Windows named pipe (`\\.\pipe\name`, or `//./pipe/name`). It has no file
 *  mode and no file on disk, so none of the file handling below applies. */
export function isPipePath(path: string): boolean {
  return /^(\\\\|\/\/)[.?][\\/]pipe[\\/]/i.test(path);
}

/** The path the socket is created at: absolute, so the chmod and the cleanup
 *  address the same file the listener made whatever the working directory. */
export function resolveSocketPath(path: string): string {
  return isPipePath(path) ? path : resolve(path);
}

/** Remove a leftover socket from an earlier run, so `listen` does not fail with
 *  EADDRINUSE. Only a socket is removed: a regular file, a directory or a symlink
 *  at the path is left alone and the call throws `SocketPathError`. A path with
 *  nothing at it is fine. Returns whether something was removed. */
export function removeStaleSocket(path: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  if (!stat.isSocket()) {
    throw new SocketPathError(
      `browxai serve: ${path} already exists and is not a socket, so it was left alone. ` +
        "Pass a different --socket path, or remove it yourself.",
    );
  }
  unlinkSync(path);
  return true;
}

/** Listen on `path`, creating a Unix socket that only the owner can reach. The
 *  umask is tightened for the call that creates the socket, so the file never
 *  exists with a wider mode, then restored. A named pipe is listened on as is. */
export function listenPrivate(server: Server, path: string): Promise<void> {
  const posix = !isPipePath(path);
  const previousMask = posix ? process.umask(0o177) : undefined;
  let restored = false;
  const restoreMask = (): void => {
    if (previousMask === undefined || restored) return;
    restored = true;
    process.umask(previousMask);
  };
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", (err) => {
      restoreMask();
      rejectListen(err);
    });
    server.listen(path, () => {
      restoreMask();
      resolveListen();
    });
  });
}
