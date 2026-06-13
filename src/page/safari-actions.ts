// Safari action helpers (RFC 0002 P4). Safari has no Playwright Page, so the
// Playwright action core (actions.ts → runInActionWindow → ctx.page) cannot run —
// `ctxFor(e)` throws `safari-no-playwright-page` at context construction. For the
// curated subset that DOES work on Safari, the server routes to these helpers,
// which drive the Safari-native WebDriver Classic client and return the same
// `ActionResult` shape so the tool surface stays engine-blind.
//
// First landing: `navigate` only (the keystone's page loader). The rest of the
// action family (click/fill/press/…) needs a full action substrate over WebDriver
// element interaction — a follow-up; until then those tools self-gate via the
// page()-throw. The envelope's structure/console/network deltas are NOT captured
// on Safari (no protocol-level taps) — surfaced honestly as a warning, never
// faked.

import type { SafariSessionHandle } from "../engine/index.js";
import type { ActionResult } from "./actionresult.js";

const EMPTY_NETWORK = { summary: { total: 0, byType: {}, failed: 0 } };
const SAFARI_ENVELOPE_NOTE =
  "safari: navigation ran via WebDriver Classic — the action envelope's structure / console / " +
  "network deltas are not captured on the safari engine (no protocol-level taps; RFC 0002 P4 " +
  "curated subset). Use `snapshot` to read post-navigation page state.";

/** Navigate a Safari session and return an `ActionResult`. Reads the URL before
 *  and after so `navigation.changed` is honest; the structure/console/network
 *  slices are empty (Safari has no taps) and a warning says so. */
export async function safariNavigate(
  handle: SafariSessionHandle,
  url: string,
): Promise<ActionResult> {
  const wd = handle.webDriver;
  const from = await wd.currentUrl(handle.sessionId).catch(() => "");
  await wd.navigate(handle.sessionId, url);
  const to = await wd.currentUrl(handle.sessionId).catch(() => url);
  const changed = from !== to;
  return {
    ok: true,
    action: { type: "navigate", url },
    navigation: { changed, from, to, kind: changed ? "full_load" : null },
    structure: { appeared: [], removed: [], newTabs: [] },
    console: { errors: [], warnings: 0 },
    pageErrors: [],
    network: EMPTY_NETWORK,
    tokensEstimate: 0,
    warnings: [SAFARI_ENVELOPE_NOTE],
  };
}
