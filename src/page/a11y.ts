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
      // Appended one at a time, not spread: an ignored wrapper over a very wide
      // list splices its whole child list into this call, and a spread of more
      // than ~65k elements overflows the argument stack.
      for (const n of convert(c, `${path}/${c.role?.value ?? "generic"}[${i}]`, depth + 1)) {
        out.push(n);
      }
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

/** A `DOM.Node`, the subset the attribute sweep reads. Children hang off five
 *  different fields; missing any of them loses a whole subtree. */
interface RawDomNode {
  backendNodeId?: number;
  /** Flat `["name", "value", "name", "value", …]`. */
  attributes?: string[];
  children?: RawDomNode[];
  shadowRoots?: RawDomNode[];
  pseudoElements?: RawDomNode[];
  contentDocument?: RawDomNode;
  templateContent?: RawDomNode;
}

/** Containment ceiling on the DOM sweep, in the spirit of `MAX_WALK_DEPTH`. The
 *  heaviest page measured here (Wikipedia's GDP list) returns ~30k nodes, so
 *  this never trips on a real document; it bounds a malformed or adversarial
 *  one. */
const MAX_DOM_SWEEP_NODES = 500_000;

/** The first configured test attribute this element carries, in the caller's
 *  preference order. */
function firstTestAttr(
  attributes: string[],
  attrs: string[],
): { testId: string; testIdAttr: string } | undefined {
  for (const a of attrs) {
    for (let i = 0; i < attributes.length; i += 2) {
      if (attributes[i] === a && attributes[i + 1]) {
        return { testId: attributes[i + 1]!, testIdAttr: a };
      }
    }
  }
  return undefined;
}

/**
 * Every element carrying one of the configured test attributes, keyed by
 * **backend** node id — the id `Accessibility.getFullAXTree` reports.
 *
 * One `DOM.getDocument` roundtrip returns the whole tree with attributes
 * inline. The per-node `DOM.getAttributes` loop this replaced passed a
 * `BackendNodeId` where the command wants a `DOM.NodeId`, and nothing had ever
 * called `DOM.getDocument`, so no `DOM.NodeId` existed in the session at all:
 * on a GitHub pull-request page all 159 calls failed with
 * `Could not find node` and zero test ids were attached. Measured against the
 * two working alternatives on four real pages, the sweep is also the cheap one
 * — 9-39 ms, against 327-1932 ms for
 * `DOM.pushNodesByBackendIdsToFrontend` plus a `DOM.getAttributes` per node.
 *
 * The sweep does not pierce. Shadow roots and iframe content documents are
 * reached only when a caller opts into `pierce`, and that opt-in is what gates
 * closed-shadow content from reaching the agent at all; a test attribute read
 * out of a closed shadow root here would route around it. So an element inside
 * a shadow root keeps no test id on the a11y tier — the DOM-walk tier under
 * `includeShadow: "open"` is the path that reports one.
 */
async function readTestAttributes(
  cdp: CDPSession,
  attrs: string[],
): Promise<Map<number, { testId: string; testIdAttr: string }>> {
  const found = new Map<number, { testId: string; testIdAttr: string }>();
  let root: RawDomNode;
  try {
    ({ root } = (await cdp.send("DOM.getDocument", { depth: -1 })) as {
      root: RawDomNode;
    });
  } catch {
    // No DOM agent (detached target, mid-navigation) — no test ids this pass.
    return found;
  }
  const stack: RawDomNode[] = [root];
  let visited = 0;
  while (stack.length && visited < MAX_DOM_SWEEP_NODES) {
    const n = stack.pop()!;
    visited++;
    if (n.backendNodeId !== undefined && n.attributes?.length) {
      const hit = firstTestAttr(n.attributes, attrs);
      if (hit) found.set(n.backendNodeId, hit);
    }
    for (const c of n.children ?? []) stack.push(c);
    for (const c of n.shadowRoots ?? []) stack.push(c);
    for (const c of n.pseudoElements ?? []) stack.push(c);
    if (n.contentDocument) stack.push(n.contentDocument);
    if (n.templateContent) stack.push(n.templateContent);
  }
  return found;
}

/**
 * Attach the configured test-attribute value to the roles an agent acts on, and
 * refresh the registry's locator inputs so `locatorFor` resolves the ref through
 * the tier-1 `[data-testid=…]` selector rather than role+name.
 *
 * The ref's stable key is NOT recomputed. The key was minted in document
 * pre-order before the sweep ran, and re-keying here would rotate the ref of
 * every test-attribute-bearing node on the snapshot that first attached one —
 * the opposite of what a ref is for.
 */
async function enrichTestIds(
  cdp: CDPSession,
  root: A11yNode,
  attrs: string[],
  refs: RefRegistry,
): Promise<void> {
  const wanted: A11yNode[] = [];
  for (const { node } of walk(root)) {
    if (node.backendDOMNodeId === undefined) continue;
    // Only enrich roles the agent's likely to act on (interactive / structural).
    if (!INTERACTIVE_ROLES.has(node.role) && !STRUCTURAL_ROLES.has(node.role)) continue;
    wanted.push(node);
  }
  if (!wanted.length) return;
  const byBackendId = await readTestAttributes(cdp, attrs);
  if (!byBackendId.size) return;
  for (const node of wanted) {
    const hit = byBackendId.get(node.backendDOMNodeId!);
    if (!hit) continue;
    node.testId = hit.testId;
    node.testIdAttr = hit.testIdAttr;
    refs.augmentLocator(node.ref, { testId: hit.testId, testIdAttr: hit.testIdAttr });
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
