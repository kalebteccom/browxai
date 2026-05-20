// BROWX_WORKSPACE resolution + subpath helpers. The no-trace contract lives
// or dies here: every write path browxai produces is rooted at this dir,
// never at cwd. Resolved once at startup.

import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

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
