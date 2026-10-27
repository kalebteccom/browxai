// `browxai doctor` — the BROWX_ATTACH_CDP / `byob-attach` consistency row.
//
// A server started with BROWX_ATTACH_CDP and without the off-by-default
// `byob-attach` capability refuses every attached session at creation. Doctor
// names that here, as a warning row: the environment is not broken, but the
// attach the operator configured will not happen until the capability is added.

import { capabilitiesAssignment, type Capability } from "../util/capabilities.js";
import { docsUrl } from "../util/docs-links.js";
import { sanitizeUrl, sanitizeUrlsInText } from "../util/url-sanitizer.js";
import type { Check } from "./doctor.js";

/** The `cdp-attach` row for a set BROWX_ATTACH_CDP. The URL is printed without
 *  userinfo, query or fragment, so a token in it stays out of the output. */
export function cdpAttachRow(
  attachCdp: string,
  reachable: { ok: true; version: string } | { ok: false; error: string },
): Check {
  const shown = sanitizeUrl(attachCdp);
  return {
    name: "cdp-attach",
    ok: reachable.ok,
    detail: reachable.ok
      ? `${shown} reachable, ${reachable.version}`
      : `${shown} unreachable (${sanitizeUrlsInText(reachable.error)})`,
    fix: reachable.ok
      ? undefined
      : "start a Chrome at this port: `browxai chrome start` or `chrome --remote-debugging-port=9222 …`",
  };
}

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
      `(${capabilitiesAssignment("byob-attach")}), then restart the server. See ${docsUrl.threatModelConfiguring}`,
  };
}
