// `browxai call --out FILE`: write the first image of a result to a file the caller
// named. The write is the caller's own action in a path the caller chose. It does not go
// through the server's workspace-rooted file writer, so it adds no file access on the
// server and needs no `file-io` capability. A file that exists is left alone unless
// `--force` is given, and a new file is created owner-only because a screenshot can
// show anything the page shows.

import { lstatSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** What is at the path, a dangling symlink included, or undefined when nothing is. */
function entryAt(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** A problem with the `--out` path that can be found before the tool runs, or
 *  undefined. Checking first means a refused path costs no browser action. */
export function checkOutPath(path: string, force: boolean): string | undefined {
  const parent = dirname(resolve(path));
  const parentEntry = (() => {
    try {
      return statSync(parent);
    } catch {
      return undefined;
    }
  })();
  if (parentEntry === undefined) return `the directory for --out ${path} does not exist`;
  if (!parentEntry.isDirectory()) return `the parent of --out ${path} is not a directory`;
  const entry = entryAt(path);
  if (entry?.isDirectory()) return `${path} is a directory`;
  if (!force && entry !== undefined) {
    return `${path} already exists. Pass --force to overwrite it, or name another file.`;
  }
  return undefined;
}

/** Write base64 image data to the path. Returns a problem, or undefined on success.
 *  With `force` an existing entry is removed first: a symlink is unlinked, so the write
 *  never follows it, and the new file is created with mode 0600 whatever the old one
 *  had. A directory is never removed. Without `force` the write fails if the file
 *  appeared since {@link checkOutPath}. */
export function writeImage(path: string, base64: string, force: boolean): string | undefined {
  try {
    if (force) {
      const entry = entryAt(path);
      if (entry?.isDirectory()) return `${path} is a directory`;
      if (entry !== undefined) unlinkSync(path);
    }
    writeFileSync(path, Buffer.from(base64, "base64"), { flag: "wx", mode: 0o600 });
    return undefined;
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "EEXIST") {
      return force
        ? `${path} appeared while it was being replaced. Run the command again.`
        : `${path} already exists. Pass --force to overwrite it, or name another file.`;
    }
    return `could not write ${path}${code === undefined ? "" : ` (${code})`}`;
  }
}
