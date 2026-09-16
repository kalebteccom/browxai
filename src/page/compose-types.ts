// The composed-snapshot vocabulary — the merged-tree envelope and the compose
// options. No CDP, no Playwright.
//
// Split out of `compose.ts` because the SnapshotSubstrate port
// (`snapshot-substrate-types.ts`) names `ComposedSnapshot` and `ComposeOptions`
// in `compose()`, and `compose.ts` imports `CDPSession` / `Frame` for the
// composition that produces one. A port module that reaches playwright-core —
// even transitively, even type-only — is not a port, which is what the
// `ports-name-no-vendor-type` dependency-cruiser rule enforces. Declarations
// here, composition there; `compose.ts` re-exports both names so existing
// importers are unchanged. (RFC 0009 P1.)

import type { A11yNode } from "./a11y-types.js";

export interface ComposedSnapshot {
  /** The combined tree. Root is the a11y root; DOM-walk leaves are appended as children. */
  tree: A11yNode | null;
  /** Counts and source mix — useful for the low-content warning + debugging. */
  stats: {
    a11yInteractive: number;
    domWalkEntries: number;
    domWalkNew: number;
    domWalkCombined: number;
    /** count of closed-shadow elements harvested via CDP.
     *  Always zero when `pierce !== "closed"` or CDP refused the pierce
     *  call. */
    closedShadowEntries?: number;
  };
  /** Non-fatal warnings — low-content a11y tree, closed-shadow CDP
   *  unavailable when pierce: "closed" was requested, etc. */
  warnings: string[];
}

export interface ComposeOptions {
  /** shadow DOM piercing.
   *  - `undefined` (default) — pre-v0.5.0 behaviour. Playwright's a11y tree
   *    already includes open shadow content, but the DOM-walk fallback does
   *    not recurse into shadow roots.
   *  - `"open"` — additionally have the DOM-walk recurse through every open
   *    shadow root reachable from the page side.
   *  - `"closed"` — open-walk + CDP `pierce:true` pass that surfaces
   *    interactive / test-attr-bearing elements inside CLOSED shadow roots.
   *    Best-effort: when CDP refuses the pierce call (older Chromium,
   *    detached attached-mode session), falls back to the open-only result
   *    and emits a warning.
   *  - `false` — neither path recurses into shadow content. The DOM-walk
   *    sticks to the top document. */
  pierce?: "open" | "closed" | false;
}
