// The release workflow takes the GitHub Release body from this script. Each case
// plants a CHANGELOG.md in a throwaway tree and checks the printed section and
// the exit code.

import { afterEach, describe, expect, it } from "vitest";
import { cleanTrees, makeTree, runNode, SPAWN_TEST_TIMEOUT } from "./_guard-tree.js";

afterEach(cleanTrees);

const SCRIPT = "scripts/changelog-section.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "- pending",
  "",
  "## [0.22.0] - 2026-11-27",
  "",
  "**Upgrading from 0.21.0.** Nothing to do.",
  "",
  "### Fixed",
  "",
  "- one fix",
  "",
  "## [0.21.0] - 2026-11-26",
  "",
  "- older",
  "",
  "## [0.20.0] - 2026-11-20",
  "",
].join("\n");

describe("changelog-section", { timeout: SPAWN_TEST_TIMEOUT }, () => {
  it("prints the section of a tag, without the heading or the next section", () => {
    const root = makeTree({ "CHANGELOG.md": CHANGELOG });
    const r = runNode(root, SCRIPT, ["v0.22.0"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("**Upgrading from 0.21.0.** Nothing to do.\n\n### Fixed\n\n- one fix\n");
  });

  it("takes a bare version", () => {
    const root = makeTree({ "CHANGELOG.md": CHANGELOG });
    expect(runNode(root, SCRIPT, ["0.21.0"]).out).toBe("- older\n");
  });

  it("fails on a version with no section", () => {
    const root = makeTree({ "CHANGELOG.md": CHANGELOG });
    const r = runNode(root, SCRIPT, ["v9.9.9"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("no CHANGELOG section for 9.9.9");
  });

  it("fails on an empty section", () => {
    const root = makeTree({ "CHANGELOG.md": CHANGELOG });
    expect(runNode(root, SCRIPT, ["0.20.0"]).code).toBe(1);
  });
});
