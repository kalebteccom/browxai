// `browxai runtime`: the launcher at `<runtime>/bin/browxai`. MCP client entries
// name this file, so it never changes between versions. It resolves `current` once
// with `cd -P` and `pwd -P` (POSIX, the same on macOS and Linux, where `readlink -f`
// is not), then execs node on that version's `cli.js`. The PID, standard input and
// output, signals and exit code are the server's. It reads one file and makes no
// network call. See docs/rfcs/0015-runtime-updates.md, section 2.
//
// `$0` can be a symlink to the launcher, such as a link in a bin directory on
// PATH. The launcher follows it with plain `readlink` (no `-f`, which older macOS
// lacks) before it finds the runtime, so a link anywhere still runs the runtime
// the launcher belongs to.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./runtime-store.js";
import type { RuntimePaths } from "./runtime-layout.js";

/** Every path is quoted or sits in an assignment, where the shell doesn't split
 *  it, and `--` guards `cd`, `dirname` and `cat` against a leading `-`. */
export const SHIM_TEXT = `#!/bin/sh
# browxai runtime launcher: runs the version \`current\` points at, resolved once.
# $0 may be a symlink to this file (a link in a bin directory on PATH): follow it,
# at most 40 links, so the runtime is the directory this file sits in.
self=$0
n=0
while [ -L "$self" ] && [ "$n" -lt 40 ]; do
  link=$(readlink -- "$self") || exit 127
  case $link in
    /*) self=$link ;;
    *) self=$(dirname -- "$self")/$link ;;
  esac
  n=$((n + 1))
done
rt=$(cd -P -- "$(dirname -- "$self")/.." && pwd -P) || exit 127
# Up to three tries: on APFS a lookup that races the switch of \`current\` can fail.
target=
for _ in 1 2 3; do
  target=$(cd -P -- "$rt/current" 2>/dev/null && pwd -P) && break
done
[ -n "$target" ] || {
  echo "browxai: no current version in $rt. Run: browxai runtime install" >&2
  exit 127
}
cli=$target/node_modules/browxai/dist/cli.js
[ -f "$cli" ] || {
  echo "browxai: $cli is missing. Run: $rt/bin/browxai runtime rollback" >&2
  exit 127
}
node=\${BROWX_RUNTIME_NODE:-}
[ -n "$node" ] || node=$(cat -- "$rt/node-path" 2>/dev/null)
[ -x "$node" ] || node=$(command -v node) || {
  echo "browxai: no node found. Set BROWX_RUNTIME_NODE." >&2
  exit 127
}
BROWX_RUNTIME_DIR=$rt BROWX_RUNTIME_VERSION=\${target##*/} exec "$node" "$cli" "$@"
`;

/** Write the launcher, mode 0755, unless it already has exactly this text. */
export function writeShim(paths: RuntimePaths): boolean {
  if (existsSync(paths.shim) && readFileSync(paths.shim, "utf8") === SHIM_TEXT) return false;
  writeFileAtomic(paths.shim, SHIM_TEXT, 0o755);
  return true;
}
