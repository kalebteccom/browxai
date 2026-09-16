// Page-presence assertion for the now-optional `page()` member — the single legal
// caller of `BrowserSession.page?()` while RFC 0009 runs.
//
// `BrowserSession.page()` used to be mandatory, and Safari implemented the promise
// by throwing `safari-no-playwright-page` — the present-but-unconditionally-
// throwing port method RFC 0004 named as the L5 violation. RFC 0009 P1 makes the
// member optional as a compile-error enumeration device; this helper is where the
// ~140 sites the compiler listed route, mirroring `requireCdp` for the optional
// `cdp()` member.
//
// It is deliberately ONE greppable, countable identifier rather than ~140
// scattered `page!()` assertions. `page!()` would erase to `undefined()` on a
// no-Page engine — an opaque `TypeError` instead of a refusal that names the
// engine. Counting `requirePage` is how the remaining phases measure their own
// progress: every call site is a bypass a later phase moves behind a capability
// substrate, and P5 deletes this module together with the member it guards.
//
// NO NEW CALLER. A new read of the session's target belongs on a capability
// substrate (TargetSubstrate / CaptureSubstrate / ElementSubstrate / …), and
// page-availability is declared once as `caps.subInterfaces.has("page")` — never
// probed by calling this and catching.

import type { Page } from "playwright-core";

/** A session shape carrying the optional Page accessor + its engine tag. The
 *  full `BrowserSession` satisfies this; the helper takes the narrow shape so it
 *  doesn't pull the whole session interface into the engine module. */
export interface PageCapable {
  readonly engine: string;
  page?(): Page;
}

/** Return the session's Playwright `Page`. Throws a structured error naming the
 *  engine when the session's engine backs no Page (it declares no `"page"`
 *  sub-interface). On the four Playwright engines `page` is always present, so
 *  this never throws there — it stays a single truthiness check and a direct
 *  delegate on the hot path. */
export function requirePage(session: PageCapable): Page {
  if (!session.page) {
    throw new Error(
      `engine "${session.engine}" backs no Playwright Page — this operation needs one, and the ` +
        "engine declares no `page` sub-interface. Route it through a capability substrate, or " +
        "use a chromium/firefox/webkit/android session.",
    );
  }
  return session.page();
}
