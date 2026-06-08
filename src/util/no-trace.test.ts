// No-trace contract — static guard. Catches accidental cwd-relative writes.
//
// The contract: every path the browxai server writes to roots at $BROWX_WORKSPACE,
// never `cwd`. Enforced in code (`resolveWorkspace()` in util/workspace.ts), checked
// at runtime (the operator can see `workspace=…` on startup), and now also checked
// statically here so a refactor that accidentally re-introduces a cwd-relative
// `writeFileSync(path)` fails CI.
//
// We grep the source tree for:
//   - `process.cwd()` references — only allowed in the CLI subcommands (init/chrome
//     consume an explicit `workspace` arg from the user; doctor reads env).
//   - filesystem mutation calls (`writeFile`, `mkdir`, `appendFile`) — verifies each
//     call site is rooted at a workspace path (heuristic: previous-line / nearby
//     mention of `BROWX_WORKSPACE`, `workspace.`, `pidFile`, `mcpPath`, `browxDir`,
//     `profileDir`, `runsDir`, `path.join`).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...tsFilesUnder(full));
    else if (st.isFile() && /\.ts$/.test(e) && !/\.test\.ts$/.test(e)) out.push(full);
  }
  return out;
}

describe("no-trace contract — static source guard", () => {
  it("no src/ file calls process.cwd() outside CLI subcommands", () => {
    const files = tsFilesUnder(SRC);
    const offenders: string[] = [];
    for (const f of files) {
      if (f.includes("/cli/")) continue; // CLI subcommands legitimately consume cwd / user args
      const text = readFileSync(f, "utf8");
      if (text.includes("process.cwd()")) offenders.push(f.slice(SRC.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it("filesystem mutation calls in src/ root at workspace-derived paths", () => {
    // Heuristic: scan each `writeFileSync(...)` / `appendFileSync(...)` / `mkdirSync(...)`
    // line; verify the path arg references a workspace-derived name (the resolver,
    // a known subdir, a `path.join` rooted at one of those). False positives are
    // allowed (test-only mock writes); false negatives are the failure mode.
    const SAFE_TOKENS = [
      "workspace.", "BROWX_WORKSPACE", "browxDir", "profileDir", "runsDir",
      "pidFile", "mcpPath", "ws.sub", "ws.root", "tmp", "/tmp",
      "tmpdir", "join(root", "root,",
      // Operator-supplied path via a CLI flag (same trust posture as `pidFile`):
      // `browxai serve --socket <p>` consumes a path the operator hands in. The
      // path lives in `socketPath`; cleanup/listen-prep mutations against it
      // are workspace-equivalent (the operator's chosen target).
      "socketPath", "opts.socketPath",
      // Phase 8 — plugin CLI subcommands write to paths derived from
      // `pluginPaths(workspaceRoot)` (see src/plugin/resolver.ts). Every
      // `paths.root` / `paths.installDir` / `paths.declarationFile` /
      // `paths.lockFile` / `paths.nodeModulesDir` is workspace-rooted
      // by construction — `paths.` is a workspace-derived prefix in the
      // same sense as `workspace.`.
      "paths.", "pluginPaths",
    ];
    // util/workspace.ts is the resolver itself — its `mkdirSync(p, ...)` calls are
    // BY DEFINITION rooted at the workspace `root`. util/config-store.ts writes
    // `<workspace>/config.json` (constructor takes the workspace root; the path
    // is `join(workspaceRoot, CONFIG_FILE)` — never cwd). Both explicitly
    // allowlisted as workspace-rooted by construction.
    const ALLOWED_FILES = new Set(["util/workspace.ts", "util/config-store.ts"]);
    const files = tsFilesUnder(SRC);
    const offenders: Array<{ file: string; line: string }> = [];
    for (const f of files) {
      const rel = f.slice(SRC.length + 1);
      if (ALLOWED_FILES.has(rel)) continue;
      const text = readFileSync(f, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!/\b(writeFileSync|appendFileSync|mkdirSync|writeFile\b|appendFile\b|mkdir\b|unlinkSync\b)\(/.test(line)) continue;
        // Look at this line and the previous 4 (the path is often built one line up).
        const ctx = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
        const safe = SAFE_TOKENS.some((t) => ctx.includes(t));
        if (!safe) offenders.push({ file: rel, line: line.trim() });
      }
    }
    expect(offenders).toEqual([]);
  });
});
