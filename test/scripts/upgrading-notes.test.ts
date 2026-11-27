// `pnpm build` writes dist/upgrading.json with this script, since the npm
// tarball has no CHANGELOG. Each case plants a CHANGELOG.md in a throwaway tree.
// The fixture's output is compared with a golden file, and the real CHANGELOG
// is checked against what the script writes for it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTrees, makeTree, REPO, runNode, SPAWN_TEST_TIMEOUT } from "./_guard-tree.js";

afterEach(cleanTrees);

const SCRIPT = "scripts/upgrading-notes.mjs";
const GOLDEN = join(REPO, "test", "scripts", "fixtures", "upgrading-notes.golden.json");

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "**Upgrading from 0.24.0.** Not released yet, so not in the file.",
  "",
  "## [0.24.0] - 2026-12-01",
  "",
  "**Upgrading from 0.23.0.** Set `BROWX_X=1` to keep the old default. A script",
  "that reads the old shape drops one `.data`:",
  "",
  "```ts",
  "res.data.data.title; // 0.23.0",
  "res.data.title; // 0.24.0",
  "```",
  "",
  "**Upgrading: sessions open their own tab.** Set `BROWX_Y=1` to claim one.",
  "",
  "### Changed",
  "",
  "- **Behavior change: one.** It changed. **Upgrading.** Add `eval` to `BROWX_CAPABILITIES`.",
  "- **Behavior change: two.** It changed too, over",
  "  two lines. Upgrading: if you rely on it, set `all`.",
  "- **A fix with no note.** Nothing for the reader.",
  "",
  "## [0.23.0] - 2026-11-30",
  "",
  "**Upgrading from 0.22.0.** Nothing to do.",
  "",
  "### Fixed",
  "",
  "- a fix",
  "",
  "## [0.22.0] - 2026-11-29",
  "",
  "**Upgrading from 0.21.0.** Nothing to do. One docs fix.",
  "",
  "- **Changed: a default.** **Upgrading.** Move the file into `extensions/`.",
  "",
  "## [0.21.0] - 2026-11-28",
  "",
  "### Added",
  "",
  "- a feature",
  "",
].join("\n");

describe("upgrading-notes", { timeout: SPAWN_TEST_TIMEOUT }, () => {
  it("writes the golden file for the fixture CHANGELOG", () => {
    const root = makeTree({ "CHANGELOG.md": CHANGELOG });
    const r = runNode(root, SCRIPT, [join(root, "CHANGELOG.md"), join(root, "out.json")]);
    expect(r).toEqual({ code: 0, out: "" });
    expect(readFileSync(join(root, "out.json"), "utf8")).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("writes dist/upgrading.json from CHANGELOG.md by default", () => {
    const root = makeTree({ "CHANGELOG.md": CHANGELOG });
    expect(runNode(root, SCRIPT).code).toBe(0);
    const doc = JSON.parse(readFileSync(join(root, "dist", "upgrading.json"), "utf8")) as {
      schemaVersion: number;
      notes: Record<string, string>;
    };
    expect(doc.schemaVersion).toBe(1);
    expect(Object.keys(doc.notes)).toEqual(["0.24.0", "0.22.0"]);
  });

  it("matches the real CHANGELOG", () => {
    const changelog = readFileSync(join(REPO, "CHANGELOG.md"), "utf8");
    const root = makeTree({ "CHANGELOG.md": changelog });
    expect(runNode(root, SCRIPT).code).toBe(0);
    const { notes } = JSON.parse(readFileSync(join(root, "dist", "upgrading.json"), "utf8")) as {
      notes: Record<string, string>;
    };
    const sections = changelog.split(/^## /m).slice(1);
    const released = new Map<string, string>();
    for (const s of sections) {
      const m = /^\[([^\]]+)\]/.exec(s);
      if (m) released.set(m[1]!, s);
    }
    for (const v of Object.keys(notes)) expect(released.has(v), v).toBe(true);
    let checked = 0;
    for (const [v, body] of released) {
      for (const para of body.split(/\n\s*\n/)) {
        const text = para.trim();
        if (!text.startsWith("**Upgrading")) continue;
        checked++;
        const rest = text.replace(/^\*\*Upgrading[^*]*\*\*\s*/, "");
        if (rest.startsWith("Nothing to do.")) {
          expect(notes[v] ?? "", v).not.toContain(text);
        } else {
          expect(notes[v], v).toBeDefined();
          expect(notes[v]!.startsWith(text) || notes[v]!.includes(`\n\n${text}`), v).toBe(true);
        }
      }
      for (const m of body.matchAll(/\*\*Upgrading\.\*\* ([^\n]+)/g)) {
        checked++;
        expect(notes[v], v).toContain(m[1]!.trim());
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
