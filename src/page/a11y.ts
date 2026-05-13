// CDP-backed accessibility-tree extraction. playwright-core dropped page.accessibility
// so we go via CDP (Accessibility.getFullAXTree) directly. The shape we expose is
// agentic-first: a tidy tree with role/name/value/state and refs assigned by stable
// element key (see refs.ts), plus a `walk()` helper for serialiser/find() reuse.

import type { CDPSession } from "playwright-core";
import { elementKey, RefRegistry } from "./refs.js";

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
   *  discovered by both paths. Phase-1.5 ask #7 / #8 plumbing. */
  source?: "a11y" | "dom" | "both";
  /** Tag name (DOM-walk only — informational for the agent). */
  tag?: string;
  /** State flags as reported by CDP (selected subset — see fmtState). */
  disabled?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  selected?: boolean;
  expanded?: boolean;
  focused?: boolean;
  children: A11yNode[];
}

// Raw CDP shapes (subset we use).
interface RawProp { name: string; value?: { value?: unknown; type?: string }; }
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
  // backendDOMNodeId and are roles we care about (interactives). For Phase-1 we
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
      value: raw.value?.value !== undefined ? String(raw.value.value) : undefined,
      backendDOMNodeId: raw.backendDOMNodeId,
      children: [],
    };
    for (const p of raw.properties ?? []) {
      const v = p.value?.value;
      switch (p.name) {
        case "disabled": node.disabled = !!v; break;
        case "checked": node.checked = v as boolean | "mixed"; break;
        case "pressed": node.pressed = v as boolean | "mixed"; break;
        case "selected": node.selected = !!v; break;
        case "expanded": node.expanded = !!v; break;
        case "focused": node.focused = !!v; break;
        default: break;
      }
    }
    // testId attaches later in enrichTestIds if we batch-fetch attributes.
    node.ref = refs.forKey(elementKey({ role, name, path, testId: node.testId }), { role, name, testId: node.testId });
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
 * `DOM.resolveNode`+`DOM.describeNode` is simpler and Phase-1 doesn't need to be
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
      const { attributes } = (await cdp.send("DOM.getAttributes", {
        nodeId: node.backendDOMNodeId,
      })) as { attributes: string[] };
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
          refs.updateLocator(node.ref, { role: node.role, name: node.name, testId: node.testId, testIdAttr: a });
          break;
        }
      }
    } catch {
      // Node may be detached / not in DOM tree; that's fine, no testId then.
    }
  }
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "tab", "treeitem", "listbox",
]);

const STRUCTURAL_ROLES = new Set([
  "dialog", "alertdialog", "navigation", "main", "form", "search", "region",
  "tablist", "menu", "menubar", "tree", "grid", "table", "alert", "status",
]);
