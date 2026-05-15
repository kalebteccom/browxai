// find(query) — natural-language element description → ranked candidate locators
// with structured evidence. First-consumer asks #4 + #5: selectorHint follows a
// fixed preference order with a stability flag; bbox is the visible-rect.

import type { CDPSession, Page } from "playwright-core";
import { walk, type A11yNode } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { composeSnapshot } from "./compose.js";
import { visibleRect, type VisibleRect } from "./bbox.js";
import { findByRef } from "./snapshot.js";

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
  /** Wishlist W-A3: limit ranking to descendants of this ref (from a prior
   *  snapshot/find). "The seconds input *under* the AI Voiceover panel" without
   *  encoding the relationship in natural language. Ignored if the ref isn't in
   *  the current snapshot. */
  contextRef?: string;
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
  const warnings: string[] = [];

  // Wishlist W-A3: limit walk to subtree rooted at contextRef.
  let walkRoot: A11yNode = tree;
  if (opts.contextRef) {
    const sub = findByRef(tree, opts.contextRef);
    if (sub) walkRoot = sub;
    else warnings.push(`contextRef=${opts.contextRef} not found; ranking over the full tree instead.`);
  }

  const scored: Array<{ node: A11yNode; score: number }> = [];
  for (const { node } of walk(walkRoot)) {
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

  // Wishlist W-A3: confidence-floor warning (combined with any earlier warnings).
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
 *   3. stable text on stable role    → covered by tier 2 (the DOM-walk's nameFor()
 *                                       computes name from aria-label / labelledby /
 *                                       textContent in that order, so a `<button>Submit</button>`
 *                                       already gets `role=button[name="Submit"]` via tier 2)
 *   4. structural (#id, semantic)    → stability "low"  (id present + id-shaped stable)
 *   5. positional (last resort)      → stability "low"
 *
 * Phase-2 update: tier 4 now fires when the node has an HTML `id` attribute that
 * looks stable (not a numeric/UUID content-keyed id). The id-stability heuristic:
 * reject pure-numeric (`123`), short numeric+letter combos that look generated
 * (e.g. `mui-1234`), or strings matching common content-keyed shapes. Anything
 * with two or more `-`/`_`-separated word segments is treated as stable.
 */
export function buildSelectorHint(
  node: Pick<A11yNode, "role" | "name" | "testId" | "testIdAttr" | "id">,
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
  if (node.id && isLikelyStableId(node.id)) {
    return { hint: `#${cssEscape(node.id)}`, tier: 4, stability: "low" };
  }
  // Tier 5 fallback — role only. The agent should treat "low" as "ask a human
  // or refuse to transcribe."
  return { hint: `role=${node.role}`, tier: 5, stability: "low" };
}

/** Heuristic: is this HTML `id` value likely to survive across page reloads?
 *  Rejects content-keyed shapes (pure-numeric, MUI-generated `mui-N`, UUID-shaped).
 *  Accepts ids with two or more word segments separated by `-`/`_`/`:`. */
export function isLikelyStableId(id: string): boolean {
  // Pure numeric → content-keyed.
  if (/^\d+$/.test(id)) return false;
  // MUI / Radix / framework-generated short tags.
  if (/^(mui|radix|headlessui|reach|react-aria)[-_]?[a-z0-9]+$/i.test(id)) return false;
  // UUID-shaped.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false;
  // 8+ hex chars only → likely a hash / content-keyed.
  if (/^[0-9a-f]{8,}$/i.test(id) && id.length <= 32) return false;
  // Multi-segment (kebab/snake/colon-separated, ≥2 segments, each with letters) → stable.
  const segments = id.split(/[-_:]/).filter((s) => s.length > 0);
  if (segments.length >= 2 && segments.every((s) => /[a-z]/i.test(s))) return true;
  // Single-segment, ≥3 chars, has letters → probably stable.
  if (id.length >= 3 && /[a-z]/i.test(id) && !/^\d/.test(id)) return true;
  return false;
}

/** Minimal CSS escape for the id-selector value — covers the common cases
 *  (escapes leading digit, special chars). Doesn't aim to be a full CSS.escape() shim. */
function cssEscape(s: string): string {
  // Escape any character that isn't [A-Za-z0-9_-].
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1").replace(/^(\d)/, "\\3$1 ");
}
