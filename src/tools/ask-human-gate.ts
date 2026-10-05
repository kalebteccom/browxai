// Shared refusal for tools that would end an `ask-human` hold: the three policy
// setters (`set_permission_policy`, `set_fs_picker_policy`,
// `set_notification_policy`) and `grant_permissions`. The decision lives in
// `policy/ask-human-guard.ts`; this adapts it to the host's `gateCheck` so the
// refusal keeps the standard `requiredCapability` shape.

import { leavingAskHuman, type PolicyShape } from "../policy/ask-human-guard.js";
import type { HeldAskHuman } from "../session/registry.js";
import { SUPPORTED_PERMISSIONS, type PermissionPolicy } from "../session/permission-policy.js";
import type { NotificationPolicy } from "../session/notification-policy.js";
import { SUPPORTED_FS_PICKER_APIS, type FsPickerPolicy } from "../session/fs-picker-policy.js";
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

/** The policies `open_session` was asked to apply, as parsed. */
export interface RequestedPolicies {
  permission?: PermissionPolicy;
  notification?: NotificationPolicy;
  fsPicker?: FsPickerPolicy;
}

/** Refusal for an `open_session` that would reopen a session name with a policy
 *  that ends an `ask-human` hold the name carried when it last closed, or null
 *  when nothing moves or the operator enabled `human-gate-override`. A policy the
 *  call leaves out is inherited from the hold, so only an explicit policy can
 *  move. Without this, closing an `ask-human` session and reopening the name with
 *  `allow` would sidestep the setters' gate. Runs before anything is launched. */
export function askHumanReopenGate(
  gateCheck: GateCheck,
  session: string,
  held: HeldAskHuman | undefined,
  requested: RequestedPolicies,
): ToolResponse | null {
  if (!held) return null;
  const moved: string[] = [];
  if (held.permission && requested.permission) {
    const a = held.permission;
    const b = requested.permission;
    const keys = leavingAskHuman(
      { mode: a.mode, overrides: a.perPermission },
      { mode: b.mode, overrides: b.perPermission },
      SUPPORTED_PERMISSIONS,
    );
    if (keys.length > 0) moved.push(`permissionPolicy (${keys.join(", ")})`);
  }
  if (held.notification && requested.notification) {
    const keys = leavingAskHuman(
      { mode: held.notification.mode },
      { mode: requested.notification.mode },
      ["notifications"],
    );
    if (keys.length > 0) moved.push("notificationPolicy");
  }
  if (held.fsPicker && requested.fsPicker) {
    const a = held.fsPicker;
    const b = requested.fsPicker;
    const keys = leavingAskHuman(
      { mode: a.mode, overrides: a.perAPI },
      { mode: b.mode, overrides: b.perAPI },
      SUPPORTED_FS_PICKER_APIS,
    );
    if (keys.length > 0) moved.push(`fsPickerPolicy (${keys.join(", ")})`);
  }
  if (moved.length === 0) return null;
  return gateCheck(
    "open_session",
    ["human-gate-override"],
    `open_session would reopen "${session}" with ${moved.join(", ")} off "ask-human", but that session held it for a human when it closed. ${HOLD} Leave the policy out to keep what the session held.`,
  );
}
