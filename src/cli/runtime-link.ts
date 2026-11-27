// `browxai runtime install --link`: a symlink to the launcher at
// `~/.local/bin/browxai`, so a shell runs the runtime's browxai by name (D17). The
// launcher follows a symlinked `$0` to find its runtime. It never replaces a file
// there that isn't a link to this launcher, and it prints each step it takes.
// `runtime uninstall` removes the link only when it still points at this launcher.

import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import type { RuntimePaths } from "./runtime-layout.js";

export interface LinkContext {
  home: string;
  env: NodeJS.ProcessEnv;
}

interface LinkIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** The user bin directory the link goes in. */
export function linkDir(home: string): string {
  return join(home, ".local", "bin");
}

export function linkPath(home: string): string {
  return join(linkDir(home), "browxai");
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** What sits at `path`: nothing, a link (and where it resolves), or another file. */
function inspect(
  path: string,
): { kind: "none" } | { kind: "link"; target: string } | { kind: "other" } {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw e;
  }
  if (!st.isSymbolicLink()) return { kind: "other" };
  return { kind: "link", target: resolve(dirname(path), readlinkSync(path)) };
}

/** Whether a link target names this runtime's launcher. */
function isOurs(target: string, paths: RuntimePaths): boolean {
  return target === paths.shim || real(target) === real(paths.shim);
}

/** Link `~/.local/bin/browxai` to the launcher. Returns false when it left an
 *  existing file alone. */
export function linkLauncher(paths: RuntimePaths, ctx: LinkContext, io: LinkIo): boolean {
  const dir = linkDir(ctx.home);
  const link = linkPath(ctx.home);
  const found = inspect(link);
  if (found.kind === "link" && isOurs(found.target, paths)) {
    io.out(`✓ ${link} already links to ${paths.shim}\n`);
  } else if (found.kind === "none") {
    try {
      if (inspect(dir).kind === "none") {
        mkdirSync(dir, { recursive: true, mode: 0o755 });
        io.out(`✓ created ${dir}\n`);
      }
      symlinkSync(paths.shim, link);
    } catch (e) {
      io.err(
        `warning: no link was made at ${link} (${(e as NodeJS.ErrnoException).code ?? "error"}). ` +
          `Call ${paths.shim} by its full path.\n`,
      );
      return false;
    }
    io.out(`✓ linked ${link} to ${paths.shim}\n`);
  } else {
    const what = found.kind === "link" ? `a link to ${found.target}` : "not a link";
    io.err(
      `warning: ${link} exists and is ${what}, so it was left alone and no link was made. ` +
        `Remove it and run install --link again, or call ${paths.shim} by its full path.\n`,
    );
    return false;
  }
  pathNotes(paths, ctx, dir, io);
  return true;
}

/** Say when the link directory is not on PATH, or another browxai comes first. */
function pathNotes(paths: RuntimePaths, ctx: LinkContext, dir: string, io: LinkIo): void {
  const entries = (ctx.env.PATH ?? "").split(delimiter).filter(Boolean);
  const at = entries.findIndex((e) => real(e) === real(dir));
  if (at < 0) io.out(`  ${dir} is not on PATH. Add it to PATH to run browxai by name.\n`);
  const before = at < 0 ? entries : entries.slice(0, at);
  for (const entry of before) {
    const candidate = join(entry, "browxai");
    if (!executable(candidate) || real(candidate) === real(paths.shim)) continue;
    io.err(
      `warning: ${candidate} comes earlier on PATH, so a shell runs it. ` +
        "Client entries name the launcher by its full path and are not affected.\n",
    );
    return;
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return lstatSync(path).isSymbolicLink() || lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** Remove `~/.local/bin/browxai` when it links to this launcher. Leaves any other
 *  file there alone. Returns the path removed, or undefined. */
export function unlinkLauncher(paths: RuntimePaths, home: string): string | undefined {
  const link = linkPath(home);
  const found = inspect(link);
  if (found.kind !== "link" || !isOurs(found.target, paths)) return undefined;
  rmSync(link, { force: true });
  return link;
}
