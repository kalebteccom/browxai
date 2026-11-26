// Proof that the playwright-core pin guard fails on a stale pin and passes on a
// current one. Each case builds a throwaway tree with a lockfile, plants pins in
// doc files and asserts the exit code and the file:line message.

import { afterEach, describe, expect, it } from "vitest";
import { cleanTrees, makeTree, runNode, SPAWN_TEST_TIMEOUT } from "./_guard-tree.js";

afterEach(cleanTrees);

const GUARD = "scripts/check-playwright-pin.mjs";

const lock = (version: string) =>
  [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      playwright-core:",
    "        specifier: ^1.64.1",
    `        version: ${version}`,
    "      rrweb:",
    "        specifier: 2.2.0",
    "        version: 2.2.0",
    "",
    "  packages/plugins/example:",
    "    dependencies:",
    "      playwright-core:",
    "        specifier: ^1.0.0",
    "        version: 1.0.0",
    "",
    "packages:",
    "",
  ].join("\n");

const cmd = (v: string) => `npx playwright-core@${v} install chromium\n`;

function run(files: Record<string, string>, version = "1.65.1") {
  return runNode(makeTree({ "pnpm-lock.yaml": lock(version), ...files }, [GUARD]), GUARD);
}

describe("check-playwright-pin", { timeout: SPAWN_TEST_TIMEOUT }, () => {
  it("exits 0 when every pin equals the lockfile version", () => {
    const { code, out } = run({
      "README.md": cmd("1.65.1"),
      "website/src/content/docs/getting-started.md": cmd("1.65.1"),
      "docs/integrations/remotxai.md": cmd("1.65.1"),
      "harness/adapters/pi/README.md": cmd("1.65.1"),
    });
    expect(out).toContain("4 pin(s)");
    expect(code).toBe(0);
  });

  it("uses the root importer, not a workspace package", () => {
    const { code } = run({ "README.md": cmd("1.65.1") });
    expect(code).toBe(0);
  });

  it("fails on a stale pin and names the file, line and expected version", () => {
    const { code, out } = run({
      "README.md": cmd("1.65.1"),
      "website/src/content/docs/guides/troubleshooting.md": `Intro\n\n${cmd("1.64.1")}`,
    });
    expect(code).toBe(1);
    expect(out).toContain("website/src/content/docs/guides/troubleshooting.md:3:");
    expect(out).toContain("pins playwright-core@1.64.1");
    expect(out).toContain("use playwright-core@1.65.1");
    expect(out).not.toContain("README.md:");
  });

  it("reports every stale pin on a line", () => {
    const { code, out } = run({
      "README.md": "npx playwright-core@1.64.1 install firefox, playwright-core@1.63.0 again\n",
    });
    expect(code).toBe(1);
    expect(out).toContain("2 stale pin(s)");
  });

  it("ignores CHANGELOG files, docs/rfcs and docs/ai-context", () => {
    const { code } = run({
      "README.md": cmd("1.65.1"),
      "docs/CHANGELOG.md": cmd("1.0.0"),
      "docs/rfcs/0001-old.md": cmd("1.0.0"),
      "docs/ai-context/investigations/old.md": cmd("1.0.0"),
    });
    expect(code).toBe(0);
  });

  it("fails when the lockfile has no root playwright-core", () => {
    const tree = makeTree(
      { "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "README.md": cmd("1.65.1") },
      [GUARD],
    );
    const { code, out } = runNode(tree, GUARD);
    expect(code).toBe(1);
    expect(out).toContain("no resolved playwright-core");
  });
});
