// BROWX_WORKSPACE resolution + subpath helpers. The no-trace contract lives
// or dies here: every write path browxai produces is rooted at this dir,
// never at cwd. Resolved once at startup.

import { homedir } from "node:os";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { log } from "./logging.js";

const DEFAULT_WORKSPACE = join(homedir(), ".browxai");

export interface Workspace {
  /** Absolute path to the workspace root. */
  readonly root: string;
  /** Subdir helper — `workspace.sub("profile")` → `<root>/profile`, created if missing. */
  sub(name: string): string;
  /** The default session's persistent profile directory: `BROWX_DEFAULT_PROFILE`
   *  when set (validated, created 0700), else `<root>/profile`. */
  defaultProfile(): string;
}

export function resolveWorkspace(env: NodeJS.ProcessEnv = process.env): Workspace {
  const raw = env.BROWX_WORKSPACE?.trim();
  const root = raw ? resolve(raw.replace(/^~(?=$|\/)/, homedir())) : DEFAULT_WORKSPACE;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const sub = (name: string): string => {
    const p = join(root, name);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
    return p;
  };
  return {
    root,
    sub,
    defaultProfile: () => resolveDefaultProfileDir(env) ?? sub("profile"),
  };
}

/**
 * `BROWX_DEFAULT_PROFILE=<dir>`: the persistent profile directory the default
 * session launches on, for an embedder that keeps browser profiles outside the
 * workspace. Operator-set, like `BROWX_WORKSPACE`, so it may sit anywhere; the
 * checks stop a typo or a planted link from pointing a browser profile, which
 * holds cookies and saved logins, somewhere unintended.
 *
 * Refuses a relative path, the filesystem root, the home directory itself, a
 * symlink, a non-directory, and a directory owned by another user. Creates a
 * missing directory with mode 0700. Warns (does not refuse) when an existing
 * directory is readable by group or others. Returns undefined when unset.
 */
export function resolveDefaultProfileDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.BROWX_DEFAULT_PROFILE?.trim();
  if (!raw) return undefined;
  const fail = (why: string): never => {
    throw new Error(`BROWX_DEFAULT_PROFILE: ${why} (got "${raw}")`);
  };
  if (raw.includes("\0")) fail("contains a NUL byte");
  const expanded = raw.replace(/^~(?=$|\/)/, homedir());
  if (!isAbsolute(expanded)) fail("must be an absolute path or start with ~/");
  const dir = resolve(expanded);
  if (dir === parse(dir).root) fail("refuses the filesystem root");
  if (dir === resolve(homedir())) fail("refuses the home directory itself; name a subdirectory");
  if (existsSync(dir) || isDanglingLink(dir)) {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) fail("is a symlink; point it at the real directory");
    if (!st.isDirectory()) fail("exists and is not a directory");
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      fail("is owned by another user");
    if ((st.mode & 0o077) !== 0) {
      log.warn(
        `BROWX_DEFAULT_PROFILE ${dir} is accessible to group or others ` +
          `(mode ${(st.mode & 0o777).toString(8)}); a browser profile holds cookies and saved logins, chmod 700 it`,
      );
    }
    return dir;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function isDanglingLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---- workspace path / name validators -------------------------------------
//
// The path-under-root chokepoint. Kept here, beside the root resolver, so the
// whole no-trace contract lives in one leaf module that the rest of the tree
// (including `src/util/*`) can depend on inward — no util-to-session edge.

/** Names for named-states + similar file-naming use. No path separators,
 *  no leading dots, no `..`. Same posture as `profile-snapshot.ts`. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** True when `name` is a safe single path segment (no separators, no `..`,
 *  no leading-dot specials). The non-throwing sibling of `assertSafeName`,
 *  for filtering directory listings. */
export function isSafeName(name: string): boolean {
  return Boolean(name) && SAFE_NAME.test(name) && name !== "." && name !== "..";
}

export function assertSafeName(kind: string, name: string): void {
  if (!isSafeName(name)) {
    throw new Error(
      `${kind} "${name}" invalid — use only letters, digits, '.', '_', '-' ` +
        `(no path separators, no "..")`,
    );
  }
}

/** Resolve a workspace-rooted path. Rejects any path that escapes the root
 *  (`..` segments, absolute paths pointing outside, etc.). Mirrors the
 *  `upload_file` contract. */
export function resolveWorkspacePath(workspaceRoot: string, p: string, tool: string): string {
  const resolved = resolve(workspaceRoot, p);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(
      `${tool}: \`path\` must resolve inside $BROWX_WORKSPACE — got "${p}". ` +
        `Use a workspace-relative path (or call \`auth_save\` for the named-state path).`,
    );
  }
  return resolved;
}

// ---- protected workspace paths -------------------------------------------
//
// Some files under the workspace are the operator's, not the agent's: the
// config store, the plugin declaration and install tree, and the browser
// profiles. A tool that writes an agent-chosen path (`pdf_save`, `dom_export`,
// `asset_export`, a heap snapshot, …) must never land on one. Overwriting
// `config.json` would reset the operator's saved narrowing, and writing
// `plugins.json` would declare code to load at the next start.

const PROTECTED_FILES = ["config.json", "plugins.json", "plugins-lock.json"];
const PROTECTED_DIRS = ["plugins", "profile", "profiles"];

/** `p` with its longest existing ancestor replaced by that ancestor's real
 *  path, so a symlink inside the workspace cannot route around the check. */
function realish(p: string): string {
  let head = p;
  const tail: string[] = [];
  // cap: one step per path segment; `dirname` reaches the root and returns.
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return p;
    tail.unshift(basename(head));
    head = parent;
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return p;
  }
}

/** Throws when `abs` is, or is inside, a protected operator path. Compares
 *  case-insensitively, because the default macOS filesystem is. */
export function assertWritableWorkspacePath(
  workspaceRoot: string,
  abs: string,
  tool: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const rootReal = realish(resolve(workspaceRoot)).toLowerCase();
  const target = realish(resolve(abs)).toLowerCase();
  const under = (dir: string) => target === dir || target.startsWith(dir + sep);
  const refuse = (what: string): never => {
    throw new Error(
      `${tool}: refusing to write "${abs}" — it is ${what}, which only the operator changes. ` +
        "Pick another workspace path.",
    );
  };
  for (const f of PROTECTED_FILES) if (target === join(rootReal, f)) refuse(`the workspace ${f}`);
  for (const d of PROTECTED_DIRS) if (under(join(rootReal, d))) refuse(`under the workspace ${d}/`);
  const dp = env.BROWX_DEFAULT_PROFILE?.trim();
  if (dp) {
    const expanded = dp.replace(/^~(?=$|\/)/, homedir());
    if (isAbsolute(expanded) && under(realish(resolve(expanded)).toLowerCase()))
      refuse("under BROWX_DEFAULT_PROFILE");
  }
}

/** `resolveWorkspacePath` for a path the caller is about to WRITE. */
export function resolveWorkspaceWritePath(workspaceRoot: string, p: string, tool: string): string {
  const resolved = resolveWorkspacePath(workspaceRoot, p, tool);
  assertWritableWorkspacePath(workspaceRoot, resolved, tool);
  return resolved;
}
