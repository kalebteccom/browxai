// The engine-level capability gate. An engine whose session broadens posture on
// its own (the native `ios-app` and `android-app` engines install and launch
// applications before any tool runs) declares the capability it needs, and the
// session factory refuses to create such a session without it. This file turns
// that refusal into the standard gate refusal, so `open_session` and a tool that
// creates the default session lazily both report `requiredCapability`.

import type { Capability } from "../util/capabilities.js";
import type { GateCheck } from "./ask-human-gate.js";
import type { ToolResponse } from "./host.js";

/** Thrown at session creation when the session's engine needs a capability the
 *  server does not have. */
export class EngineCapabilityRefused extends Error {
  constructor(
    message: string,
    readonly capability: Capability,
  ) {
    super(message);
  }
}

/** The standard gate refusal for an `EngineCapabilityRefused`, or null for any
 *  other error. */
export function engineCapabilityRefusal(gateCheck: GateCheck, err: unknown): ToolResponse | null {
  if (!(err instanceof EngineCapabilityRefused)) return null;
  return gateCheck("open_session", [err.capability], err.message);
}
