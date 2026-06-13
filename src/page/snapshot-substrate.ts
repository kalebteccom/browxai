// The SnapshotSubstrate interface — the engine-agnostic seam beneath the
// snapshot / find / extract / text_search / set-of-marks / watch tools and the
// pre/post ActionResult a11y deltas. It is the substrate side of the hybrid
// snapshot/a11y design: the tools ask a substrate for "the a11y+DOM
// tree to mint refs from"; an engine-specific implementation answers.
//
// Dependency direction (architecture doctrine §1): tools → SnapshotSubstrate
// (this interface) → implementation → CDP / Playwright. A tool never reaches a
// CDPSession or a raw Page through this seam; the engine handle is captured at
// substrate construction, so the per-call surface carries no engine type. That
// is what un-couples snapshot/find from CDP and lets them run on Firefox.
//
// Two implementations behind it (hybrid):
//   - CdpSnapshotSubstrate (chromium): delegates to composeSnapshot /
//     getA11yTree VERBATIM — the existing CDP `Accessibility.getFullAXTree` +
//     `Runtime.evaluate` DOM-walk path, byte-identical output, so the 67+
//     chromium keystones stay green unchanged.
//   - PlaywrightSnapshotSubstrate (firefox / webkit): the page-side ARIA/DOM
//     walker over `frame.evaluate` (main world) — the SAME PAGE_SCRIPT the
//     already-portable composeSnapshotForFrame uses, generalized to the main
//     frame. It mints the SAME content-hashed ref shape (role/name/testId/
//     cssPath via elementKey), so refs are stable across substrates.
//
// Why the walker, not ariaSnapshot() (benchmarked):
// `locator.ariaSnapshot()` carries NO test attributes (data-testid/…), so it
// produces 0 testId-bearing nodes on a testid-tagged page — find() scores +5 on
// a testId hit and elementKey hashes testId into the ref, so an ariaSnapshot
// substrate degrades both ranking and ref stability. On the representative
// fixture the walker hit 4/5 find targets vs ariaSnapshot's 0/5, carried testId
// on 9 nodes vs 0, and ran ~10x faster (10 ms vs 104 ms). The walker also emits
// exactly the DomWalkEntry shape the existing merge path already consumes, so
// the firefox tree is byte-shape-identical to the chromium DOM-walk leaves.

import type { CDPSession, Page } from "playwright-core";
import type { A11yNode } from "./a11y.js";
import { getA11yTree } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { composeSnapshot, type ComposedSnapshot, type ComposeOptions } from "./compose.js";
import { runDomWalkOnFrame, mergeDomWalkIntoTree } from "./dom-walk.js";
import { annotateStructuralContext } from "./structural.js";
import { elementKey } from "./refs.js";

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

/** Chromium substrate — the existing CDP path, moved behind the interface
 *  VERBATIM. `compose` / `a11yTree` delegate to the exact functions the tools
 *  called inline before this seam (composeSnapshot / getA11yTree over the raw
 *  CDPSession), so the output is byte-identical and the chromium keystones are
 *  unchanged. The CDP handle is captured here once; callers never see it. */
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

/** Firefox / WebKit substrate — the page-side ARIA/DOM walker over
 *  `frame.evaluate`. No CDP. It runs the SAME PAGE_SCRIPT as the (already
 *  portable, OOPIF-safe) composeSnapshotForFrame, rooted at the main frame, and
 *  mints refs through the SAME RefRegistry / elementKey path, so a ref minted
 *  here is the same shape (and stable across snapshots) as a chromium DOM-walk
 *  ref.
 *
 *  Tree shape: a synthetic `WebArea` root with the walker's interactive /
 *  test-attribute-bearing elements as leaf children — identical to the
 *  composeSnapshotForFrame shape. The CDP a11y tree's deep structural nesting is
 *  not available off-Chromium (Firefox has no `Accessibility.getFullAXTree`),
 *  but find()/text_search()/extract() walk the tree flat anyway, and the ref
 *  inputs (role/name/testId/cssPath) — the find-ranking + ref-minting signal —
 *  are all present. This is the documented, benchmarked fidelity tradeoff of
 *  the hybrid approach: chromium keeps the deep AX tree; firefox gets the
 *  walker-grade tree that carries the agentic signal. */
export class PlaywrightSnapshotSubstrate implements SnapshotSubstrate {
  readonly engine: string;
  constructor(
    private readonly page: Page,
    engine = "firefox",
  ) {
    this.engine = engine;
  }

  async compose(
    refs: RefRegistry,
    testAttributes: string[],
    opts: ComposeOptions = {},
  ): Promise<ComposedSnapshot> {
    const root = this.makeRoot(refs);
    // The main frame's walk — same PAGE_SCRIPT, same `frame.evaluate` entry as
    // the child-frame path. `pierce` recurses open shadow roots; closed-shadow
    // CDP piercing is chromium-only (no off-Chromium protocol reaches closed
    // roots), so we degrade to open and warn.
    const entries = await runDomWalkOnFrame(this.page.mainFrame(), {
      testAttributes,
      pierce: opts.pierce,
    });
    const merge = mergeDomWalkIntoTree(root, entries, refs);
    annotateStructuralContext(root);

    const warnings: string[] = [
      `snapshot on the "${this.engine}" engine is DOM-walk-sourced (no CDP accessibility tree off Chromium). ` +
        `Refs are stable and find-ranking signal (role/name/[testid]) is present; the deep a11y structural ` +
        `nesting chromium emits is not. [from-dom] markers reflect the source, not a deficiency.`,
    ];
    if (opts.pierce === "closed") {
      warnings.push(
        `closed-shadow piercing is chromium-only (it needs CDP DOM.getDocument({pierce:true}), which ` +
          `${this.engine} has no protocol equivalent for). pierce: "closed" degraded to "open".`,
      );
    }
    return {
      tree: root,
      stats: {
        a11yInteractive: 0,
        domWalkEntries: entries.length,
        domWalkNew: merge.added,
        domWalkCombined: merge.combined,
        ...(opts.pierce === "closed" ? { closedShadowEntries: 0 } : {}),
      },
      warnings,
    };
  }

  async a11yTree(refs: RefRegistry, testAttributes: string[]): Promise<A11yNode | null> {
    // The pre/post action delta + watch sampling want the structural tree; off
    // Chromium that is the same walker-sourced tree compose() builds (without
    // the find-ranking warnings, which the delta path doesn't surface).
    const root = this.makeRoot(refs);
    const entries = await runDomWalkOnFrame(this.page.mainFrame(), { testAttributes });
    mergeDomWalkIntoTree(root, entries, refs);
    annotateStructuralContext(root);
    return root;
  }

  /** The synthetic main-frame root. Keyed/stable so its ref persists across
   *  snapshots exactly like the composeSnapshotForFrame root. */
  private makeRoot(refs: RefRegistry): A11yNode {
    const rootKey = elementKey({ role: "WebArea", path: "__main__" });
    const rootRef = refs.forKey(rootKey, { role: "WebArea", source: "dom" });
    return {
      ref: rootRef,
      role: "WebArea",
      name: this.page.url() || "WebArea",
      source: "dom",
      children: [],
    };
  }
}
