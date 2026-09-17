// Compose the a11y tree + the DOM-walk fallback into a single tree.
//  .
//
// Behaviour:
//   - Always get the a11y tree first (it carries roles, accessible names, structure).
//   - Always run the DOM walk (uniform behaviour, predictable cost — one
//     Runtime.evaluate per snapshot is cheap relative to the rest of a CDP roundtrip).
//   - Merge: DOM-walk entries become children of the root tree. Entries whose stable
//     key already matches an a11y node get `source: "both"`; entries new to the
//     registry get `source: "dom"`. The a11y nodes keep `source: "a11y"` (default).
//   - If the a11y tree has fewer than LOW_A11Y_THRESHOLD interactive descendants
//     under the root, emit a warning telling the agent the DOM-walk source carried
//     the load (#11) — most adopters interpret an empty-ish a11y tree as "page is
//     empty" rather than "a11y is sparse on this codebase." This warning closes that
//     ambiguity.

import type { CDPSession, Frame } from "playwright-core";
import { getA11yTree, walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { bindRefFrame } from "./ref-frames.js";
import {
  runDomWalk,
  runDomWalkOnFrame,
  mergeDomWalkIntoTree,
  type DomWalkEntry,
} from "./dom-walk.js";
import { annotateStructuralContext } from "./structural.js";
import { LOW_A11Y_THRESHOLD } from "../util/config.js";
import { elementKey } from "./refs.js";
import { harvestClosedShadowElements } from "./shadow.js";

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
]);

// The composed-snapshot envelope + compose options live on the vendor-free leaf
// `compose-types.ts` so the SnapshotSubstrate port can name them without
// reaching playwright-core through this module. Re-exported here so every
// existing importer is unchanged.
export type { ComposedSnapshot, ComposeOptions, SnapshotTier } from "./compose-types.js";
import type { ComposedSnapshot, ComposeOptions, SnapshotTier } from "./compose-types.js";

export async function composeSnapshot(
  cdp: CDPSession,
  refs: RefRegistry,
  testAttributes: string[],
  opts: ComposeOptions = {},
): Promise<ComposedSnapshot> {
  const a11y = await getA11yTree(cdp, refs, testAttributes).catch(() => null);
  if (a11y) markSource(a11y, "a11y");

  const a11yInteractive = a11y ? countInteractive(a11y) : 0;
  const entries = await runDomWalk(cdp, { testAttributes, pierce: opts.pierce });
  // closed-shadow elements come from a separate CDP pass.
  // Same DomWalkEntry shape; merged via the same registry path so the
  // selectorHint tier + `[from-dom]` evidence remain coherent.
  let closedEntries: DomWalkEntry[] = [];
  let closedShadowWarning: string | undefined;
  let closedShadowCount = 0;
  if (opts.pierce === "closed") {
    const harvested = await harvestClosedShadowElements(cdp, testAttributes, 500);
    closedEntries = harvested.entries.map((e) => ({
      role: e.role,
      name: e.name,
      testId: e.testId,
      testIdAttr: e.testIdAttr,
      tag: e.tag,
      id: e.id,
      structuralPath: e.structuralPath,
      cssPath: e.cssPath,
    }));
    closedShadowCount = closedEntries.length;
    closedShadowWarning = harvested.warning;
  }
  const allEntries = [...entries, ...closedEntries];
  const merge = a11y ? mergeDomWalkIntoTree(a11y, allEntries, refs) : { added: 0, combined: 0 };

  // After merging a11y + DOM-walk, tag descendants of repeated containers
  // with their structural neighbourhood (row/column/rowText). Cheap O(n)
  // pass; callers like `find()` ship these annotations as candidate
  // evidence and 's container-probe references them.
  if (a11y) annotateStructuralContext(a11y);

  const warnings: string[] = [];
  if (a11yInteractive < LOW_A11Y_THRESHOLD) {
    warnings.push(
      `low-content a11y tree (${a11yInteractive} interactive descendants under root); ` +
        `the DOM-walk fallback supplied ${merge.added} new node(s) (${allEntries.length} total candidates seen). ` +
        `Heavy SPAs with non-semantic markup often surface useful state through the DOM-walk source — ` +
        `use [from-dom]-marked entries with their [testid=…] hints when present.`,
    );
  }
  if (closedShadowWarning) warnings.push(closedShadowWarning);
  if (closedShadowCount > 0) {
    warnings.push(
      `${closedShadowCount} candidate(s) discovered inside CLOSED shadow root(s) via CDP. ` +
        `Closed-shadow elements are platform-protected — action tools (click/fill/etc) ` +
        `CANNOT reach them through Playwright's locator engine. Use them as evidence ` +
        `("this widget exists at depth N") only.`,
    );
  }
  return {
    tree: a11y,
    stats: {
      tier: resolveTier(a11yInteractive, merge.added),
      a11yInteractive,
      domWalkEntries: allEntries.length,
      domWalkNew: merge.added,
      domWalkCombined: merge.combined,
      ...(opts.pierce === "closed" ? { closedShadowEntries: closedShadowCount } : {}),
    },
    warnings,
  };
}

/**
 * Frame-scoped snapshot. Composes the snapshot for a child iframe.
 *
 * Cross-origin frames sit in their own renderer (OOPIF) — the top-level CDP
 * session's `Accessibility.getFullAXTree` is rooted at the main target and
 * doesn't reach into them. Same-origin child frames are in the same renderer
 * but CDP's per-frame a11y query path is fragile across Playwright versions.
 * Pragmatic choice: for ANY child frame we skip the CDP a11y pass and use the
 * DOM-walk only via `frame.evaluate(...)`. The DOM walk is what carries find()
 * on heavy SPAs anyway, and `frame.evaluate` is the portable, identical-
 * behaviour-across-origin entry point Playwright exposes.
 *
 * Refs minted here are bound to `frame` on the registry so subsequent
 * `locatorFor` calls route through `frame.locator(...)` rather than
 * `page.locator(...)` — actions land inside the correct OOPIF transparently.
 */
export async function composeSnapshotForFrame(
  frame: Frame,
  refs: RefRegistry,
  testAttributes: string[],
  frameId: string,
  opts: ComposeOptions = {},
): Promise<ComposedSnapshot> {
  // Synthetic root so the serialiser has a tree to walk; child-frame
  // discovery is leaf-shaped (DOM-walk produces flat entries).
  const rootKey = elementKey({
    role: "WebArea",
    name: undefined,
    path: `__frame__/${frameId}`,
    frameId,
  });
  const rootRef = refs.forKey(rootKey, { role: "WebArea", source: "dom", frameId });
  bindRefFrame(refs, rootRef, frame);
  const root: A11yNode = {
    ref: rootRef,
    role: "WebArea",
    name: frame.url() || frame.name() || `frame:${frameId}`,
    source: "dom",
    children: [],
  };

  const entries = await runDomWalkOnFrame(frame, { testAttributes, pierce: opts.pierce });
  const merge = mergeDomWalkIntoTree(root, entries, refs, { frameId, frame });
  annotateStructuralContext(root);

  const warnings: string[] = [
    `frame "${frameId}": snapshot is DOM-walk-sourced only — CDP accessibility-tree extraction is not run for child frames (OOPIF / cross-origin compatibility). [from-dom] markers reflect the source, not a deficiency.`,
  ];
  if (opts.pierce === "closed") {
    warnings.push(
      `frame "${frameId}": closed-shadow piercing via CDP is not run inside child frames (the CDP pierce path is rooted at the top target). pierce: "closed" degraded to "open" for this frame.`,
    );
  }
  return {
    tree: root,
    stats: {
      // Child frames never run the CDP a11y pass (OOPIF compatibility), so the
      // DOM walk is the only tier here by construction.
      tier: merge.added > 0 ? "dom-walk" : "empty",
      a11yInteractive: 0,
      domWalkEntries: entries.length,
      domWalkNew: merge.added,
      domWalkCombined: merge.combined,
    },
    warnings,
  };
}

/**
 * Name the tier that carried the snapshot. `domWalkNew` counts nodes only the
 * DOM walk found, so `dom-walk` means the a11y tier went dark and the fallback
 * answered anyway — the low-content warning says the same thing in prose, but a
 * caller cannot branch on prose.
 */
function resolveTier(a11yInteractive: number, domWalkNew: number): SnapshotTier {
  if (a11yInteractive > 0) return domWalkNew > 0 ? "mixed" : "a11y";
  return domWalkNew > 0 ? "dom-walk" : "empty";
}

function markSource(root: A11yNode, source: "a11y"): void {
  for (const { node } of walk(root)) {
    if (!node.source) node.source = source;
  }
}

function countInteractive(root: A11yNode): number {
  let n = 0;
  for (const { node } of walk(root)) {
    if (INTERACTIVE_ROLES.has(node.role)) n++;
  }
  return n;
}
