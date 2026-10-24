// `browxai doctor` — the BROWX_ATTACH_CDP / `byob-attach` consistency row.
//
// A server started with BROWX_ATTACH_CDP and without the off-by-default
// `byob-attach` capability refuses every attached session at creation. Doctor
// names that here, as a warning row: the environment is not broken, but the
// attach the operator configured will not happen until the capability is added.

import { capabilitiesAssignment, type Capability } from "../util/capabilities.js";
import type { Check } from "./doctor.js";

/** A warn row when `BROWX_ATTACH_CDP` is set and `byob-attach` is not enabled,
 *  otherwise null. */
export function attachCapabilityCheck(
  attachCdp: string | undefined,
  enabledCapabilities: ReadonlySet<Capability>,
): Check | null {
  if (!attachCdp?.trim() || enabledCapabilities.has("byob-attach")) return null;
  return {
    name: "byob-attach",
    ok: true,
    warn: true,
    detail:
      "BROWX_ATTACH_CDP is set but the `byob-attach` capability is off, so attaching is refused",
    fix:
      "add `byob-attach` to BROWX_CAPABILITIES and keep the defaults in the list " +
      `(${capabilitiesAssignment("byob-attach")}), then restart the server`,
  };
}
