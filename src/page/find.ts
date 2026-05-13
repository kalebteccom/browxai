// find(query) — natural-language element description → ranked candidate locators
// with structured evidence. First-consumer asks #4 + #5: selectorHint follows a
// fixed preference order with a stability flag; bbox is the visible-rect.

import type { CDPSession } from "playwright-core";
import { getA11yTree, walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { visibleRect, type VisibleRect } from "./bbox.js";

export interface FindCandidate {
  ref: string;
  role: string;
  name?: string;
  testId?: string;
  /** "high" = tier-1 testid, "medium" = role+name, "low" = tier 4-5 fallback. */
  stability: "high" | "medium" | "low";
  /** Concrete selector string a consumer can transcribe into a flow-file. */
  selectorHint: string;
  /** Which preference-order tier produced the hint (1–5). */
  selectorTier: 1 | 2 | 3 | 4 | 5;
  /** Visible-rect bbox; null when fully clipped. */
  bbox: VisibleRect | null;
  /** True when the element is fully clipped (bbox is null). */
  clipped: boolean;
  /** Internal score — higher = better match for the query. */
  score: number;
}

export interface FindOptions {
  query: string;
  maxCandidates?: number;
}

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio",
  "option", "tab", "treeitem",
]);

/**
 * Rank candidates against a natural-language query. The query is tokenised on
 * whitespace; each token is matched (case-insensitively, as substring) against
 * a haystack of role + name + testId. Scoring:
 *
 *   - exact-name match:     +10
 *   - name contains query:   +5
 *   - testId contains query: +5
 *   - role contains query:   +2
 *   - per-token hit anywhere: +1 each
 *   - interactive-role bonus: +2 (the agent's usually after a clickable thing)
 *
 * Candidates with score 0 are dropped. Top `maxCandidates` (default 5) returned.
 */
export async function find(
  cdp: CDPSession,
  refs: RefRegistry,
  opts: FindOptions,
): Promise<FindCandidate[]> {
  const tree = await getA11yTree(cdp, refs);
  if (!tree) return [];
  const q = opts.query.toLowerCase();
  const qTokens = q.split(/\s+/).filter(Boolean);
  const max = opts.maxCandidates ?? 5;

  const scored: Array<{ node: A11yNode; score: number }> = [];
  for (const { node } of walk(tree)) {
    const score = scoreNode(node, q, qTokens);
    if (score > 0) scored.push({ node, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, max);

  const candidates: FindCandidate[] = [];
  for (const { node, score } of top) {
    const { hint, tier, stability } = buildSelectorHint(node);
    const bbox = node.backendDOMNodeId !== undefined
      ? await visibleRect(cdp, node.backendDOMNodeId)
      : null;
    candidates.push({
      ref: node.ref,
      role: node.role,
      name: node.name,
      testId: node.testId,
      stability,
      selectorHint: hint,
      selectorTier: tier,
      bbox,
      clipped: bbox === null,
      score,
    });
  }
  return candidates;
}

function scoreNode(node: A11yNode, q: string, qTokens: string[]): number {
  const nameLower = (node.name ?? "").toLowerCase();
  const testIdLower = (node.testId ?? "").toLowerCase();
  const roleLower = node.role.toLowerCase();
  let s = 0;
  if (nameLower === q) s += 10;
  if (nameLower.includes(q)) s += 5;
  if (testIdLower.includes(q)) s += 5;
  if (roleLower.includes(q)) s += 2;
  for (const t of qTokens) {
    if (nameLower.includes(t)) s += 1;
    if (testIdLower.includes(t)) s += 1;
  }
  if (s > 0 && INTERACTIVE_ROLES.has(node.role)) s += 2;
  return s;
}

/**
 * The five-tier preference order from first-consumer ask #4:
 *   1. `[data-testid="…"]`           → stability "high"
 *   2. role + accessible name        → stability "medium"
 *   3. stable text on stable role    → stability "medium"  (Phase-1 stub: just role+name)
 *   4. structural (#id, semantic)    → stability "low"
 *   5. positional (last resort)      → stability "low"
 *
 * Phase 1 implements tiers 1, 2, and a tier-5 placeholder. Tiers 3–4 (stable-text /
 * id-attr-based) extend this once we batch-fetch more DOM attributes in a11y.ts.
 */
export function buildSelectorHint(
  node: Pick<A11yNode, "role" | "name" | "testId">,
): { hint: string; tier: 1 | 2 | 3 | 4 | 5; stability: FindCandidate["stability"] } {
  if (node.testId) {
    return { hint: `[data-testid=${JSON.stringify(node.testId)}]`, tier: 1, stability: "high" };
  }
  if (node.name) {
    return {
      hint: `role=${node.role}[name=${JSON.stringify(node.name)}]`,
      tier: 2,
      stability: "medium",
    };
  }
  // Phase-1 stub for tier 5 — no structural / positional resolution yet. The
  // agent should treat "low" as "ask a human or refuse to transcribe."
  return { hint: `role=${node.role}`, tier: 5, stability: "low" };
}
