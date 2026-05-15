// find(query) — natural-language element description → ranked candidate locators
// with structured evidence. First-consumer asks #4 + #5: selectorHint follows a
// fixed preference order with a stability flag; bbox is the visible-rect.

import type { CDPSession, Page } from "playwright-core";
import { walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { composeSnapshot } from "./compose.js";
import { visibleRect, type VisibleRect } from "./bbox.js";

export interface FindCandidate {
  ref: string;
  role: string;
  name?: string;
  testId?: string;
  /** "high" = tier-1 testid, "medium" = role+name, "low" = tier 4-5 fallback. */
  stability: "high" | "medium" | "low";
  /** Concrete selector string a consumer can transcribe into a flow-file. Disambiguated
   *  with `:visible` / `:nth-match(..., 1)` when the bare hint matched multiple DOM
   *  nodes (round-3 ask #13). */
  selectorHint: string;
  /** Which preference-order tier produced the hint (1–5). */
  selectorTier: 1 | 2 | 3 | 4 | 5;
  /** Visible-rect bbox; null when fully clipped. */
  bbox: VisibleRect | null;
  /** True when the element is fully clipped (bbox is null). */
  clipped: boolean;
  /** Wishlist W-D1: whether the element can be acted on right now. `true` = visible
   *  + enabled + on-screen. `"disabled"` / `"off-screen"` / `"covered"` describe *why*
   *  if not. Lets a calibration agent reject `<input disabled>`-shaped halts at
   *  write-time instead of at run-time. */
  actionable: true | "disabled" | "off-screen" | "covered";
  /** Internal score — higher = better match for the query. */
  score: number;
}

export interface FindOptions {
  query: string;
  maxCandidates?: number;
  /** Configured test-attribute list (sourced from BROWX_TEST_ATTRIBUTES). */
  testAttributes: string[];
  /** Wishlist W-A3: emit a `warnings: ["no candidate scored confidently…"]` block
   *  on the result when no top candidate exceeds this score. Default 0 (off). */
  confidenceFloor?: number;
}

export interface FindResult {
  candidates: FindCandidate[];
  warnings: string[];
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
  page: Page,
  cdp: CDPSession,
  refs: RefRegistry,
  opts: FindOptions,
): Promise<FindResult> {
  // Use the composed tree (a11y + DOM-walk fallback) so we can find candidates that
  // only exist on the DOM-walk side — the Phase-1.5 #7 win on heavy-SPA targets.
  const { tree } = await composeSnapshot(cdp, refs, opts.testAttributes);
  if (!tree) return { candidates: [], warnings: [] };
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
    const { hint: bareHint, tier, stability } = buildSelectorHint(node);
    // Round-3 ask #13: disambiguate when the bare hint matches multiple DOM nodes.
    const hint = await disambiguateHint(page, bareHint);
    const bbox = node.backendDOMNodeId !== undefined
      ? await visibleRect(cdp, node.backendDOMNodeId)
      : null;
    const actionable = await probeActionable(page, hint, bbox);
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
      actionable,
      score,
    });
  }

  // Wishlist W-A3: confidence-floor warning.
  const warnings: string[] = [];
  const floor = opts.confidenceFloor ?? 0;
  if (floor > 0 && (candidates.length === 0 || candidates[0]!.score < floor)) {
    warnings.push(
      `no candidate scored confidently above ${floor} (top score: ${candidates[0]?.score ?? 0}). ` +
      `Consider falling through to a snapshot scan + raw selector, or rephrasing the query against the element's accessible name / test-attribute value.`,
    );
  }
  return { candidates, warnings };
}

/**
 * Round-3 ask #13. After find() produces a `selectorHint` for the visible candidate,
 * check whether that bare hint matches multiple DOM nodes; if it does, append a
 * disambiguator (`:visible` first, `:nth-match(..., 1)` last resort) so that a
 * caller who transcribes the hint into a flow-file doesn't re-introduce the
 * hidden-duplicate `boundingBox` hang. Best-effort: any error returns the bare hint.
 */
async function disambiguateHint(page: Page, hint: string): Promise<string> {
  try {
    const count = await page.locator(hint).count();
    if (count <= 1) return hint;
    const visibleHint = `${hint}:visible`;
    const visibleCount = await page.locator(visibleHint).count();
    if (visibleCount === 1) return visibleHint;
    if (visibleCount > 1) return `:nth-match(${visibleHint}, 1)`;
    return `:nth-match(${hint}, 1)`;
  } catch {
    return hint;
  }
}

/**
 * Wishlist W-D1. Returns `true` iff the element is visible + enabled + on-screen.
 * Else returns a single-word reason. Best-effort; on any error returns `true`
 * (don't manufacture false-negatives).
 */
async function probeActionable(
  page: Page,
  hint: string,
  bbox: VisibleRect | null,
): Promise<FindCandidate["actionable"]> {
  if (bbox === null) return "off-screen";
  try {
    const loc = page.locator(hint).first();
    const [isEnabled, isVisible] = await Promise.all([
      loc.isEnabled().catch(() => true),
      loc.isVisible().catch(() => true),
    ]);
    if (!isEnabled) return "disabled";
    if (!isVisible) return "off-screen";
    // "covered" — Phase-1.5: requires `elementFromPoint` at the bbox center and
    // an identity check. Skipped for now (~+10 LOC + a CDP call; not load-bearing
    // for the round-3 / wishlist headline cases). Leave the union member in place
    // so callers handle it; the value is just never produced yet.
    return true;
  } catch {
    return true;
  }
}

/** Score a node's match against a tokenised query — also weights testId / testIdAttr
 *  hits high so a query like "feature-area language" lands on `data-testid="feature-panel-language-input"`
 *  even when the role tree doesn't surface a wrapper. */

const INPUT_LIKE_ROLES = new Set(["input", "textbox", "searchbox", "combobox", "spinbutton"]);

export function scoreNode(node: A11yNode, q: string, qTokens: string[]): number {
  const nameLower = (node.name ?? "").toLowerCase();
  const testIdLower = (node.testId ?? "").toLowerCase();
  const roleLower = node.role.toLowerCase();
  let s = 0;
  // Exact-name match: strongest signal.
  if (nameLower === q) s += 10;
  if (nameLower.includes(q)) s += 5;
  // Round-3 ask #14: weight testId hits more heavily, especially against
  // `<input>`-shaped roles where `name` is typically empty. Without this, a
  // query like "X-time-input-seconds inside Y-start-time-input" failed to
  // surface an `<input data-testid="X-time-input-seconds">` because the score
  // came entirely from accidental short-token hits.
  if (testIdLower === q) s += 15;             // exact testId match wins big
  if (testIdLower.includes(q)) s += 10;       // (was +5 pre-ask-#14)
  if (roleLower.includes(q)) s += 2;
  for (const t of qTokens) {
    if (t.length < 2) continue;
    if (nameLower.includes(t)) s += 1;
    if (testIdLower.includes(t)) s += 2;     // (was +1 pre-ask-#14)
  }
  if (s > 0 && INTERACTIVE_ROLES.has(node.role)) s += 2;
  // Extra boost when the node is input-shaped AND any testId token matched —
  // this is the case round 3 exposed.
  if (testIdLower && INPUT_LIKE_ROLES.has(node.role)) {
    for (const t of qTokens) {
      if (t.length >= 2 && testIdLower.includes(t)) { s += 3; break; }
    }
  }
  return s;
}

/**
 * The five-tier preference order from first-consumer ask #4:
 *   1. `[<test-attr>="…"]`           → stability "high"  (any configured test-attribute)
 *   2. role + accessible name        → stability "medium"
 *   3. stable text on stable role    → stability "medium"  (Phase-1.5)
 *   4. structural (#id, semantic)    → stability "low"     (Phase-1.5)
 *   5. positional (last resort)      → stability "low"
 *
 * Phase 1.5 ask #10 ratified: tier-1 hits never gate on a role wrapper. A DOM-walk
 * node with `testIdAttr="data-type"` and `testId="foo"` gets `[data-type="foo"]` and
 * stability `high` even when no a11y role is wrapping it. This is what unblocks
 * heavy-SPA targets whose tier-1 anchors live on plain `<div>`s.
 */
export function buildSelectorHint(
  node: Pick<A11yNode, "role" | "name" | "testId" | "testIdAttr">,
): { hint: string; tier: 1 | 2 | 3 | 4 | 5; stability: FindCandidate["stability"] } {
  if (node.testId) {
    const attr = node.testIdAttr ?? "data-testid";
    return { hint: `[${attr}=${JSON.stringify(node.testId)}]`, tier: 1, stability: "high" };
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
