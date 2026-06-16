import test from "node:test";
import assert from "node:assert/strict";
import { mapCodexNotification } from "../src/runtime/codex-events.js";
import { protocolDriftGoldenFrames } from "../src/mock/fixtures.js";

test("golden app-server frames normalize mcp, reasoning, plan, usage, and errors", () => {
  const events = protocolDriftGoldenFrames().flatMap((frame, index) =>
    mapCodexNotification(frame, 1_000 + index),
  );
  assert.ok(
    events.some((event) => event.kind === "tool_call" && event.label === "mcp browxai:snapshot"),
  );
  assert.ok(events.some((event) => event.kind === "reasoning"));
  assert.ok(events.some((event) => event.kind === "plan_update"));
  assert.ok(events.some((event) => event.kind === "context_usage"));
  assert.ok(
    events.some((event) => event.kind === "rpc_error" && event.message === "thread/start failed"),
  );
});
