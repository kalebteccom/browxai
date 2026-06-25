// Closed-shadow element harvesting — the `compose.ts` consumer.
//
// Where `shadow-trees.ts` *summarises* the shadow boundary depth-1, this file
// reaches deeper: it harvests interactive / test-attr-bearing ELEMENTS from
// CLOSED shadow roots so they can flow into compose's element registry. Only
// closed roots are entered here — the page-side `runDomWalk` already covers
// open shadow, and entering twice would mint duplicate registry keys whose
// `[from-dom]` / `[from-both]` evidence would then lose its meaning.
//
// The `CdpDomNode` / `fetchPiercedDocument` core this shares with the
// summariser lives in `shadow.ts`.
//
// Everything in this file is read-only.

import type { CDPSession } from "playwright-core";
import { type CdpDomNode, fetchPiercedDocument } from "./shadow-core.js";

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

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea"]);

/** Predicate mirroring PAGE_SCRIPT in dom-walk.ts: a node with a role, a standard
 *  interactive tag, or an interaction attribute is interactive. */
function isInteractiveNode(tag: string, attrMap: Map<string, string>): boolean {
  return (
    attrMap.has("role") ||
    INTERACTIVE_TAGS.has(tag) ||
    (tag === "a" && attrMap.has("href")) ||
    attrMap.has("onclick") ||
    attrMap.has("tabindex") ||
    attrMap.get("contenteditable") === "true"
  );
}

/** Build a closed-shadow entry. Closed shadow has no addressable selector from
 *  the page side, so the synthetic `structuralPath` documents the boundary (the
 *  selectorHint then emits `tier 5` role-only and the agent sees why it isn't
 *  actionable). */
function buildClosedShadowEntry(
  n: CdpDomNode,
  tag: string,
  attrMap: Map<string, string>,
  testIdEntry: { attr: string; value: string } | null,
  index: number,
): ClosedShadowDomEntry {
  return {
    role: attrMap.get("role") || tag,
    name: nameFromAttrs(attrMap),
    testId: testIdEntry?.value ?? "",
    testIdAttr: testIdEntry?.attr ?? "",
    tag,
    id: attrMap.get("id") ?? "",
    structuralPath: `closed-shadow/${tag}[${index}]`,
    cssPath: "",
    closedShadow: true,
  };
}

function harvestSubtree(
  root: CdpDomNode,
  testAttrs: string[],
  out: ClosedShadowDomEntry[],
  max: number,
): void {
  const stack: CdpDomNode[] = [...(root.children ?? [])];
  while (stack.length && out.length < max) {
    const n = stack.pop()!;
    if (n.nodeType !== 1) continue;
    const tag = (n.localName ?? n.nodeName ?? "").toLowerCase();
    const attrMap = readAttrs(n);
    const testIdEntry = firstTestAttr(attrMap, testAttrs);
    if (isInteractiveNode(tag, attrMap) || testIdEntry) {
      out.push(buildClosedShadowEntry(n, tag, attrMap, testIdEntry, out.length));
    }
    pushHarvestChildren(stack, n);
  }
}

/** Push a node's element children + its open/closed shadow-root children onto
 *  the harvest stack (user-agent shadow roots are skipped). */
function pushHarvestChildren(stack: CdpDomNode[], n: CdpDomNode): void {
  for (const c of n.children ?? []) stack.push(c);
  for (const sr of n.shadowRoots ?? []) {
    if (sr.shadowRootType === "open" || sr.shadowRootType === "closed") {
      for (const c of sr.children ?? []) stack.push(c);
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
