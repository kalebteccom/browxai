// `browxai call --out FILE`: write the first image of a result to a file the caller
// named. The write is the caller's own action in a path the caller chose. It does not go
// through the server's workspace-rooted file writer, so it adds no file access on the
// server and needs no `file-io` capability. A file that exists is left alone unless
// `--force` is given, and a new file is created owner-only because a screenshot can
// show anything the page shows.

import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** True when something is at the path, a dangling symlink included. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** A problem with the `--out` path that can be found before the tool runs, or
 *  undefined. Checking first means a refused path costs no browser action. */
export function checkOutPath(path: string, force: boolean): string | undefined {
  if (!existsSync(dirname(resolve(path)))) {
    return `the directory for --out ${path} does not exist`;
  }
  if (!force && occupied(path)) {
    return `${path} already exists. Pass --force to overwrite it, or name another file.`;
  }
  return undefined;
}

/** Write base64 image data to the path. Returns a problem, or undefined on success.
 *  Without `force` the write fails if the file appeared since {@link checkOutPath}. */
export function writeImage(path: string, base64: string, force: boolean): string | undefined {
  try {
    writeFileSync(path, Buffer.from(base64, "base64"), { flag: force ? "w" : "wx", mode: 0o600 });
    return undefined;
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    return code === "EEXIST"
      ? `${path} already exists. Pass --force to overwrite it, or name another file.`
      : `could not write ${path}${code === undefined ? "" : ` (${code})`}`;
  }
}
