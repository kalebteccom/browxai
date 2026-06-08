// Phase 7 — Shadow DOM deep piercing.
//
// Two layers:
//   1. Open shadow — reachable from page-side JS via `Element.shadowRoot`.
//      A `Runtime.evaluate`-driven walker covers this case identically to the
//      one in `dom-export.ts`'s jsonl path.
//   2. Closed shadow — `Element.shadowRoot === null` for any closed-mode
//      web component, but DevTools-level access via `DOM.getDocument({pierce:
//      true, depth: -1})` returns the closed-shadow subtree in each node's
//      `shadowRoots[]` array (CDP exposes both open + closed; the page-side
//      JS only ever sees open).
//
// Best-effort by design:
//   - CDP `pierce` is a Chromium DevTools facility, not a web-platform
//     guarantee. Older Chrome builds, non-Chromium browsers, and pages whose
//     renderer is throttled / detached will fall back to the open-only view
//     and surface a `closedShadowAvailable: false` flag.
//   - Closed shadow piercing is intentionally one-way: we read what CDP
//     exposes. We never reach in via the page itself (which would require
//     patching `attachShadow` before the page loaded — out of scope; the
//     `stealth` capability already covers that direction for adjacent reasons).
//
// Everything in this file is read-only.

import type { CDPSession } from "playwright-core";

/** One shadow-tree-entry surfaced by `shadow_trees`. */
export interface ShadowTreeEntry {
  /** The host element's `ref` (from a prior `snapshot` / `find`) when the
   *  registry knows it; otherwise the CDP `backendNodeId` rendered as
   *  `"backend:<n>"` so an agent can correlate against `inspect()` output. */
  hostRef: string;
  /** Host element tag (lowercased). */
  hostTag: string;
  /** Shadow root mode as CDP reports it. */
  mode: "open" | "closed";
  /** Direct children of the shadow root (depth-1 summary — keeps the output
   *  token-bounded). Use `dom_export({includeShadow:true})` for the full
   *  recursive dump. */
  children: ShadowChildSummary[];
  /** Total descendant element count under the shadow root, including nested
   *  shadow subtrees we descended into. Cheap heuristic for "is this a
   *  thin wrapper or a whole sub-app?" */
  descendantCount: number;
}

export interface ShadowChildSummary {
  tag: string;
  /** Short text label — first non-empty `textContent`-equivalent slice
   *  (capped at 80 chars). Null when the element carries no direct text. */
  text?: string;
  /** Element child count of *this* shadow child (one level deep — same
   *  shape as `Element.childElementCount`). Lets the caller decide whether
   *  to drill in via `dom_export`. */
  childCount: number;
}

export interface ShadowTreesOptions {
  /** Backend node id of the host to limit the walk to. When omitted, walks
   *  the entire document and returns every shadow root it finds. */
  rootBackendNodeId?: number;
  /** Hard cap on returned hosts. Default 200 — enough for typical
   *  shadow-heavy pages, bounded enough to keep tokens predictable. */
  maxHosts?: number;
}

export interface ShadowTreesResult {
  trees: ShadowTreeEntry[];
  /** `true` when CDP's `pierce:true` view of the document came back with
   *  at least one closed-mode root (proves the closed-shadow path is live
   *  on this browser/page). `false` is informational — the page may simply
   *  not contain a closed root, or CDP refused the call. */
  closedShadowAvailable: boolean;
  /** Non-fatal warnings — e.g. CDP fell through to open-only, the host
   *  ref didn't resolve, we hit the `maxHosts` cap. */
  warnings: string[];
}

/** CDP `DOM.Node` subset we care about. Fields are optional — different
 *  Chromium versions populate different ones. */
interface CdpDomNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  localName?: string;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  shadowRootType?: "open" | "closed" | "user-agent";
  contentDocument?: CdpDomNode;
  textValue?: string;
  nodeValue?: string;
}

/**
 * Read the full pierced DOM. Returns the root node and a "closed shadow root
 * exists somewhere" flag. Falls back to an open-only document when CDP refuses
 * the `pierce` parameter (older Chromium, attached BYOB endpoints whose CDP
 * vintage differs from the launcher's). Caller is responsible for treating a
 * `null` result as "shadow walk unavailable" — no exception is thrown so the
 * outer tool can still emit a partial result.
 */
export async function fetchPiercedDocument(
  cdp: CDPSession,
): Promise<{ root: CdpDomNode | null; closedAvailable: boolean; warning?: string }> {
  // depth: -1 = walk full subtree. pierce: true = traverse shadow + iframes.
  try {
    const { root } = (await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as { root: CdpDomNode };
    return { root, closedAvailable: hasClosedShadow(root) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      root: null,
      closedAvailable: false,
      warning:
        `CDP DOM.getDocument({pierce:true}) failed (${msg}); ` +
        `closed-shadow piercing unavailable on this browser/page. ` +
        `Open shadow roots are still reachable via the standard walk.`,
    };
  }
}

function hasClosedShadow(root: CdpDomNode): boolean {
  // Iterative DFS to avoid stack blow-up on large documents.
  const stack: CdpDomNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    for (const sr of n.shadowRoots ?? []) {
      if (sr.shadowRootType === "closed") return true;
      stack.push(sr);
    }
    for (const c of n.children ?? []) stack.push(c);
    if (n.contentDocument) stack.push(n.contentDocument);
  }
  return false;
}

/**
 * Walk a CDP-pierced document and collect shadow-root entries. When
 * `rootBackendNodeId` is set, only the subtree rooted at that backend id
 * contributes. When omitted, the entire document is walked.
 */
export function collectShadowTrees(
  root: CdpDomNode,
  opts: ShadowTreesOptions,
): { entries: ShadowTreeEntry[]; cappedAt?: number } {
  const cap = opts.maxHosts ?? 200;
  let subtree: CdpDomNode | null = root;
  if (opts.rootBackendNodeId !== undefined) {
    subtree = findByBackendId(root, opts.rootBackendNodeId);
    if (!subtree) return { entries: [] };
  }
  const entries: ShadowTreeEntry[] = [];
  walkForShadowHosts(subtree, entries, cap);
  if (entries.length >= cap) return { entries, cappedAt: cap };
  return { entries };
}

function findByBackendId(root: CdpDomNode, target: number): CdpDomNode | null {
  const stack: CdpDomNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.backendNodeId === target) return n;
    for (const c of n.children ?? []) stack.push(c);
    for (const sr of n.shadowRoots ?? []) stack.push(sr);
    if (n.contentDocument) stack.push(n.contentDocument);
  }
  return null;
}

function walkForShadowHosts(node: CdpDomNode, out: ShadowTreeEntry[], cap: number): void {
  // BFS so we surface hosts in document order — easier for an agent to
  // reason about than DFS's reverse traversal.
  const queue: CdpDomNode[] = [node];
  while (queue.length && out.length < cap) {
    const n = queue.shift()!;
    for (const sr of n.shadowRoots ?? []) {
      if (out.length >= cap) break;
      // user-agent shadow roots (e.g. <video> internals) are not the
      // adopter's app — skip them. They're not what an agent means by
      // "the shadow root under this web component."
      if (sr.shadowRootType === "user-agent") continue;
      const mode = sr.shadowRootType === "closed" ? "closed" : "open";
      const children: ShadowChildSummary[] = [];
      for (const c of sr.children ?? []) {
        if (c.nodeType !== 1) continue;
        const tag = (c.localName ?? c.nodeName ?? "").toLowerCase();
        const summary: ShadowChildSummary = {
          tag,
          childCount: countElementChildren(c),
        };
        const txt = directText(c);
        if (txt) summary.text = txt;
        children.push(summary);
      }
      out.push({
        hostRef: `backend:${n.backendNodeId ?? 0}`,
        hostTag: (n.localName ?? n.nodeName ?? "").toLowerCase(),
        mode,
        children,
        descendantCount: countDescendantElements(sr),
      });
      // Descend into the shadow root to find nested shadow hosts.
      for (const c of sr.children ?? []) queue.push(c);
    }
    for (const c of n.children ?? []) queue.push(c);
    if (n.contentDocument) queue.push(n.contentDocument);
  }
}

function directText(node: CdpDomNode): string | undefined {
  for (const c of node.children ?? []) {
    if (c.nodeType === 3 && c.nodeValue) {
      const t = c.nodeValue.replace(/\s+/g, " ").trim();
      if (t) return t.length > 80 ? `${t.slice(0, 79)}…` : t;
    }
  }
  return undefined;
}

function countElementChildren(node: CdpDomNode): number {
  let n = 0;
  for (const c of node.children ?? []) if (c.nodeType === 1) n++;
  return n;
}

function countDescendantElements(node: CdpDomNode): number {
  let n = 0;
  const stack: CdpDomNode[] = [...(node.children ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.nodeType === 1) {
      n++;
      for (const cc of c.children ?? []) stack.push(cc);
      for (const sr of c.shadowRoots ?? []) stack.push(sr);
    }
  }
  return n;
}

/**
 * In-page walker for the OPEN-shadow case. This is the fast path used when
 * `pierce: "open"` is requested — no CDP `pierce:true` call needed,
 * Chromium-version-independent. Returns the same `ShadowTreeEntry[]` shape as
 * the closed-aware walker so the tool surface is uniform.
 *
 * Run as a `Runtime.evaluate` — kept ES5-ish so it survives every Chromium
 * vintage the project supports.
 */
const OPEN_SHADOW_WALK = `function(rootSel, max) {
  var roots = [];
  var queue = [];
  if (rootSel) {
    try {
      var seed = document.querySelector(rootSel);
      if (seed) queue.push(seed);
    } catch (_) { return { trees: [] }; }
  } else if (document.documentElement) {
    queue.push(document.documentElement);
  }
  function directText(el) {
    var t = '';
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) t += kids[i].nodeValue || '';
    }
    t = t.replace(/\\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 80 ? t.slice(0, 79) + '…' : t;
  }
  function descendantCount(root) {
    var n = 0;
    var stack = [];
    for (var i = 0; i < root.children.length; i++) stack.push(root.children[i]);
    while (stack.length) {
      var c = stack.pop();
      n++;
      for (var j = 0; j < c.children.length; j++) stack.push(c.children[j]);
      if (c.shadowRoot) {
        var skids = c.shadowRoot.children;
        for (var k = 0; k < skids.length; k++) stack.push(skids[k]);
      }
    }
    return n;
  }
  while (queue.length && roots.length < max) {
    var n = queue.shift();
    if (n.nodeType !== 1) continue;
    if (n.shadowRoot) {
      var children = [];
      var skids = n.shadowRoot.children;
      for (var i = 0; i < skids.length; i++) {
        var c = skids[i];
        var txt = directText(c);
        var entry = { tag: c.tagName.toLowerCase(), childCount: c.children.length };
        if (txt) entry.text = txt;
        children.push(entry);
      }
      roots.push({
        hostTag: n.tagName.toLowerCase(),
        mode: 'open',
        children: children,
        descendantCount: descendantCount(n.shadowRoot)
      });
      var sk = n.shadowRoot.children;
      for (var j = 0; j < sk.length; j++) queue.push(sk[j]);
    }
    var kids = n.children;
    for (var m = 0; m < kids.length; m++) queue.push(kids[m]);
  }
  return { trees: roots };
}`;

/** Page-side counterpart for `shadow_trees` when only open shadow piercing
 *  is needed. Cheaper than the CDP `pierce:true` path (no full-document
 *  serialisation) and entirely Chromium-version-agnostic. The `hostRef`
 *  field is filled in by the caller (the registry is server-side). */
export async function runOpenShadowWalk(
  cdp: CDPSession,
  rootSelector: string | undefined,
  max: number,
): Promise<Array<Omit<ShadowTreeEntry, "hostRef">>> {
  const rootArg = rootSelector ? JSON.stringify(rootSelector) : "null";
  const expr = `(${OPEN_SHADOW_WALK})(${rootArg}, ${max})`;
  try {
    const { result } = (await cdp.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: false,
    })) as { result: { value?: { trees: Array<Omit<ShadowTreeEntry, "hostRef">> } } };
    return result.value?.trees ?? [];
  } catch {
    return [];
  }
}

/**
 * A pseudo-DOM-walk entry for an interactive element discovered inside a
 * CLOSED shadow root via the CDP pierce path. Same shape as the open-side
 * `DomWalkEntry` so it can flow through `mergeDomWalkIntoTree` without a
 * second path. Locator fields (`cssPath`) are best-effort — the host's
 * `data-browx-host` data-id-style attribute would let us address closed-
 * shadow elements deterministically, but the live page rarely carries
 * such markers. We surface `tag` + (when present) any test attribute we
 * recognise; agents can act on these via `find()` on the test-attr value
 * (`[data-testid="…"]:visible` works through Playwright's normal
 * locator engine because Playwright auto-pierces open shadow only —
 * closed-shadow elements remain platform-protected and CANNOT be acted on
 * by the action tools, only inspected). The result envelope warns when
 * a closed-shadow candidate is returned.
 */
export interface ClosedShadowDomEntry {
  role: string;
  name: string;
  testId: string;
  testIdAttr: string;
  tag: string;
  id: string;
  structuralPath: string;
  cssPath: string;
  /** Always `true` for these entries — drives the snapshot warning. */
  closedShadow: true;
}

/**
 * Harvest interactive / test-attr-bearing elements from CLOSED shadow roots
 * only. Open-shadow elements are skipped (the page-side `runDomWalk` already
 * covers them when `pierce: "open"` or `"closed"`). Returns an empty list +
 * no warning when CDP's `pierce` path is unavailable.
 *
 * The walker reads the CDP-pierced DOM tree and identifies closed-mode
 * shadow roots; for each, it harvests element-shaped descendants and
 * extracts the same fields the page-side walker would. Doesn't fetch
 * computed style / `getBoundingClientRect` — closed shadow can't be
 * resolved to a Playwright locator anyway, so a bbox would be a lie.
 */
export async function harvestClosedShadowElements(
  cdp: CDPSession,
  testAttrs: string[],
  maxEntries: number,
): Promise<{ entries: ClosedShadowDomEntry[]; warning?: string }> {
  const { root, warning } = await fetchPiercedDocument(cdp);
  if (!root) return { entries: [], ...(warning ? { warning } : {}) };
  const entries: ClosedShadowDomEntry[] = [];
  // Traverse: find every closed shadow root, then walk its descendants.
  // We're explicit about NOT entering open shadow roots from CDP because
  // the page-side walker has already covered them — entering twice would
  // produce duplicate entries that the registry's element-key would then
  // collapse, masking which path discovered what (the `[from-dom]` /
  // `[from-both]` evidence loses its meaning).
  const stack: CdpDomNode[] = [root];
  while (stack.length && entries.length < maxEntries) {
    const n = stack.pop()!;
    for (const sr of n.shadowRoots ?? []) {
      if (sr.shadowRootType === "closed") {
        harvestSubtree(sr, testAttrs, entries, maxEntries);
      }
      // Don't descend further into closed shadow via `stack` here — the
      // recursive harvest already covered nested closed-in-closed cases.
      // Open shadow inside closed shadow IS picked up by harvestSubtree's
      // recursion (it walks all element children).
    }
    for (const c of n.children ?? []) stack.push(c);
    if (n.contentDocument) stack.push(n.contentDocument);
  }
  return { entries };
}

function harvestSubtree(
  root: CdpDomNode,
  testAttrs: string[],
  out: ClosedShadowDomEntry[],
  max: number,
): void {
  // Predicate set mirrors PAGE_SCRIPT in dom-walk.ts: anything with role,
  // any of the standard interactive tags, or any configured test
  // attribute.
  const interactiveTags = new Set([
    "button", "a", "input", "select", "textarea",
  ]);
  const stack: CdpDomNode[] = [...(root.children ?? [])];
  while (stack.length && out.length < max) {
    const n = stack.pop()!;
    if (n.nodeType !== 1) continue;
    const tag = (n.localName ?? n.nodeName ?? "").toLowerCase();
    const attrMap = readAttrs(n);
    const role = attrMap.get("role") || tag;
    const testIdEntry = firstTestAttr(attrMap, testAttrs);
    const isInteractive =
      attrMap.has("role") ||
      interactiveTags.has(tag) ||
      (tag === "a" && attrMap.has("href")) ||
      attrMap.has("onclick") ||
      attrMap.has("tabindex") ||
      attrMap.get("contenteditable") === "true";
    if (isInteractive || testIdEntry) {
      out.push({
        role,
        name: nameFromAttrs(attrMap),
        testId: testIdEntry?.value ?? "",
        testIdAttr: testIdEntry?.attr ?? "",
        tag,
        id: attrMap.get("id") ?? "",
        // Closed shadow has no addressable selector from the page side.
        // We surface a synthetic path that documents the boundary so the
        // selectorHint emits `tier 5` (role-only) and the agent can see
        // why a closed-shadow candidate isn't actionable.
        structuralPath: `closed-shadow/${tag}[${out.length}]`,
        cssPath: "",
        closedShadow: true,
      });
    }
    for (const c of n.children ?? []) stack.push(c);
    // Recurse open shadow roots that live inside the closed boundary —
    // those are visible to anyone inside the closed component.
    for (const sr of n.shadowRoots ?? []) {
      if (sr.shadowRootType === "open") {
        for (const c of sr.children ?? []) stack.push(c);
      } else if (sr.shadowRootType === "closed") {
        // Nested closed inside closed — harvest recursively.
        for (const c of sr.children ?? []) stack.push(c);
      }
    }
  }
}

function readAttrs(n: CdpDomNode): Map<string, string> {
  const m = new Map<string, string>();
  const a = n.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) m.set(a[i]!, a[i + 1] ?? "");
  return m;
}

function firstTestAttr(
  attrs: Map<string, string>,
  testAttrs: string[],
): { attr: string; value: string } | null {
  for (const a of testAttrs) {
    const v = attrs.get(a);
    if (v) return { attr: a, value: v };
  }
  return null;
}

function nameFromAttrs(attrs: Map<string, string>): string {
  const aria = attrs.get("aria-label");
  if (aria) return aria.trim().slice(0, 120);
  const title = attrs.get("title");
  if (title) return title.trim().slice(0, 120);
  const placeholder = attrs.get("placeholder");
  if (placeholder) return placeholder.trim().slice(0, 120);
  return "";
}
