import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDogfoodConfig } from "../src/config.js";
import { runDogfood } from "../src/runner.js";
import type { DogfoodReport } from "../src/report/schema.js";
import { readTraceRecordFromJsonl } from "../src/trace/trace-record.js";

async function runMock(argv: readonly string[]): Promise<{
  readonly report: DogfoodReport;
  readonly traceRaw: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "browxai-dogfood-runner-"));
  try {
    const config = resolveDogfoodConfig([
      "--mock",
      "--mission",
      "forms-input-providers",
      "--k",
      "1",
      "--run-root",
      root,
      ...argv,
    ]);
    const result = await runDogfood(config);
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as DogfoodReport;
    const tracePath = report.traces[0]?.path;
    assert.ok(tracePath);
    const traceRaw = await readFile(tracePath, "utf8");
    return { report, traceRaw };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("mock pipeline writes complete trace with reasoning and tool calls", async () => {
  const { report, traceRaw } = await runMock([]);
  const trace = readTraceRecordFromJsonl(traceRaw);
  assert.ok(trace);
  assert.equal(report.missionOutcomes["forms-input-providers"]?.status, "passed");
  assert.ok(trace.reasoningItems.length > 0);
  assert.ok(trace.toolEvents.length > 0);
  assert.ok(traceRaw.includes('"direction":"in"'));
  assert.ok(traceRaw.includes('"direction":"out"'));
});

test("mock pipeline records budget-exhausted as incomplete report", async () => {
  const { report, traceRaw } = await runMock(["--max-tool-calls", "1"]);
  const trace = readTraceRecordFromJsonl(traceRaw);
  assert.ok(trace);
  const outcome = report.missionOutcomes["forms-input-providers"];
  assert.equal(outcome?.status, "incomplete");
  assert.match(outcome?.failReason ?? "", /^budget-exhausted: \d+ tool calls \/ \d+ turns$/);
  assert.equal(trace.termination?.kind, "budget_exhausted");
});

test("mock pipeline records timeout as incomplete report without hanging", async () => {
  const result = await Promise.race([
    runMock(["--timeout-ms", "1"]),
    new Promise<"hung">((resolve) => {
      setTimeout(() => resolve("hung"), 2_000);
    }),
  ]);
  assert.notEqual(result, "hung");
  if (result === "hung") return;
  const trace = readTraceRecordFromJsonl(result.traceRaw);
  assert.ok(trace);
  const outcome = result.report.missionOutcomes["forms-input-providers"];
  assert.equal(outcome?.status, "incomplete");
  assert.match(outcome?.failReason ?? "", /^timed out after 1ms$/);
  assert.equal(trace.termination?.kind, "timed_out");
});
