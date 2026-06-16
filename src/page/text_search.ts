// `text_search` read primitive.
//
// Verification and absence checks: "is the bad value gone?" / "did 'Saved' appear?".
// Distinct from `find()` (which ranks actionable targets) — `text_search` simply
// counts matches of a text query against rendered node names, optionally scoped
// to a subtree, with structural context attached to each match.

import type { CDPSession } from "playwright-core";
import { walk, type A11yNode, type StructuralContext } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import type { SnapshotSubstrate } from "./snapshot-substrate.js";
import { visibleRect, type VisibleRect } from "./bbox.js";
import { findByRef } from "./snapshot.js";

export interface TextSearchOptions {
  text: string;
  /** Default false — substring (case-insensitive). When true, the match is
   *  case-sensitive equality on the trimmed node name. */
  exact?: boolean;
  /** Limit the search to descendants of this ref (a prior snapshot/find result). */
  scope?: string;
  /** Default false — only visible (bbox-having) matches are returned. */
  includeHidden?: boolean;
  /** Default 20; hard cap 200. */
  maxMatches?: number;
  testAttributes: string[];
}

export interface TextSearchMatch {
  ref: string;
  role: string;
  text: string;
  context?: StructuralContext;
  bbox: VisibleRect | null;
  clipped: boolean;
}

export interface TextSearchResult {
  count: number;
  matches: TextSearchMatch[];
  warnings: string[];
}

export async function textSearch(
  substrate: SnapshotSubstrate,
  refs: RefRegistry,
  opts: TextSearchOptions,
  /** Raw CDP handle for the visible-rect bbox fast path — chromium only.
   *  Off Chromium the walker mints no `backendDOMNodeId`, so this is unused and
   *  hidden/visible classification rides the bbox being null (clipped). */
  cdp?: CDPSession,
): Promise<TextSearchResult> {
  const { tree } = await substrate.compose(refs, opts.testAttributes);
  if (!tree) return { count: 0, matches: [], warnings: [] };

  const warnings: string[] = [];
  let walkRoot: A11yNode = tree;
  if (opts.scope) {
    const sub = findByRef(tree, opts.scope);
    if (sub) walkRoot = sub;
    else warnings.push(`scope=${opts.scope} not found; searching the full tree instead.`);
  }

  const max = Math.min(opts.maxMatches ?? 20, 200);
  const includeHidden = opts.includeHidden ?? false;
  const candidates = searchTreeForText(walkRoot, opts.text, opts.exact ?? false, max * 4);

  const matches: TextSearchMatch[] = [];
  for (const node of candidates) {
    if (matches.length >= max) break;
    const match = await classifyMatch(node, includeHidden, cdp);
    if (match) matches.push(match);
  }

  return { count: matches.length, matches, warnings };
}

/** Resolve one candidate node to a match, applying the visible-only filter.
 *  A node only reaches here if it's in the NON-IGNORED a11y tree (display:none /
 *  aria-hidden subtrees are pruned upstream). WITH a backendDOMNodeId a null bbox
 *  means off-screen → hidden. WITHOUT one — the AX tree omits it for many inline /
 *  StaticText nodes, which is exactly what a text query matches — we cannot prove
 *  off-screen, so we treat the rendered node as visible rather than silently
 *  dropping every plain-text match in the default mode. The `clipped` flag still
 *  records that the rect was indeterminate. */
async function classifyMatch(
  node: A11yNode,
  includeHidden: boolean,
  cdp?: CDPSession,
): Promise<TextSearchMatch | null> {
  const bbox =
    cdp !== undefined && node.backendDOMNodeId !== undefined
      ? await visibleRect(cdp, node.backendDOMNodeId)
      : null;
  const hasBackendId = cdp !== undefined && node.backendDOMNodeId !== undefined;
  const visible = hasBackendId ? bbox !== null : true;
  if (!visible && !includeHidden) return null;
  const match: TextSearchMatch = {
    ref: node.ref,
    role: node.role,
    text: node.name ?? "",
    bbox,
    clipped: !visible,
  };
  if (node.context) match.context = node.context;
  return match;
}

/**
 * Pure-tree search: walk `root` and return nodes whose `name` matches `text`.
 * Exported for unit testing.
 *
 * @param max  hard cap on the *walked* candidate count (post-filter list is
 *             capped separately at the caller's `maxMatches`).
 */
export function searchTreeForText(
  root: A11yNode,
  text: string,
  exact: boolean,
  max: number = 200,
): A11yNode[] {
  const out: A11yNode[] = [];
  const target = text;
  const targetLower = text.toLowerCase();
  for (const { node } of walk(root)) {
    const name = (node.name ?? "").trim();
    if (!name) continue;
    const hit = exact ? name === target : name.toLowerCase().includes(targetLower);
    if (hit) {
      out.push(node);
      if (out.length >= max) break;
    }
  }
  return out;
}
