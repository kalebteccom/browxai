// The Safari BrowserSession — the no-Playwright-Page seam. Safari
// is the first engine with neither a Playwright Page nor CDP, so its session
// wraps the adapter's Safari-native handle (WebDriver Classic + optional BiDi)
// and makes `page()` a structured THROW rather than returning a fake Page. Tools
// that can run on Safari route through `safari()` (the snapshot substrate reads
// via the handle's execute/sync; click/fill/navigate/cookies via its WebDriver
// Classic client); everything else is capability-gated up front, so `page()` is
// never reached on a supported tool.
//
// Factored out of managed.ts so it unit-tests with a mock handle (no safaridriver
// spawn) and so the page()-throw message has one home.

import type { SafariSessionHandle } from "../engine/index.js";
import type { BrowserSession } from "./types.js";

/** The structured error `page()` throws on a Safari session — names why and where
 *  to route instead. Exported so callers/tests assert on it consistently. */
export const NO_PLAYWRIGHT_PAGE =
  "safari-no-playwright-page: the safari engine has no Playwright Page (it is driven over " +
  "safaridriver, not Playwright). Tools that run on Safari route through the Safari-native handle " +
  "(session.safari()) — snapshot/find via the substrate, navigate/click/fill/screenshot/cookies via " +
  "its WebDriver Classic client; everything else is capability-gated.";

/** Wrap a live Safari adapter handle as a `BrowserSession`. `page()` throws
 *  (`NO_PLAYWRIGHT_PAGE`); `safari()` exposes the native handle; `close()` tears
 *  the safaridriver session + process down. Managed/isolated only — Safari has no
 *  headless and no separate-context incognito (incognito/byob refuse upstream). */
export function buildSafariSession(handle: SafariSessionHandle): BrowserSession {
  let closed = false;
  return {
    mode: "managed",
    ownsBrowser: true,
    engine: "safari",
    page: () => {
      throw new Error(NO_PLAYWRIGHT_PAGE);
    },
    safari: () => handle,
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}
