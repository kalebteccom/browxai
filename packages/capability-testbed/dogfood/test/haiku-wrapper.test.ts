import test from "node:test";
import assert from "node:assert/strict";
import { resolveDogfoodConfig } from "../src/config.js";

test("wrapper config defaults to the owner-authorized yolo Codex sandbox", () => {
  // Default is `danger-full-access` + never-prompt so codex-cli 0.140.0 does not
  // gate every browxai MCP tool call behind an approval/elicitation (read-only +
  // the elicit gate rejected all calls as "user rejected MCP tool call"). The
  // mission prompt (browxai tools only, no shell) is the behavioural guardrail.
  const config = resolveDogfoodConfig(["--mock", "--run-root", "/tmp/browxai-dogfood-test"]);
  assert.equal(config.sandbox, "danger-full-access");
  assert.equal(config.approvalPolicy, "never");
  assert.equal(config.proxyCommand, "node");
  assert.ok(config.proxyArgsPrefix[0]?.endsWith("browxai-socket-proxy.js"));
});
