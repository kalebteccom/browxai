// Shadow-tree summarisation — the `shadow_trees` consumer.
//
// Two depth-1 summarisers over the shadow boundary:
//   1. CDP path (`collectShadowTrees`) — walks the already-pierced document
//      from `fetchPiercedDocument` and surfaces both open AND closed roots.
//   2. Page-side path (`runOpenShadowWalk`) — an in-page `Runtime.evaluate`
//      walker for the OPEN-only case, Chromium-version-agnostic and cheaper
//      (no full-document serialisation).
//
// Both emit the same `ShadowTreeEntry[]` shape so the tool surface is uniform.
// The closed-shadow ELEMENT harvest (compose.ts consumer) lives in its
// sibling `shadow-harvest.ts`; the `CdpDomNode` / `fetchPiercedDocument` /
// `findByBackendId` core both consumers share stays in `shadow.ts`.
//
// Everything in this file is read-only.

import type { CDPSession } from "playwright-core";
import { type CdpDomNode, findByBackendId } from "./shadow-core.js";

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

/** Summarise the element children of one shadow root (tag + child count + direct
 *  text), skipping non-element nodes. */
function summariseShadowChildren(sr: CdpDomNode): ShadowChildSummary[] {
  const children: ShadowChildSummary[] = [];
  for (const c of sr.children ?? []) {
    if (c.nodeType !== 1) continue;
    const summary: ShadowChildSummary = {
      tag: (c.localName ?? c.nodeName ?? "").toLowerCase(),
      childCount: countElementChildren(c),
    };
    const txt = directText(c);
    if (txt) summary.text = txt;
    children.push(summary);
  }
  return children;
}

/** Build the `ShadowTreeEntry` for one host node + shadow root (non-user-agent). */
function buildShadowEntry(host: CdpDomNode, sr: CdpDomNode): ShadowTreeEntry {
  return {
    hostRef: `backend:${host.backendNodeId ?? 0}`,
    hostTag: (host.localName ?? host.nodeName ?? "").toLowerCase(),
    mode: sr.shadowRootType === "closed" ? "closed" : "open",
    children: summariseShadowChildren(sr),
    descendantCount: countDescendantElements(sr),
  };
}

function walkForShadowHosts(node: CdpDomNode, out: ShadowTreeEntry[], cap: number): void {
  // BFS so we surface hosts in document order — easier for an agent to reason
  // about than DFS's reverse traversal.
  const queue: CdpDomNode[] = [node];
  while (queue.length && out.length < cap) {
    const n = queue.shift()!;
    for (const sr of n.shadowRoots ?? []) {
      if (out.length >= cap) break;
      // user-agent shadow roots (e.g. <video> internals) aren't the adopter's
      // app — not what an agent means by "the shadow root under this component."
      if (sr.shadowRootType === "user-agent") continue;
      out.push(buildShadowEntry(n, sr));
      for (const c of sr.children ?? []) queue.push(c); // descend for nested hosts
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
