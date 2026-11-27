import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "./runtime-exec.js";
import {
  enginesCheck,
  enginesHold,
  guardReason,
  installedPackageVersion,
  majorHold,
  nodeVersionOf,
  playwrightHold,
  usesBundledChromium,
} from "./runtime-guards.js";

/** A runner that answers `<node> --version` and counts its calls. */
function nodeRunner(stdout: string, status = 0) {
  const calls: string[][] = [];
  const run = (file: string, args: readonly string[]): Promise<RunResult> => {
    calls.push([file, ...args]);
    return Promise.resolve({ status, stdout, stderr: "" });
  };
  return Object.assign(run, { calls });
}

describe("the major guard (D7)", () => {
  it("holds a new major version from 1.0 on, 1.0.0 over a 0.x included", () => {
    expect(majorHold("2.0.0", "1.4.0", false)).toBe(
      "a new major version (1.4.0 to 2.0.0). Run browxai runtime update --allow-major, " +
        "or browxai runtime config major allow",
    );
    expect(majorHold("1.0.0", "0.30.0", false)).toContain("0.30.0 to 1.0.0");
  });

  it("lets minors before 1.0 and every minor or patch after it cross", () => {
    expect(majorHold("0.23.0", "0.22.0", false)).toBeUndefined();
    expect(majorHold("1.5.0", "1.4.0", false)).toBeUndefined();
    expect(majorHold("1.4.1", "1.4.0", false)).toBeUndefined();
  });

  it("holds nothing when allowed, or with no current version", () => {
    expect(majorHold("2.0.0", "1.4.0", true)).toBeUndefined();
    expect(majorHold("2.0.0", undefined, false)).toBeUndefined();
  });
});

describe("the Node engines hold", () => {
  it("names the range, the node and its version", () => {
    expect(enginesHold(">=24", "22.11.0", "/opt/node/bin/node")).toBe(
      "needs Node >=24, and the runtime's node at /opt/node/bin/node is 22.11.0",
    );
    expect(enginesHold(">=24", "v22.11.0", "/n")).toBe(
      "needs Node >=24, and the runtime's node at /n is 22.11.0",
    );
  });

  it("holds nothing when the node satisfies the range, or either can't be read", () => {
    expect(enginesHold(">=22", "22.11.0", "/n")).toBeUndefined();
    expect(enginesHold(">=banana", "22.11.0", "/n")).toBeUndefined();
    expect(enginesHold(undefined, "22.11.0", "/n")).toBeUndefined();
    expect(enginesHold(">=24", undefined, "/n")).toBeUndefined();
  });

  it("reads the node's version once, and only for a version that names a range", async () => {
    const run = nodeRunner("v22.11.0\n");
    const check = enginesCheck({ node: "/opt/node/bin/node", run });
    expect(await check({ version: "0.23.0" })).toBeUndefined();
    expect(run.calls).toEqual([]);
    expect(await check({ version: "0.23.0", enginesNode: ">=24" })).toContain("needs Node >=24");
    expect(await check({ version: "0.24.0", enginesNode: ">=22" })).toBeUndefined();
    expect(run.calls).toEqual([["/opt/node/bin/node", "--version"]]);
  });

  it("knows this process's node without running it, and gives up on odd output", async () => {
    const run = nodeRunner("v1.0.0\n");
    expect(await nodeVersionOf({ node: process.execPath, run })).toBe(process.versions.node);
    expect(run.calls).toEqual([]);
    expect(await nodeVersionOf({ node: "/n", run: nodeRunner("hello\n") })).toBeUndefined();
    expect(await nodeVersionOf({ node: "/n", run: nodeRunner("v22.1.0\n", 1) })).toBeUndefined();
  });

  it("puts the major guard before the engines hold", async () => {
    const run = nodeRunner("v22.11.0\n");
    const engines = enginesCheck({ node: "/n", run });
    const info = { version: "2.0.0", enginesNode: ">=24" };
    expect(await guardReason(info, "1.4.0", false, engines)).toContain("a new major version");
    expect(await guardReason(info, "1.4.0", true, engines)).toContain("needs Node >=24");
  });
});

describe("the Playwright-bump hold (D20)", () => {
  it("reads whether sessions here launch the bundled Chromium", () => {
    expect(usesBundledChromium([{ name: "chrome", ok: false }])).toBe(true);
    expect(
      usesBundledChromium([
        { name: "chrome", ok: true },
        { name: "chromium", ok: true, info: true },
      ]),
    ).toBe(false);
    expect(
      usesBundledChromium([
        { name: "chrome", ok: true, info: true },
        { name: "chromium", ok: true },
      ]),
    ).toBe(true);
    expect(usesBundledChromium([])).toBe(false);
  });

  it("holds a playwright-core change only where the bundled Chromium is used", () => {
    expect(playwrightHold("0.23.0", "1.65.1", "1.66.0", true)).toBe(
      "needs a Chromium download: it moves playwright-core from 1.65.1 to 1.66.0, and this machine has no Google Chrome. " +
        "Run browxai runtime update --version 0.23.0, then npx playwright-core@1.66.0 install chromium",
    );
    expect(playwrightHold("0.23.0", "1.65.1", "1.66.0", false)).toBeUndefined();
    expect(playwrightHold("0.23.0", "1.65.1", "1.65.1", true)).toBeUndefined();
    expect(playwrightHold("0.23.0", undefined, "1.66.0", true)).toBeUndefined();
  });
});

describe("installedPackageVersion", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reads node_modules/<name>/package.json, or gives undefined", () => {
    dir = mkdtempSync(join(tmpdir(), "bx-guards-"));
    const pkg = join(dir, "node_modules", "playwright-core");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "1.65.1" }));
    expect(installedPackageVersion(dir, "playwright-core")).toBe("1.65.1");
    expect(installedPackageVersion(dir, "browxai")).toBeUndefined();
  });
});
