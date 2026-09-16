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
import { walk } from "./a11y-types.js";

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
