// Keystone skips go through test/keystone/keystone-gate.ts, and each one names
// its reason.
//
// A keystone that skips shows in the CI log as one `↓` line among the passes, so
// a skip nobody meant (a browser missing from the image, a build step dropped)
// looks like a green run. The gate gives every skip a reason the skip reporter
// prints, and BROWX_REQUIRE_BROWSER=1 turns a missing Playwright browser into a
// failure. This file fails on a skip written any other way, and checks the gate
// and the reporter themselves.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunnerTask, RunnerTestSuite } from "vitest";
import {
  engineGate,
  gatedDescribe,
  hostGate,
  REQUIRE_BROWSER_ENV,
} from "../keystone/keystone-gate.js";
import { formatSkipSummary, NO_REASON, summarizeSkips } from "../keystone/skip-reporter.js";

const KEYSTONE_DIR = join(__dirname, "..", "keystone");
const GATE_FILE = "keystone-gate.ts";

/** Skip calls a keystone must not make directly: vitest's skip/todo/conditional
 *  modifiers, a runtime `ctx.skip()`, and a hand-written `skip: true` option. */
const DIRECT_SKIP =
  /\b(?:describe|it|test|suite)\s*\.\s*(?:skip|skipIf|runIf|todo)\b|\b(?:ctx|context)\s*\.\s*skip\s*\(|\bskip\s*:\s*true\b/;

describe("keystone skips", () => {
  it("no keystone file skips except through keystone-gate.ts", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(KEYSTONE_DIR).filter((n) => n.endsWith(".ts"))) {
      if (name === GATE_FILE) continue;
      readFileSync(join(KEYSTONE_DIR, name), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (DIRECT_SKIP.test(line))
            offenders.push(`test/keystone/${name}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(
      offenders,
      "skip through gatedDescribe(engineGate(...)) or gatedDescribe(hostGate(available, reason))",
    ).toEqual([]);
  });
});

/** CI configs that may run the keystone lane. */
const CI_DIRS = [".github/workflows", ".woodpecker"].map((d) => join(__dirname, "..", "..", d));

describe("CI keystone runs", () => {
  // A CI step that runs the keystone lane without BROWX_REQUIRE_BROWSER=1 turns a
  // browser missing from the image into skips, and the step stays green.
  it("every CI step that runs pnpm test:keystone sets BROWX_REQUIRE_BROWSER=1", () => {
    const runs: string[] = [];
    const offenders: string[] = [];
    for (const dir of CI_DIRS) {
      for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
        const lines = readFileSync(join(dir, name), "utf8").split("\n");
        lines.forEach((line, i) => {
          if (line.trim().startsWith("#") || !line.includes("pnpm test:keystone")) return;
          const where = `${name}:${i + 1}`;
          runs.push(where);
          const inline = line.includes(`${REQUIRE_BROWSER_ENV}=1`);
          // A GitHub Actions step: `env:` sits in the lines right after `run:`.
          const stepEnv = lines
            .slice(i + 1, i + 4)
            .some((l) => l.includes(`${REQUIRE_BROWSER_ENV}: "1"`));
          if (!inline && !stepEnv) offenders.push(`${where}: ${line.trim()}`);
        });
      }
    }
    expect(runs.length, "no CI step runs the keystone lane").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});

describe("engineGate", () => {
  const present = { executablePath: () => "/bin/chrome", exists: () => true };
  const absent = { executablePath: () => "/bin/chrome", exists: () => false };

  it("runs when the binary exists, with or without the env", () => {
    expect(engineGate("chromium", { ...present, env: {} })).toEqual({
      run: true,
      path: "/bin/chrome",
    });
    expect(engineGate("chromium", { ...present, env: { [REQUIRE_BROWSER_ENV]: "1" } }).run).toBe(
      true,
    );
  });

  it("skips with the missing path as its reason when the env is unset", () => {
    const gate = engineGate("firefox", { ...absent, env: {} });
    expect(gate.run).toBe(false);
    expect(!gate.run && gate.reason).toContain("no firefox binary at /bin/chrome");
  });

  it("throws when the binary is missing and BROWX_REQUIRE_BROWSER=1", () => {
    expect(() => engineGate("webkit", { ...absent, env: { [REQUIRE_BROWSER_ENV]: "1" } })).toThrow(
      /BROWX_REQUIRE_BROWSER=1 and no webkit binary at \/bin\/chrome/,
    );
    expect(() =>
      engineGate("chromium", {
        executablePath: () => "",
        exists: () => true,
        env: { [REQUIRE_BROWSER_ENV]: "1" },
      }),
    ).toThrow(/Playwright names no chromium binary/);
  });

  it("treats any value other than 1 as unset", () => {
    expect(engineGate("chromium", { ...absent, env: { [REQUIRE_BROWSER_ENV]: "true" } }).run).toBe(
      false,
    );
  });
});

describe("hostGate", () => {
  it("runs when available and carries the reason otherwise", () => {
    expect(hostGate(true, "needs a device")).toEqual({ run: true });
    expect(hostGate(false, "needs a device")).toEqual({ run: false, reason: "needs a device" });
  });
});

const SKIPPED_SUITE = "gated suite that skips";
gatedDescribe(hostGate(false, "the reason under test"))(SKIPPED_SUITE, () => {
  it("never runs", () => {
    expect.unreachable();
  });
});

function findSuite(tasks: RunnerTask[], name: string): RunnerTestSuite | undefined {
  for (const t of tasks) {
    if (t.type !== "suite") continue;
    if (t.name === name) return t;
    const inner = findSuite(t.tasks, name);
    if (inner) return inner;
  }
  return undefined;
}

describe("gatedDescribe", () => {
  it("skips the suite and puts the gate's reason on each of its tests", ({ task }) => {
    const suite = findSuite(task.file.tasks, SKIPPED_SUITE);
    expect(suite?.mode).toBe("skip");
    const test = suite?.tasks[0];
    expect(test?.mode).toBe("skip");
    expect(test?.meta.skipReason).toBe("the reason under test");
  });
});

describe("skip summary", () => {
  it("counts run and skipped tests and groups skips by file with their reasons", () => {
    const summary = summarizeSkips([
      { file: "test/keystone/a.keystone.test.ts", state: "passed" },
      { file: "test/keystone/a.keystone.test.ts", state: "failed" },
      { file: "test/keystone/c.keystone.test.ts", state: "skipped", skipReason: "no device" },
      { file: "test/keystone/c.keystone.test.ts", state: "skipped", skipReason: "no device" },
      { file: "test/keystone/b.keystone.test.ts", state: "skipped" },
    ]);
    expect(summary).toEqual({
      run: 2,
      skipped: 3,
      rows: [
        { file: "test/keystone/b.keystone.test.ts", count: 1, reasons: [NO_REASON] },
        { file: "test/keystone/c.keystone.test.ts", count: 2, reasons: ["no device"] },
      ],
    });
    expect(formatSkipSummary(summary)).toBe(
      [
        "keystone: 2 run, 3 skipped",
        `  skipped 1  test/keystone/b.keystone.test.ts: ${NO_REASON}`,
        "  skipped 2  test/keystone/c.keystone.test.ts: no device",
      ].join("\n"),
    );
  });

  it("prints only the count line when nothing skipped", () => {
    expect(formatSkipSummary(summarizeSkips([{ file: "x", state: "passed" }]))).toBe(
      "keystone: 1 run, 0 skipped",
    );
  });
});
