// The a11y tree vocabulary — the node shape, its structural annotation, the
// walk-depth cap, and the pure depth-first `walk()` every serialiser and
// find-ranker reuses. No CDP, no Playwright.
//
// Split out of `a11y.ts` because the SnapshotSubstrate port
// (`snapshot-substrate-types.ts`) names `A11yNode` in its `a11yTree` return
// type, and `a11y.ts` imports `CDPSession` for the `Accessibility.getFullAXTree`
// extraction that produces one. A port module that reaches playwright-core —
// even transitively, even type-only — is not a port, which is what the
// `ports-name-no-vendor-type` dependency-cruiser rule enforces. The shape and
// the walk live here; the CDP extraction stays there and re-exports both names
// so existing importers are unchanged. (RFC 0009 P1.)

// L7 (bounded everything) — the a11y tree-walk depth cap. The audit flagged
// `walk` as iterative (an explicit stack, so no native stack-overflow risk) but
// carrying NO declared depth cap: a pathological tree was bounded only by memory.
// This makes the bound explicit and tested. 2000 is far beyond any real
// accessibility tree (a deeply-nested SPA is rarely past ~60 levels), so it never
// trips in practice — it is a containment ceiling against an adversarial /
// malformed tree, matching the `secrets.ts` `depth > 8` exemplar one layer up.
// Nodes BELOW the cap are simply not descended into (the tree is truncated, not
// rejected), so the walk always terminates within `MAX_WALK_DEPTH` levels.
export const MAX_WALK_DEPTH = 2000;

/**
 * Chromium AX roles that carry text or layout and are never something an agent
 * acts on. Two families:
 *
 * Blink's text leaves — `StaticText`, `InlineTextBox`, `LineBreak`,
 * `ListMarker`. The string one carries is already the accessible name of the
 * control, heading, cell or paragraph that encloses it, so a line for each
 * repeats the page a second time. Measured across six real pages
 * (react.dev, MDN, Wikipedia, Bootstrap docs, a GitHub PR, Hacker News):
 * 8,090 of 17,710 nodes and 66,640 of ~199,000 estimated snapshot tokens.
 *
 * Layout and typography wrappers — `LayoutTable*` is Blink's verdict that a
 * `<table>` is page furniture rather than data; `Abbr`, `EmphasizedText`,
 * `StrongText`, `Ruby*`, `superscript`, `subscript` wrap text an ancestor
 * already names.
 *
 * Two consumers read this set. `find` will not rank one as a candidate:
 * `role=StaticText[name="button"]` is not a locator Playwright's engine
 * resolves, so probing one spends an auto-wait and comes back
 * `actionable: "off-screen"` about something that was never actionable, and on
 * Bootstrap's forms page five such nodes filled every candidate slot and pushed
 * the real search button out of the result. The serialiser emits no line for
 * one.
 *
 * The node stays in the tree either way — `text_search` matches against these
 * names, and dropping the subtree is the defect this branch fixed. A node
 * carrying a test attribute is exempt in both consumers: an explicit
 * `data-testid` is the author saying this element is addressed by name.
 */
export const PRESENTATIONAL_ROLES: ReadonlySet<string> = new Set([
  "StaticText",
  "InlineTextBox",
  "LineBreak",
  "ListMarker",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
  "Abbr",
  "EmphasizedText",
  "StrongText",
  "Ruby",
  "RubyAnnotation",
  "superscript",
  "subscript",
]);

/** True when the node is page furniture rather than content: a presentational
 *  role and no test attribute claiming it. */
export function isPresentational(node: Pick<A11yNode, "role" | "testId">): boolean {
  return !node.testId && PRESENTATIONAL_ROLES.has(node.role);
}

export interface A11yNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  /** CDP node IDs to resolve back into actions / element handles. */
  backendDOMNodeId?: number;
  /** Test-attribute value if we found one (`data-testid` etc.). */
  testId?: string;
  /** Attribute *name* that yielded `testId` — preserves which convention matched. */
  testIdAttr?: string;
  /** Where this node came from. Default = "a11y" for the CDP-a11y path; "dom" for the
   *  DOM-walk fallback (see dom-walk.ts) and "both" when a node was independently
   *  discovered by both paths in the same snapshot. "both" is currently
   *  unreachable — the two tiers key refs on different vocabularies, so they
   *  never land on the same ref (see `mergeDomWalkIntoTree`). It used to appear
   *  on every DOM-walk node from the second snapshot on, which meant only that
   *  the ref registry had seen the key before. */
  source?: "a11y" | "dom" | "both";
  /** Tag name (DOM-walk only — informational for the agent). */
  tag?: string;
  /** Positional CSS path (DOM-walk only). The DOM-walk reports an element's bare
   *  tag in `role`, so a role-based locator built from such a node is often one
   *  Playwright cannot resolve; this is the resolvable last-resort locator. */
  cssPath?: string;
  /** `<a>` / `<area>` carries an `href` attribute (DOM-walk only). Discriminates the
   *  implicit ARIA role the bare tag can't — see `effectiveAriaRole`. */
  hasHref?: boolean;
  /** Lowercased `<input type>` (DOM-walk only). Same purpose as `hasHref`. */
  inputType?: string;
  /**  selectorHint tier-4 source: HTML `id=` attribute if present. */
  id?: string;
  /**  selectorHint tier-3 source: trimmed text content (truncated, single-line),
   *  set when distinct from `name` and stable-looking. DOM-walk fills this in. */
  text?: string;
  /** State flags as reported by CDP (selected subset — see fmtState). */
  disabled?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  selected?: boolean;
  expanded?: boolean;
  focused?: boolean;
  /** Structural neighbourhood when this node lives inside a repeated container
   *  (table row, listitem, repeated card). Populated by `annotateStructuralContext`
   *  during snapshot composition; null when the node isn't in a recognised
   *  repeated structure. */
  context?: StructuralContext;
  children: A11yNode[];
}

/**
 * Structural neighbourhood metadata for nodes living in repeated layouts.
 * Lets callers answer "what row/column is this in?" without re-walking the
 * tree themselves. Detection is generic — driven by semantic ARIA roles
 * (`table` / `row` / `cell` / `columnheader`, `list` / `listitem`, etc.),
 * not by app-specific markers.
 */
export interface StructuralContext {
  /** Role of the collection this node sits inside. Typical values: `table`,
   *  `grid`, `list`, `feed`, or `<row-role>-list` when the parent role isn't
   *  one of the canonical collection roles. */
  collection: string;
  /** Best-effort identifier for the row/item — the first non-empty visible
   *  text within the row, capped. Stable enough to disambiguate sibling rows
   *  by display label. */
  rowKey?: string;
  /** Column header text (from the table's header row, aligned by cell index).
   *  Populated only for semantic-table / grid descendants. */
  column?: string;
  /** Concatenated visible text of the entire row, capped at 200 chars.
   *  Cheap "what does this row say overall?" probe for the caller. */
  rowText?: string;
}

/**
 * Walk a tree depth-first, yielding (node, depth) pairs. Used by serialiser + find().
 */
export function* walk(root: A11yNode): Generator<{ node: A11yNode; depth: number }> {
  const stack: Array<{ node: A11yNode; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length) {
    const next = stack.pop()!;
    yield next;
    // L7: bounded depth — children below MAX_WALK_DEPTH are not pushed, so a
    // pathological tree is truncated at the cap rather than walked to exhaustion.
    // Real trees are orders of magnitude shallower, so this never truncates in
    // practice; it is the containment ceiling the bounded-resource test pins.
    if (next.depth >= MAX_WALK_DEPTH) continue;
    for (let i = next.node.children.length - 1; i >= 0; i--) {
      stack.push({ node: next.node.children[i]!, depth: next.depth + 1 });
    }
  }
}
