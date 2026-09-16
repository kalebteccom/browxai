// The SnapshotSubstrate port — the engine-agnostic seam beneath the snapshot /
// find / extract / text_search / set-of-marks / watch tools and the pre/post
// ActionResult a11y deltas. It is the substrate side of the hybrid snapshot/a11y
// design: the tools ask a substrate for "the a11y+DOM tree to mint refs from"; an
// engine-specific implementation answers.
//
// Dependency direction (architecture doctrine §1): tools → SnapshotSubstrate
// (this port) → implementation → CDP / Playwright / safaridriver. A tool never
// reaches a CDPSession or a raw Page through this seam; the engine handle is
// captured at substrate construction, so the per-call surface carries no engine
// type. That is what un-couples snapshot/find from CDP and lets them run on
// Firefox. Split out of `snapshot-substrate.ts` so the port module names no vendor
// type; the implementations live in `snapshot-substrate-cdp.ts`,
// `snapshot-substrate-playwright.ts` and `snapshot-substrate-safari.ts`.
// Re-exported through `./snapshot-substrate.js` so callers import unchanged.
// (RFC 0009 P1.)

import type { A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import type { ComposedSnapshot, ComposeOptions } from "./compose.js";

/** The a11y+DOM tree source the snapshot/find tools mint refs from. One
 *  instance wraps one session's engine handle; the methods carry no engine
 *  type, so the tools above this seam are engine-agnostic. */
export interface SnapshotSubstrate {
  /** Engine tag — for diagnostics + the per-engine keystone matrix. */
  readonly engine: string;
  /** The composed snapshot (a11y tree + DOM-walk fallback merged) for the
   *  main frame. The read core (snapshot/find/extract/text_search/set-of-marks)
   *  consumes this. `opts.pierce` reaches the DOM-walk + (chromium only) the
   *  closed-shadow CDP pass. */
  compose(
    refs: RefRegistry,
    testAttributes: string[],
    opts?: ComposeOptions,
  ): Promise<ComposedSnapshot>;
  /** The raw a11y tree only (no DOM-walk merge). The action window's pre/post
   *  snapshotDelta and `watch`'s region sampling consume this — they need the
   *  structural a11y tree, not the find-ranking-augmented composed tree. */
  a11yTree(refs: RefRegistry, testAttributes: string[]): Promise<A11yNode | null>;
}
