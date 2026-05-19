// Compose the a11y tree + the DOM-walk fallback into a single tree.
// Phase-1.5 .
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

import type { CDPSession } from "playwright-core";
import { getA11yTree, walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { runDomWalk, mergeDomWalkIntoTree } from "./dom-walk.js";
import { annotateStructuralContext } from "./structural.js";
import { LOW_A11Y_THRESHOLD } from "../util/config.js";

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "tab", "treeitem",
]);

export interface ComposedSnapshot {
  /** The combined tree. Root is the a11y root; DOM-walk leaves are appended as children. */
  tree: A11yNode | null;
  /** Counts and source mix — useful for the low-content warning + debugging. */
  stats: {
    a11yInteractive: number;
    domWalkEntries: number;
    domWalkNew: number;
    domWalkCombined: number;
  };
  /** Phase-1.5 warnings — currently #11 (low-content) when a11y is sparse. */
  warnings: string[];
}

export async function composeSnapshot(
  cdp: CDPSession,
  refs: RefRegistry,
  testAttributes: string[],
): Promise<ComposedSnapshot> {
  const a11y = await getA11yTree(cdp, refs, testAttributes).catch(() => null);
  if (a11y) markSource(a11y, "a11y");

  const a11yInteractive = a11y ? countInteractive(a11y) : 0;
  const entries = await runDomWalk(cdp, { testAttributes });
  const merge = a11y
    ? mergeDomWalkIntoTree(a11y, entries, refs)
    : { added: 0, combined: 0 };

  // After merging a11y + DOM-walk, tag descendants of repeated containers
  // with their structural neighbourhood (row/column/rowText). Cheap O(n)
  // pass; callers like `find()` ship these annotations as candidate
  // evidence and 's container-probe references them.
  if (a11y) annotateStructuralContext(a11y);

  const warnings: string[] = [];
  if (a11yInteractive < LOW_A11Y_THRESHOLD) {
    warnings.push(
      `low-content a11y tree (${a11yInteractive} interactive descendants under root); ` +
      `the DOM-walk fallback supplied ${merge.added} new node(s) (${entries.length} total candidates seen). ` +
      `Heavy SPAs with non-semantic markup often surface useful state through the DOM-walk source — ` +
      `use [from-dom]-marked entries with their [testid=…] hints when present.`,
    );
  }
  return {
    tree: a11y,
    stats: {
      a11yInteractive,
      domWalkEntries: entries.length,
      domWalkNew: merge.added,
      domWalkCombined: merge.combined,
    },
    warnings,
  };
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
