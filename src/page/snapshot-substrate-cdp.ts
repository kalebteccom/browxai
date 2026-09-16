// CdpSnapshotSubstrate — the chromium (and Chrome-on-Android) SnapshotSubstrate:
// the existing CDP path behind the port, VERBATIM. `compose` / `a11yTree`
// delegate to the exact functions the tools called inline before this seam
// (composeSnapshot / getA11yTree over the raw CDPSession), so the output is
// byte-identical and the chromium keystones are unchanged. The CDP handle is
// captured here once; callers never see it.
//
// It keeps its own module (not the shared `*-playwright.ts`) because it is a
// different implementation of the same port over a different protocol — the
// Playwright sibling drives no CDP at all.
//
// Dependency direction (architecture doctrine §1): tools → SnapshotSubstrate (the
// port in `snapshot-substrate-types.ts`) → this implementation → CDP. This file
// never imports back from the `snapshot-substrate.js` barrel.

import type { CDPSession } from "playwright-core";
import type { A11yNode } from "./a11y.js";
import { getA11yTree } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { composeSnapshot, type ComposedSnapshot, type ComposeOptions } from "./compose.js";
import type { SnapshotSubstrate } from "./snapshot-substrate-types.js";

export class CdpSnapshotSubstrate implements SnapshotSubstrate {
  readonly engine = "chromium";
  constructor(private readonly cdp: CDPSession) {}

  compose(
    refs: RefRegistry,
    testAttributes: string[],
    opts: ComposeOptions = {},
  ): Promise<ComposedSnapshot> {
    return composeSnapshot(this.cdp, refs, testAttributes, opts);
  }

  a11yTree(refs: RefRegistry, testAttributes: string[]): Promise<A11yNode | null> {
    return getA11yTree(this.cdp, refs, testAttributes);
  }
}
