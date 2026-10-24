// The policy half of `open_session`: parse the four policy arguments, then run
// the `ask-human` reopen gate over them. Split out of the lifecycle tools so the
// handler stays a short sequence and this stays one reason to change.

import { parseDialogPolicyArg, type DialogPolicy } from "../session/dialog.js";
import { parsePermissionPolicyArg, type PermissionPolicy } from "../session/permission.js";
import { parseNotificationPolicyArg, type NotificationPolicy } from "../session/notification.js";
import { parseFsPickerPolicyArg, type FsPickerPolicy } from "../session/fs-picker.js";
import type { HeldAskHuman } from "../session/registry.js";
import { askHumanReopenGate } from "./ask-human-gate.js";
import type { GateHost, ToolResponse } from "./host.js";
import { harWritesBodies } from "../page/har.js";

/** The parsed policy bundle `open_session` threads into `registry.get`. */
export interface ParsedOpenSessionPolicies {
  dialogPolicy?: DialogPolicy;
  permissionPolicy?: PermissionPolicy;
  notificationPolicy?: NotificationPolicy;
  fsPickerPolicy?: FsPickerPolicy;
}

/** The four optional policy args as the tool receives them. */
export interface OpenSessionPolicyArgs {
  dialogPolicy?: string | DialogPolicy;
  permissionPolicy?: string | PermissionPolicy;
  notificationPolicy?: string | NotificationPolicy;
  fsPickerPolicy?: string | FsPickerPolicy;
  /** `har.content`: `embed` / `attach` write bodies to disk and need
   *  `network-body`, as on `start_har`. */
  harContent?: "embed" | "attach" | "omit";
}

/** Parse the four optional policy args. Throws on a malformed policy string. */
function parseOpenSessionPolicies(args: OpenSessionPolicyArgs): ParsedOpenSessionPolicies {
  return {
    dialogPolicy: args.dialogPolicy ? parseDialogPolicyArg(args.dialogPolicy) : undefined,
    permissionPolicy: args.permissionPolicy
      ? parsePermissionPolicyArg(args.permissionPolicy)
      : undefined,
    notificationPolicy: args.notificationPolicy
      ? parseNotificationPolicyArg(args.notificationPolicy)
      : undefined,
    fsPickerPolicy: args.fsPickerPolicy ? parseFsPickerPolicyArg(args.fsPickerPolicy) : undefined,
  };
}

/** Parse the policy args into the bundle `open_session` opens with, or the
 *  refusal to return instead: the `network-body` refusal for a HAR that would
 *  write bodies, a structured `ok:false` for a malformed policy, or
 *  the `human-gate-override` refusal when a name that held `ask-human` when it
 *  last closed would reopen with a policy that moves a held key off it. Nothing
 *  has launched yet when this runs. */
export function resolveOpenSessionPolicies(
  gateCheck: GateHost["gateCheck"],
  session: string,
  held: HeldAskHuman | undefined,
  args: OpenSessionPolicyArgs,
): { ok: true; policies: ParsedOpenSessionPolicies } | { ok: false; response: ToolResponse } {
  if (harWritesBodies(args.harContent)) {
    const reason = `har.content "${args.harContent}" writes request and response bodies to disk`;
    const bodies = gateCheck("open_session", ["network-body"], reason);
    if (bodies) return { ok: false, response: bodies };
  }
  let policies: ParsedOpenSessionPolicies;
  try {
    policies = parseOpenSessionPolicies(args);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const text = JSON.stringify({ ok: false, error }, null, 2);
    return { ok: false, response: { content: [{ type: "text" as const, text }] } };
  }
  const refused = askHumanReopenGate(gateCheck, session, held, {
    permission: policies.permissionPolicy,
    notification: policies.notificationPolicy,
    fsPicker: policies.fsPickerPolicy,
  });
  return refused ? { ok: false, response: refused } : { ok: true, policies };
}
