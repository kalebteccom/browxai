// The `byob-attach` gate. Every `attached` session joins a browser browxai does
// not own: the operator's Chrome over BROWX_ATTACH_CDP, a desktop Electron app on
// its debugging port, or Chrome on an Android phone over adb. That session holds
// the user's real profile, so it is opt-in through the off-by-default
// `byob-attach` capability.
//
// The check runs in the session factory, before any connection is made, because
// every route to an attached session goes through it: `open_session({mode:
// "attached"})`, the default session a server started with BROWX_ATTACH_CDP
// creates lazily, an attach-only engine's default mode, and the SDK, which builds
// the same server. `caps` is the start-time set, which a saved config or
// `set_config` can only narrow, so neither can open this gate.

import { capabilityMissing, type Capability, type CapabilityConfig } from "../util/capabilities.js";
import type { ToolResponse } from "./host.js";

type GateCheck = (
  toolName: string,
  extra?: readonly Capability[],
  reason?: string,
) => ToolResponse | null;

/** Thrown at session creation when an `attached` session is asked for without
 *  `byob-attach`. `open_session` turns it into the standard gate refusal; any
 *  other tool that lazily creates the session reports the message. */
export class ByobAttachRefused extends Error {}

/** Throws `ByobAttachRefused` when `byob-attach` is not in the active set. */
export function refuseAttachWithoutCapability(
  caps: CapabilityConfig,
  session: string,
  engine: string,
): void {
  if (!capabilityMissing("byob-attach", caps)) return;
  throw new ByobAttachRefused(
    `capability-required: session "${session}": mode "attached" on engine "${engine}" joins a ` +
      "browser browxai does not own, with the user's real profile, so it needs the `byob-attach` " +
      "capability, which is OFF by default. Add it to BROWX_CAPABILITIES and keep the defaults in " +
      "the list (BROWX_CAPABILITIES=read,navigation,action,human,byob-attach), then restart the " +
      "server. A saved config or set_config cannot add it. See docs/threat-model.md for what it grants.",
  );
}

/** The standard gate refusal for a `ByobAttachRefused`, or null for any other
 *  error. */
export function byobAttachRefusal(gateCheck: GateCheck, err: unknown): ToolResponse | null {
  if (!(err instanceof ByobAttachRefused)) return null;
  return gateCheck("open_session", ["byob-attach"], err.message);
}
