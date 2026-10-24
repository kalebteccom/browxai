import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "../src/missions/catalog.js";
import { buildMissionPrompt } from "../src/missions/prompt.js";

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
