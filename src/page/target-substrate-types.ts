// The TargetSubstrate port — the structural identity of whatever the session is
// pointed at. Named for the TARGET, not the page: a Safari session has no
// Playwright `Page`, and the native engines RFC 0008 adds have no page and no
// document at all.
//
// It exists because ~10 tool handlers read the current URL (and one reads the
// title) by reaching `e.session.page().url()` — the Playwright bypass RFC 0009
// closes. Every one of those reads is structural identity, every engine can
// answer it, and the two engines shipped today answer it differently: Playwright
// reads the in-process `Page`, safaridriver round-trips `GET /url` over WebDriver
// Classic. So the read belongs on a port, and the handler above it stops caring
// which engine it is talking to.
//
// Dependency direction (architecture doctrine §1): tool handler → TargetSubstrate
// (this port) → implementation → Playwright Page | safaridriver. The port names
// no vendor type, so the `ports-name-no-vendor-type` dependency-cruiser rule
// holds. The implementations live in `target-substrate-playwright.ts` and
// `target-substrate-safari.ts`; both are re-exported through
// `./target-substrate.js`. (RFC 0009 P1.)
//
// SCOPE NOTE. RFC 0009's mapping table also assigns `alive()` and `rootFrameId()`
// to this port. Neither ships here.
//
// `isClosed()` is only called from the attached-target pool
// (`src/session/attach-*.ts`), which RFC 0009 leaves behind the Playwright handle
// for the whole migration, so `alive()` would have no caller above the seam — the
// speculative generality architecture-principles.md §4a forbids.
//
// `mainFrame()` is the more interesting one, and the reason is NOT that every
// call site is already below the seam: `replay/session.ts` and `challenge.ts`
// both call it and both sit above. The reason is that neither call site wants an
// IDENTIFIER. Both compare Playwright `Frame` OBJECT IDENTITY —
// `if (frame !== page.mainFrame()) return` — to filter a subscription down to the
// main frame, and an opaque string id cannot answer `!==` against a `Frame` the
// event handed them. Those two are event-subscription filters, so they move with
// `EventSubstrate` (P4), where the port hands the handler a `TargetEvent` already
// tagged with its frame and the comparison stops existing. `rootFrameId()` lands
// with the frame tools, and would today return the same `MAIN_FRAME_ID` constant
// on both engines, carrying no engine-varying content.

/** The structural identity of the session's current target. One instance wraps
 *  one session's engine handle; the methods carry no engine type, so the handlers
 *  above this seam are engine-blind. Mirrors the ActionSubstrate /
 *  CaptureSubstrate shape.
 *
 *  Both reads are async, which is the shape the second implementation forces:
 *  `page.url()` is a synchronous in-process read, but WebDriver's `currentUrl` is
 *  a round trip. A port that promised a synchronous URL would be a port only
 *  Playwright could implement. */
export interface TargetSubstrate {
  /** Engine tag — for diagnostics + the per-engine keystone matrix. */
  readonly engine: string;
  /** The target's current URL. Web: the document URL. Native (RFC 0008): the
   *  deep-link scheme plus screen id. Feeds the secret-scope check, the recorder's
   *  per-read URL stamp, and the session-listing / evidence-report envelopes. */
  url(): Promise<string>;
  /** The target's current title. Web: `document.title`. Native (RFC 0008): the
   *  current screen's accessibility label. Consumed by the snapshot header. */
  title(): Promise<string>;
}
