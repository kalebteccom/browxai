// Paths a plugin's package.json names (`browxai.register`, `main`, `files`)
// resolve inside the package directory. The runtime imports the entry from
// there and the lock's `contentSha256` hashes those files, so the pin covers
// what actually loads. Containment is checked on the real path: a symlink in
// the package that leads out of it counts as outside.
//
// Leaf module: node stdlib only.

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Why `rel` does not stay inside `pkgRoot`, or null when it does. A path that
 * does not exist yet is checked lexically only and returns null when it stays
 * inside; the caller reports the missing file.
 */
export function packagePathProblem(pkgRoot: string, rel: string): string | null {
  if (isAbsolute(rel)) return "is an absolute path; it must be relative to the package directory";
  const lexical = resolve(pkgRoot, rel);
  if (!isInside(resolve(pkgRoot), lexical)) return "points outside the package directory";
  let rootReal: string;
  let targetReal: string;
  try {
    rootReal = realpathSync(pkgRoot);
  } catch {
    return "the package directory cannot be read";
  }
  try {
    targetReal = realpathSync(lexical);
  } catch {
    return null;
  }
  if (!isInside(rootReal, targetReal))
    return "resolves through a link to a path outside the package directory";
  return null;
}
