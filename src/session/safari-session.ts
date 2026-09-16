// The Safari BrowserSession — the no-Playwright-Page seam. Safari is the first
// engine with neither a Playwright Page nor CDP, so its session wraps the
// adapter's Safari-native handle (WebDriver Classic + optional BiDi) and OMITS
// the `page` member entirely. Tools that can run on Safari route through
// `safari()` (the snapshot substrate reads via the handle's execute/sync;
// click/fill/navigate/cookies via its WebDriver Classic client); everything else
// is capability-gated up front against the declared `"page"` sub-interface.
//
// The member used to be present and unconditionally THROW
// `safari-no-playwright-page` — the L5 violation RFC 0004 named and RFC 0009
// closes. It went when `page` became optional: a present-but-throwing method
// makes the session a second, disagreeing oracle for page-availability, and it
// made `requirePage`'s engine-naming refusal dead code on the one engine that
// needed it (the `if (!session.page)` guard was false, so the helper delegated
// straight into the throw). Absent means `requirePage` refuses with the message
// that names the engine and points at the substrates, and
// `caps.subInterfaces.has("page")` stays the one oracle. (RFC 0009 P1.)
//
// Factored out of managed.ts so it unit-tests with a mock handle (no safaridriver
// spawn).

import type { SafariSessionHandle } from "../engine/index.js";
import type { BrowserSession } from "./types.js";

/** Wrap a live Safari adapter handle as a `BrowserSession`. No `page` member —
 *  the engine backs none and declares none; `safari()` exposes the native handle;
 *  `close()` tears the safaridriver session + process down. Managed/isolated only
 *  — Safari has no headless and no separate-context incognito (incognito/byob
 *  refuse upstream). */
export function buildSafariSession(handle: SafariSessionHandle): BrowserSession {
  let closed = false;
  return {
    mode: "managed",
    ownsBrowser: true,
    engine: "safari",
    safari: () => handle,
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}
