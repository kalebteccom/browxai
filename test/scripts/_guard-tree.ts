// Shared harness for the guard-script tests. The guards locate their root from
// their own file path, so each test builds a throwaway tree, copies the real
// scripts into it at the same relative paths, and spawns them there. The repo
// itself is never scanned.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");

const roots: string[] = [];

/** Remove every tree made since the last call. Wire to afterEach. */
export function cleanTrees(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A fresh temp tree holding `files` (relative path to content) and copies of
 *  `scripts` (repo-relative paths, copied to the same path in the tree). */
export function makeTree(files: Record<string, string>, scripts: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "browxai-guard-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const path of scripts) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO, path), join(root, path));
  }
  return root;
}

export interface Ran {
  code: number | null;
  out: string;
}

/** Run a script inside `root` (path relative to it) and return exit code and output. */
export function runNode(root: string, script: string, args: string[] = []): Ran {
  const r = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
