// CDP-backed accessibility-tree extraction. playwright-core dropped page.accessibility
// so we go via CDP (Accessibility.getFullAXTree) directly. The shape we expose is
// agentic-first: a tidy tree with role/name/value/state and refs assigned by stable
// element key (see refs.ts), plus a `walk()` helper for serialiser/find() reuse.

import type { CDPSession } from "playwright-core";
import { elementKey, RefRegistry } from "./refs.js";

// The node shape, the walk-depth cap and the pure `walk()` live on the
// vendor-free leaf `a11y-types.ts` so the SnapshotSubstrate port can name
// `A11yNode` without reaching playwright-core through this module's CDP
// extraction. Re-exported here so every existing importer is unchanged.
export type { A11yNode, StructuralContext } from "./a11y-types.js";
export { MAX_WALK_DEPTH, walk } from "./a11y-types.js";
import type { A11yNode } from "./a11y-types.js";
import { MAX_WALK_DEPTH, walk } from "./a11y-types.js";

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

/**
 * Does this raw node contribute an entry of its own? Two reasons it doesn't —
 * either way its children still splice into its parent (see `convert`).
 *
 * `ignored`: CDP says the node is not exposed to assistive tech.
 *
 * `InlineTextBox`: Blink's per-line layout box under a `StaticText`. It carries
 * a fragment of text already on its parent, is never actionable, and on the
 * repo's own fixture page accounts for 32 of 111 a11y nodes — a ref and a
 * snapshot line each, for no signal the `StaticText` doesn't already give.
 */
function isDropped(raw: RawAXNode): boolean {
  return raw.ignored === true || raw.role?.value === "InlineTextBox";
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

  // `ignored` marks a node CDP does not expose to assistive tech — that node
  // only, not its subtree. Its children are routinely exposed and interactive:
  // real Chromium marks `<html>` and `<body>` ignored (`uninteresting`) on
  // essentially every page, and presentational wrappers (`role="presentation"`,
  // layout tables, list scaffolding) sit above real controls. So an ignored
  // node contributes no entry of its own and its converted children splice into
  // its parent, in place, in document order. An `aria-hidden` container needs
  // no special case: CDP marks its descendants ignored too, so nothing survives.
  //
  // Paths: an ignored node still contributes its `${role}[${i}]` segment even
  // though it emits no node, so a path can name a node the output doesn't
  // contain. That is the deliberate trade. The path feeds `elementKey`, and a
  // ref's whole job is to survive re-snapshotting; a wrapper flipping between
  // ignored and exposed (an `aria-hidden` toggle, a `display` change moving
  // Chromium's `uninteresting` verdict) must not re-key everything beneath it.
  // Dropping the segment would rotate every descendant ref on such a flip, and
  // `[ref=eN]` is re-resolved at action time. Sibling indices count raw
  // `childIds` positions for the same reason.
  const seen = new Set<string>();

  /** Materialise one raw node (no children) and mint its ref. */
  const materialise = (raw: RawAXNode, path: string): A11yNode => {
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
    return node;
  };

  /** Convert a raw node's children into the flat list they contribute, ignored
   *  nodes already spliced. */
  const convertChildren = (raw: RawAXNode, path: string, depth: number): A11yNode[] => {
    const out: A11yNode[] = [];
    let i = 0;
    for (const cid of raw.childIds ?? []) {
      const c = byId.get(cid);
      if (!c) continue;
      out.push(...convert(c, `${path}/${c.role?.value ?? "generic"}[${i}]`, depth + 1));
      i++;
    }
    return out;
  };

  /** What this raw node contributes to its parent: itself, or — when ignored —
   *  its surviving descendants. `seen` bounds the walk: `childIds` is a graph,
   *  so a child naming an ancestor (or claimed by two parents) would otherwise
   *  recurse without end. First visit in document order wins. `MAX_WALK_DEPTH`
   *  is the same containment ceiling `walk()` applies downstream. */
  const convert = (raw: RawAXNode, path: string, depth: number): A11yNode[] => {
    if (seen.has(raw.nodeId)) return [];
    seen.add(raw.nodeId);
    // Materialise before recursing so refs mint in document pre-order.
    const node = isDropped(raw) ? null : materialise(raw, path);
    const children = depth >= MAX_WALK_DEPTH ? [] : convertChildren(raw, path, depth);
    if (!node) return children;
    node.children = children;
    return [node];
  };

  // The root is materialised whether or not it is ignored: the tree needs
  // exactly one root, and it is the anchor `mergeDomWalkIntoTree` hangs
  // DOM-walk entries off. An ignored root serialises away anyway — the
  // serialiser drops nameless `none` / `generic` nodes.
  const rootPath = root.role?.value ?? "root";
  seen.add(root.nodeId);
  const tree = materialise(root, rootPath);
  tree.children = convertChildren(root, rootPath, 0);
  await enrichTestIds(cdp, tree, testIdAttributes, refs);
  return tree;
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
