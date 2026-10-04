// Shared refusal for tools that would end an `ask-human` hold: the three policy
// setters (`set_permission_policy`, `set_fs_picker_policy`,
// `set_notification_policy`) and `grant_permissions`. The decision lives in
// `policy/ask-human-guard.ts`; this adapts it to the host's `gateCheck` so the
// refusal keeps the standard `requiredCapability` shape.

import { leavingAskHuman, type PolicyShape } from "../policy/ask-human-guard.js";
import type { Capability } from "../util/capabilities.js";
import type { ToolResponse } from "./host.js";

type GateCheck = (
  toolName: string,
  extra?: readonly Capability[],
  reason?: string,
) => ToolResponse | null;

const HOLD =
  'That policy holds the request for a human answer, and this tool is the agent\'s, so it needs the operator-set human-gate-override capability. Changes that keep "ask-human" in place are still accepted.';

/** Refusal for a policy change that would move a key off `ask-human`, or null
 *  when the change keeps every `ask-human` key or the operator enabled
 *  `human-gate-override`. Runs before the policy is touched. */
export function askHumanPolicyGate(
  gateCheck: GateCheck,
  tool: string,
  current: PolicyShape,
  next: PolicyShape,
  supportedKeys: readonly string[],
): ToolResponse | null {
  const moved = leavingAskHuman(current, next, supportedKeys);
  if (moved.length === 0) return null;
  const names = moved.map((k) => (k === "*" ? "the top-level default" : k)).join(", ");
  return gateCheck(
    tool,
    ["human-gate-override"],
    `${tool} would move ${names} off "ask-human". ${HOLD}`,
  );
}

/** Refusal for a native grant of permissions whose policy is `ask-human`. A
 *  grant flips the browser's own state to `granted`. Names whose main
 *  entry point the page-side wrappers intercept (`wrapped`) still ask the human
 *  there; the rest (notifications, midi, sensors, payment-handler,
 *  background-sync, and anything outside the supported list) resolve natively
 *  with no prompt, so only those are refused.
 *  `modeFor` is the session's effective mode per permission name. */
export function askHumanGrantGate(
  gateCheck: GateCheck,
  tool: string,
  requested: readonly string[],
  modeFor: (name: string) => string,
  wrapped: readonly string[],
): ToolResponse | null {
  const held = requested.filter((name) => !wrapped.includes(name) && modeFor(name) === "ask-human");
  if (held.length === 0) return null;
  return gateCheck(
    tool,
    ["human-gate-override"],
    `${tool} would natively grant ${held.join(", ")}, which the session's permission policy holds on "ask-human". Those permissions are handled natively by the browser, so a grant skips the human prompt. ${HOLD}`,
  );
}
