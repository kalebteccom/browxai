// Shadow DOM deep piercing — the SHARED CORE.
//
// The `CdpDomNode` shape plus the two pierced-document primitives
// (`fetchPiercedDocument`, `findByBackendId`) that both the shadow-tree
// summariser (`shadow-trees.ts`, the `shadow_trees` consumer) and the
// closed-shadow element harvest (`shadow-harvest.ts`, the `compose.ts` consumer)
// build on. It is a leaf so both consumers depend on it inward, never back
// through the `shadow.ts` barrel that re-exports them (no cycle).
//
// Best-effort by design: CDP `pierce` is a Chromium DevTools facility, not a
// web-platform guarantee. Older Chrome builds, non-Chromium browsers, and pages
// whose renderer is throttled / detached fall back to the open-only view and
// surface a `closedShadowAvailable: false` flag. Closed-shadow piercing is
// intentionally one-way: we read what CDP exposes, never reaching in via the
// page itself. Everything here is read-only.

import type { CDPSession } from "playwright-core";

/** CDP `DOM.Node` subset we care about. Fields are optional — different
 *  Chromium versions populate different ones. */
export interface CdpDomNode {
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

/** Locate the node carrying a given CDP `backendNodeId` within an
 *  already-pierced document, descending through children, shadow roots, and
 *  iframe content documents. Returns `null` when no node matches. */
export function findByBackendId(root: CdpDomNode, target: number): CdpDomNode | null {
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
