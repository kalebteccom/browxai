import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDogfoodConfig } from "../src/config.js";
import { CATALOG } from "../src/missions/catalog.js";
import { buildMissionPrompt } from "../src/missions/prompt.js";
import { mockCodexFramesForMission } from "../src/mock/fixtures.js";
import { generateDogfoodReport } from "../src/report/generator.js";
import { TraceBuilder } from "../src/trace/codex-normalizer.js";
import { writeTraceJsonl } from "../src/trace/trace-record.js";

test("report generator marks mock mission coverage complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "browxai-dogfood-report-"));
  try {
    const config = resolveDogfoodConfig([
      "--mock",
      "--mission",
      "forms-input-providers",
      "--k",
      "1",
      "--run-root",
      root,
    ]);
    const mission = CATALOG.find((entry) => entry.id === "forms-input-providers");
    assert.ok(mission);
    const prompt = buildMissionPrompt({
      mission,
      baseUrl: "mock://testbed",
      sessionId: "mock-session",
      maxToolCalls: config.maxToolCalls,
      maxTurns: config.maxTurns,
    });
    const builder = new TraceBuilder({
      sessionId: "mock-session",
      missionId: mission.id,
      runIndex: 0,
      prompt,
      startedAtMs: 1_700_000_000_000,
    });
    mockCodexFramesForMission({ mission, sessionId: "mock-session", runIndex: 0 }).forEach(
      (frame, index) => builder.addRaw("in", frame, 1_700_000_000_000 + index),
    );
    const finalized = builder.finalize(1_700_000_001_000);
    const tracePath = join(root, "trace.jsonl");
    await writeTraceJsonl(tracePath, finalized.entries);
    const { report } = await generateDogfoodReport({
      config,
      testbedBaseUrl: "mock://testbed",
      catalog: CATALOG,
      traces: [
        {
          mission,
          trace: finalized.record,
          tracePath,
          oracleResults: mission.oracle.exerciseTools.map((tool) => ({ tool, outcome: "pass" })),
        },
      ],
      git: { sha: "test", dirty: false },
    });
    assert.equal(report.missionOutcomes["forms-input-providers"]?.status, "passed");
    assert.equal(report.missionOutcomes["forms-input-providers"]?.coverageComplete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mission prompt gives done criteria without measurement leakage", () => {
  const mission = CATALOG.find((entry) => entry.id === "forms-input-providers");
  assert.ok(mission);
  const prompt = buildMissionPrompt({
    mission,
    baseUrl: "mock://testbed",
    sessionId: "mock-session",
    maxToolCalls: 25,
    maxTurns: 8,
  });
  assert.match(prompt, /Success criteria:/);
  assert.match(prompt, /The moment the success criteria are met/);
  assert.match(prompt, /Budget: finish within 25 browxai tool calls and 8 Codex turns/);
  assert.doesNotMatch(prompt, /expectedTools|oracle|exerciseTools/);
});
