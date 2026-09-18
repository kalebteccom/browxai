// One `DOM.getDocument` sweep, two readers.
//
// The sweep already existed for one of them: the a11y tier reads a node's test
// attributes off it (`enrichTestIds`). The second reader is the tier join. The
// CDP accessibility tree carries a `backendDOMNodeId` on every node and the
// page-side DOM walk carries none — it runs as an injected function and sees
// DOM nodes, not CDP ids — so the two tiers had no shared identity and
// `mergeDomWalkIntoTree` appended every entry a second time. This index closes
// that gap without a second round trip: a walk entry's `cssPath` is a chain of
// `tag:nth-child(n)` segments, and walking that chain down the swept document
// lands on the element the entry describes, backend node id and all. The path
// names one element and only one: at every level it picks a single child by
// index, and the tag at that index has to match.
//
// A path is an identity only while it is exact. Two refusals keep it that way.
// Each degrades to "no match", which leaves the entry to be appended as its own
// node — the behaviour that shipped before this index existed.
//
//   - The sweep and the walk run a few milliseconds apart, so the element at a
//     path can change between them. The path pins the whole ancestor tag chain;
//     `id` and the test attribute are checked on top of it.
//   - Shadow-root content is out of scope. The sweep does not pierce (piercing
//     would route around the `includeShadow` opt-in that gates closed-shadow
//     content from reaching the agent at all), and the page walk's path for a
//     shadow-rooted element stops at the shadow boundary, so its first segment
//     is a bare tag where a light-DOM path's is `tag:nth-child(n)`. That fails
//     to parse, as does the empty path a closed-shadow entry carries.

import type { CDPSession } from "playwright-core";

/** A `DOM.Node`, the subset the sweep reads. Children hang off five different
 *  fields; missing any of them loses a whole subtree. */
interface RawDomNode {
  backendNodeId?: number;
  nodeType?: number;
  localName?: string;
  nodeName?: string;
  /** Flat `["name", "value", "name", "value", …]`. */
  attributes?: string[];
  children?: RawDomNode[];
  shadowRoots?: RawDomNode[];
  pseudoElements?: RawDomNode[];
  contentDocument?: RawDomNode;
  templateContent?: RawDomNode;
}

/** The test attribute an element carries, and which of the configured
 *  attribute names yielded it. */
export interface TestAttrHit {
  testId: string;
  testIdAttr: string;
}

/** What a DOM-walk entry claims about the element it describes, beyond its
 *  path. Checked against the swept DOM before the identity is accepted. */
export interface IdentityClaim {
  /** `id` attribute, empty string when absent. */
  id: string;
  /** Test-attribute value, empty string when absent. */
  testId: string;
  /** Test-attribute name, empty string when absent. */
  testIdAttr: string;
}

/** Containment ceiling on the sweep, in the spirit of `MAX_WALK_DEPTH`. The
 *  heaviest page measured here (Wikipedia's GDP list) returns ~30k nodes, so
 *  this never trips on a real document; it bounds a malformed or adversarial
 *  one. */
const MAX_DOM_SWEEP_NODES = 500_000;

/** One `cssPath` segment: `tag:nth-child(n)`, and nothing else. Anything the
 *  page walk did not build in that exact shape — a bare tag from a shadow
 *  boundary, a hand-written selector — fails to parse and resolves to nothing. */
const SEGMENT = /^(.+):nth-child\((\d+)\)$/;

/** Containment ceiling on one path resolution, in the spirit of
 *  `MAX_WALK_DEPTH`. A real document is rarely 60 levels deep. */
const MAX_PATH_SEGMENTS = 2000;

/** The DOM as one sweep saw it: test attributes by backend node id, and the
 *  document itself, kept so a `:nth-child` path can be walked down on demand. */
export class DomIndex {
  constructor(
    private readonly testAttrByBackendId: ReadonlyMap<number, TestAttrHit>,
    /** The `<html>` element. The page walk's paths start at its children, so
     *  this is where a resolution starts. `undefined` when nothing was swept. */
    private readonly html: RawDomNode | undefined,
    private readonly attrs: string[],
  ) {}

  /** How many elements carried a configured test attribute. Zero means the
   *  sweep found nothing to attach, or never ran. */
  get testAttrCount(): number {
    return this.testAttrByBackendId.size;
  }

  testAttrOf(backendNodeId: number): TestAttrHit | undefined {
    return this.testAttrByBackendId.get(backendNodeId);
  }

  /**
   * The backend node id of the element at `cssPath`, or `undefined` when the
   * path names no element, or names an element that disagrees with `claim`
   * about its own identity. A caller reads `undefined` as "no shared identity
   * here" and keeps the two observations separate.
   *
   * Resolved by descent rather than from a precomputed path table. The walk
   * reports at most 500 entries and a table would key every element in the
   * document — 30k long strings on Wikipedia's GDP list, built to answer 500
   * questions.
   */
  backendIdFor(cssPath: string, claim: IdentityClaim): number | undefined {
    if (!cssPath) return undefined;
    const node = this.resolve(cssPath);
    if (node?.backendNodeId === undefined) return undefined;
    const attributes = node.attributes ?? [];
    if (readAttr(attributes, "id") !== claim.id) return undefined;
    const hit = firstTestAttr(attributes, this.attrs);
    if ((hit?.testId ?? "") !== claim.testId) return undefined;
    if ((hit?.testIdAttr ?? "") !== claim.testIdAttr) return undefined;
    return node.backendNodeId;
  }

  /** Walk `cssPath` down from `<html>`, one `tag:nth-child(n)` at a time. Every
   *  segment's tag must match the element found at its index, so the path pins
   *  the whole ancestor chain and not just the leaf. */
  private resolve(cssPath: string): RawDomNode | undefined {
    let node = this.html;
    if (!node) return undefined;
    const segments = cssPath.split(" > ");
    if (segments.length > MAX_PATH_SEGMENTS) return undefined;
    for (const segment of segments) {
      const parsed = SEGMENT.exec(segment);
      if (!parsed) return undefined;
      const child = nthElementChild(node, Number(parsed[2]));
      if (!child) return undefined;
      if ((child.localName || child.nodeName || "").toLowerCase() !== parsed[1]!.toLowerCase()) {
        return undefined;
      }
      node = child;
    }
    return node;
  }
}

/** The `n`-th (1-based) ELEMENT child, matching `Element.children` and CSS
 *  `:nth-child`, both of which skip text and comment nodes. */
function nthElementChild(node: RawDomNode, n: number): RawDomNode | undefined {
  let seen = 0;
  for (const c of node.children ?? []) {
    if (c.nodeType !== 1) continue;
    if (++seen === n) return c;
  }
  return undefined;
}

/** An index over a document nobody could sweep. Every lookup misses, so every
 *  caller degrades to its no-identity path. */
export const EMPTY_DOM_INDEX = new DomIndex(new Map(), undefined, []);

/**
 * Sweep the document once and build the index.
 *
 * One `DOM.getDocument` round trip returns the whole tree with attributes
 * inline. The per-node `DOM.getAttributes` loop this replaced passed a
 * `BackendNodeId` where the command wants a `DOM.NodeId`, and nothing had ever
 * called `DOM.getDocument`, so no `DOM.NodeId` existed in the session at all:
 * on a GitHub pull-request page all 159 calls failed with `Could not find node`
 * and zero test ids were attached. Measured against the two working
 * alternatives on four real pages, the sweep is also the cheap one — 9-39 ms,
 * against 327-1932 ms for `DOM.pushNodesByBackendIdsToFrontend` plus a
 * `DOM.getAttributes` per node.
 */
export async function buildDomIndex(cdp: CDPSession, attrs: string[]): Promise<DomIndex> {
  let root: RawDomNode;
  try {
    root = (await cdp.send("DOM.getDocument", { depth: -1 })).root;
  } catch {
    // No DOM agent (detached target, mid-navigation) — no index this pass.
    return EMPTY_DOM_INDEX;
  }
  // `<html>`: the page walk's `cssPath` starts at its children, so it is where
  // a resolution starts.
  const html = (root.children ?? []).find((c) => c.nodeType === 1);
  return new DomIndex(collectTestAttrs(root, attrs), html, attrs);
}

/** Every element carrying one of the configured test attributes, keyed by
 *  **backend** node id — the id `Accessibility.getFullAXTree` reports. Covers
 *  the whole swept tree, shadow roots and content documents included, because
 *  a test attribute is worth reporting wherever it sits. */
function collectTestAttrs(root: RawDomNode, attrs: string[]): Map<number, TestAttrHit> {
  const found = new Map<number, TestAttrHit>();
  const stack: RawDomNode[] = [root];
  let visited = 0;
  while (stack.length && visited < MAX_DOM_SWEEP_NODES) {
    const n = stack.pop()!;
    visited++;
    if (n.backendNodeId !== undefined && n.attributes?.length) {
      const hit = firstTestAttr(n.attributes, attrs);
      if (hit) found.set(n.backendNodeId, hit);
    }
    pushDomChildren(n, stack);
  }
  return found;
}

function readAttr(attributes: string[], name: string): string {
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === name) return attributes[i + 1] ?? "";
  }
  return "";
}

/** The first configured test attribute this element carries, in the caller's
 *  preference order. */
function firstTestAttr(attributes: string[], attrs: string[]): TestAttrHit | undefined {
  for (const a of attrs) {
    for (let i = 0; i < attributes.length; i += 2) {
      if (attributes[i] === a && attributes[i + 1]) {
        return { testId: attributes[i + 1]!, testIdAttr: a };
      }
    }
  }
  return undefined;
}

/** A `DOM.Node`'s children hang off five different fields. Missing any one of
 *  them silently loses a whole subtree's test attributes. */
function pushDomChildren(n: RawDomNode, stack: RawDomNode[]): void {
  for (const c of n.children ?? []) stack.push(c);
  for (const c of n.shadowRoots ?? []) stack.push(c);
  for (const c of n.pseudoElements ?? []) stack.push(c);
  if (n.contentDocument) stack.push(n.contentDocument);
  if (n.templateContent) stack.push(n.templateContent);
}
