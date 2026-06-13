// SafariClassicSnapshotSubstrate — the SnapshotSubstrate implementation for the
// real-Safari engine (RFC 0002 P4). Safari has neither CDP (the Chromium/Android
// substrate) nor a Playwright Page/Frame (the firefox/webkit walker), so it gets
// a THIRD substrate: the SAME page-side DOM-walk PAGE_SCRIPT, shipped through
// WebDriver Classic `execute/sync` instead of CDP `Runtime.evaluate` or
// Playwright `frame.evaluate`. The spike (docs/rfcs/references/07-…-plan.md §4)
// confirmed the script returns the identical `DomWalkEntry` shape under
// `execute/sync`, so this substrate mints the SAME content-hashed refs and emits
// the SAME tree shape as PlaywrightSnapshotSubstrate — refs are stable across
// substrates exactly like firefox/webkit.
//
// It depends only on a tiny IO seam (`SafariSnapshotIO`: run a script + read the
// current URL), not on the safaridriver client directly, so the page layer stays
// decoupled from the engine adapter (the adapter supplies a thin bridge).

import type { A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { elementKey } from "./refs.js";
import { runDomWalkViaExecute, mergeDomWalkIntoTree } from "./dom-walk.js";
import { annotateStructuralContext } from "./structural.js";
import type { ComposedSnapshot, ComposeOptions } from "./compose.js";
import type { SnapshotSubstrate } from "./snapshot-substrate.js";

/** The minimal IO the Safari substrate needs — run a page-context script
 *  (`execute/sync` body + args → value) and read the current document URL. The
 *  SafaridriverHybridAdapter supplies this over its `SafariWebDriverClient`. */
export interface SafariSnapshotIO {
  /** Run a function-BODY script with args mapped to `arguments`, returning its
   *  value (the WebDriver `execute/sync` contract). */
  exec(scriptBody: string, args: unknown[]): Promise<unknown>;
  /** The current document URL (the Classic substitute for `page.url()`). */
  currentUrl(): Promise<string>;
}

/** Safari substrate — the page-side DOM-walk over WebDriver Classic
 *  `execute/sync`. No CDP, no Playwright Frame. Mirrors PlaywrightSnapshotSubstrate
 *  (synthetic `WebArea` root + DOM-walk leaves), with the same documented
 *  fidelity tradeoff: refs + find-ranking signal (role/name/[testid]) are present;
 *  the deep CDP a11y nesting and closed-shadow piercing are not (no off-Chromium
 *  protocol reaches them — RFC D4). */
export class SafariClassicSnapshotSubstrate implements SnapshotSubstrate {
  readonly engine = "safari";
  constructor(private readonly io: SafariSnapshotIO) {}

  async compose(
    refs: RefRegistry,
    testAttributes: string[],
    opts: ComposeOptions = {},
  ): Promise<ComposedSnapshot> {
    const url = await this.io.currentUrl().catch(() => "");
    const root = this.makeRoot(refs, url);
    const entries = await runDomWalkViaExecute((script, args) => this.io.exec(script, args), {
      testAttributes,
      pierce: opts.pierce,
    });
    const merge = mergeDomWalkIntoTree(root, entries, refs);
    annotateStructuralContext(root);

    const warnings: string[] = [
      `snapshot on the "safari" engine is DOM-walk-sourced over WebDriver Classic execute/sync ` +
        `(Safari has no CDP accessibility tree and no Playwright frame). Refs are stable and the ` +
        `find-ranking signal (role/name/[testid]) is present; the deep a11y structural nesting ` +
        `chromium emits is not. [from-dom] markers reflect the source, not a deficiency.`,
    ];
    if (opts.pierce === "closed") {
      warnings.push(
        `closed-shadow piercing is chromium-only (it needs CDP DOM.getDocument({pierce:true})); ` +
          `safari has no protocol equivalent, so pierce: "closed" degraded to "open".`,
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
    const url = await this.io.currentUrl().catch(() => "");
    const root = this.makeRoot(refs, url);
    const entries = await runDomWalkViaExecute((script, args) => this.io.exec(script, args), {
      testAttributes,
    });
    mergeDomWalkIntoTree(root, entries, refs);
    annotateStructuralContext(root);
    return root;
  }

  /** The synthetic main-frame root — keyed/stable so its ref persists across
   *  snapshots, identical to the Playwright substrate's root. */
  private makeRoot(refs: RefRegistry, url: string): A11yNode {
    const rootKey = elementKey({ role: "WebArea", path: "__main__" });
    const rootRef = refs.forKey(rootKey, { role: "WebArea", source: "dom" });
    return {
      ref: rootRef,
      role: "WebArea",
      name: url || "WebArea",
      source: "dom",
      children: [],
    };
  }
}
