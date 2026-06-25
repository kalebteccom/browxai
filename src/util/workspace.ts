// BROWX_WORKSPACE resolution + subpath helpers. The no-trace contract lives
// or dies here: every write path browxai produces is rooted at this dir,
// never at cwd. Resolved once at startup.

import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const DEFAULT_WORKSPACE = join(homedir(), ".browxai");

export interface Workspace {
  /** Absolute path to the workspace root. */
  readonly root: string;
  /** Subdir helper — `workspace.sub("profile")` → `<root>/profile`, created if missing. */
  sub(name: string): string;
}

export function resolveWorkspace(env: NodeJS.ProcessEnv = process.env): Workspace {
  const raw = env.BROWX_WORKSPACE?.trim();
  const root = raw ? resolve(raw.replace(/^~(?=$|\/)/, homedir())) : DEFAULT_WORKSPACE;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return {
    root,
    sub(name) {
      const p = join(root, name);
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
      return p;
    },
  };
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
