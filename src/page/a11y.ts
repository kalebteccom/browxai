// CDP-backed accessibility-tree extraction. playwright-core dropped page.accessibility
// so we go via CDP (Accessibility.getFullAXTree) directly. The shape we expose is
// agentic-first: a tidy tree with role/name/value/state and refs assigned by stable
// element key (see refs.ts), plus a `walk()` helper for serialiser/find() reuse.

import type { CDPSession } from "playwright-core";
import { elementKey, RefRegistry } from "./refs.js";

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
   *  discovered by both paths. #7 / #8 plumbing. */
  source?: "a11y" | "dom" | "both";
  /** Tag name (DOM-walk only — informational for the agent). */
  tag?: string;
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

// Raw CDP shapes (subset we use).
interface RawProp {
  name: string;
  value?: { value?: unknown; type?: string };
}
interface RawAXNode {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: RawProp[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/**
 * CDP returns AX node values as `{ type, value: unknown }`. In practice the
 * `value` is a primitive (string | number | boolean | null), but the CDP type
 * is `any` and downstream code consumes a `string | undefined`. Coerce by
 * type so a hypothetical structured value renders as JSON rather than
 * `[object Object]`.
 */
/** Map the CDP AX boolean/tri-state properties onto the node. The two tri-state
 *  props (`checked`/`pressed`) carry `boolean | "mixed"`; the rest are plain
 *  booleans. Each property is independent, so a lookup table keeps the cyclomatic
 *  complexity flat. */
const BOOL_AX_PROPS = ["disabled", "selected", "expanded", "focused"] as const;
const TRISTATE_AX_PROPS = ["checked", "pressed"] as const;
function applyAxProperties(node: A11yNode, properties: RawProp[]): void {
  for (const p of properties) {
    const v = p.value?.value;
    if ((BOOL_AX_PROPS as readonly string[]).includes(p.name)) {
      node[p.name as (typeof BOOL_AX_PROPS)[number]] = !!v;
    } else if ((TRISTATE_AX_PROPS as readonly string[]).includes(p.name)) {
      node[p.name as (typeof TRISTATE_AX_PROPS)[number]] = v as boolean | "mixed";
    }
  }
}

function stringifyAxValue(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return v;
    case "number":
    case "boolean":
    case "bigint":
      return String(v);
    case "symbol":
      return v.toString();
    default:
      return JSON.stringify(v);
  }
}

/**
 * Get the cleaned a11y tree for the current page, with refs assigned through `refs`.
 * Refs are *stable* across calls: a node that persists keeps its `eN`.
 *
 * `testIdAttributes` is the list of HTML attributes to read off the DOM node as
 * the node's `testId` (preference-order-friendly for `find()`'s selectorHint).
 * Sourced from `BROWX_TEST_ATTRIBUTES` via `resolveConfig()`; defaults to
 * `["data-testid", "data-test", "data-cy", "data-qa"]`. Order-sensitive: the
 * **first** match on a node wins. The matched attribute *name* is preserved on
 * the node as `testIdAttr` so selectorHint can emit the right selector.
 */
export async function getA11yTree(
  cdp: CDPSession,
  refs: RefRegistry,
  testIdAttributes: string[] = ["data-testid", "data-test", "data-cy", "data-qa"],
): Promise<A11yNode | null> {
  // Enable is idempotent; safe to call repeatedly.
  await cdp.send("Accessibility.enable");
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: RawAXNode[] };
  if (!nodes.length) return null;

  const byId = new Map<string, RawAXNode>(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId)) ?? nodes[0]!;

  // We resolve testId attributes per-node lazily — only the ones that have a
  // backendDOMNodeId and are roles we care about (interactives). For we
  // hold off on a batched DOM.getAttributes call and just attach testIds when
  // they show up as CDP properties; a future cycle can switch to a batch fetch
  // if the attribute coverage isn't enough.

  const convert = (raw: RawAXNode, path: string): A11yNode | null => {
    if (raw.ignored) return null;
    const role = raw.role?.value ?? "generic";
    const name = raw.name?.value;
    const node: A11yNode = {
      ref: "", // filled in below
      role,
      name,
      value: stringifyAxValue(raw.value?.value),
      backendDOMNodeId: raw.backendDOMNodeId,
      children: [],
    };
    applyAxProperties(node, raw.properties ?? []);
    // testId attaches later in enrichTestIds if we batch-fetch attributes.
    node.ref = refs.forKey(elementKey({ role, name, path, testId: node.testId }), {
      role,
      name,
      testId: node.testId,
      source: "a11y",
    });
    let i = 0;
    for (const cid of raw.childIds ?? []) {
      const c = byId.get(cid);
      if (!c) continue;
      const cv = convert(c, `${path}/${c.role?.value ?? "generic"}[${i}]`);
      if (cv) node.children.push(cv);
      i++;
    }
    return node;
  };

  const tree = convert(root, root.role?.value ?? "root");
  if (!tree) return null;
  await enrichTestIds(cdp, tree, testIdAttributes, refs);
  return tree;
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

/**
 * For nodes with a `backendDOMNodeId`, read off the configured test-attribute(s) in
 * preference order via CDP, attaching the first match to `node.testId`. Also
 * re-keys the node's ref through `refs` so the testId is part of the stable key
 * (testId-bearing nodes keep their refs across snapshots even if neighbourhood text
 * shifts).
 *
 * Batched in one `DOM.getDocument` walk would be cheaper, but per-node
 * `DOM.resolveNode`+`DOM.describeNode` is simpler and doesn't need to be
 * perf-tuned. If this dominates snapshot latency, switch to a batched approach.
 */
async function enrichTestIds(
  cdp: CDPSession,
  root: A11yNode,
  attrs: string[],
  refs: RefRegistry,
): Promise<void> {
  for (const { node } of walk(root)) {
    if (node.backendDOMNodeId === undefined) continue;
    // Only enrich roles the agent's likely to act on (interactive / structural).
    if (!INTERACTIVE_ROLES.has(node.role) && !STRUCTURAL_ROLES.has(node.role)) continue;
    try {
      const { attributes } = await cdp.send("DOM.getAttributes", {
        nodeId: node.backendDOMNodeId,
      });
      // attributes is a flat ["name", "value", "name", "value", ...] array.
      const attrMap = new Map<string, string>();
      for (let i = 0; i < attributes.length; i += 2) {
        attrMap.set(attributes[i]!, attributes[i + 1] ?? "");
      }
      for (const a of attrs) {
        const v = attrMap.get(a);
        if (v) {
          node.testId = v;
          node.testIdAttr = a;
          // Refresh the registry's locator inputs so action tools can resolve
          // the ref back to a data-testid-bearing Playwright locator.
          refs.augmentLocator(node.ref, { testId: node.testId, testIdAttr: a });
          break;
        }
      }
    } catch {
      // Node may be detached / not in DOM tree; that's fine, no testId then.
    }
  }
}

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
  "listbox",
]);

const STRUCTURAL_ROLES = new Set([
  "dialog",
  "alertdialog",
  "navigation",
  "main",
  "form",
  "search",
  "region",
  "tablist",
  "menu",
  "menubar",
  "tree",
  "grid",
  "table",
  "alert",
  "status",
]);
