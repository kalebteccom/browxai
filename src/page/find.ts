// find(query) — natural-language element description → ranked candidate locators
// with structured evidence. First-consumer : selectorHint follows a
// fixed preference order with a stability flag; bbox is the visible-rect.

import type { CDPSession, Frame, Page } from "playwright-core";
import { walk, type A11yNode, type StructuralContext } from "./a11y.js";
import type { RefRegistry } from "./refs.js";
import { composeSnapshot, composeSnapshotForFrame } from "./compose.js";
import { visibleRect, locatorBoundingBox, type VisibleRect } from "./bbox.js";
import { findByRef } from "./snapshot.js";
import type { FeedbackMemory } from "./learning.js";

export interface FindCandidate {
  ref: string;
  role: string;
  name?: string;
  testId?: string;
  /** "high" = tier-1 testid, "medium" = role+name, "low" = tier 4-5 fallback. */
  stability: "high" | "medium" | "low";
  /** Concrete selector string a consumer can transcribe into a flow-file. Disambiguated
   *  with `:visible` / `:nth-match(..., 1)` when the bare hint matched multiple DOM
   *  nodes (). */
  selectorHint: string;
  /** Which preference-order tier produced the hint (1–5). */
  selectorTier: 1 | 2 | 3 | 4 | 5;
  /** Visible-rect bbox; null when fully clipped. */
  bbox: VisibleRect | null;
  /** True when the element is fully clipped (bbox is null). */
  clipped: boolean;
  /** whether the element can be acted on right now. `true` = visible
   *  + enabled + on-screen. `"disabled"` / `"off-screen"` / `"covered"` describe *why*
   *  if not. Lets a calibration agent reject `<input disabled>`-shaped halts at
   *  write-time instead of at run-time. */
  actionable: true | "disabled" | "off-screen" | "covered";
  /** Internal score — higher = better match for the query. */
  score: number;
  /** structural neighbourhood when this candidate sits inside a repeated
   *  container (table row, listitem, repeated card). Lets the caller filter
   *  by row / column without re-walking the snapshot. Absent when the
   *  candidate isn't in a recognised repeated structure. */
  context?: StructuralContext;
}

export interface FindOptions {
  query: string;
  maxCandidates?: number;
  /** Configured test-attribute list (sourced from BROWX_TEST_ATTRIBUTES). */
  testAttributes: string[];
  /** emit a `warnings: ["no candidate scored confidently…"]` block
   *  on the result when no top candidate exceeds this score. Default 0 (off). */
  confidenceFloor?: number;
  /** limit ranking to descendants of this ref (from a prior
   *  snapshot/find). "The seconds input *under* the AI Voiceover panel" without
   *  encoding the relationship in natural language. Ignored if the ref isn't in
   *  the current snapshot. */
  contextRef?: string;
  /**  learned ranking: prior session feedback applied as a per-candidate
   *  score bonus. Skip / null = no learning bonus. */
  feedback?: FeedbackMemory;
  /** which fallback tools to *name* in the "no visible candidate"
   *  warning. Capability-aware so we never point an agent at a disabled tool
   *  (`coords` needs `action`; `eval_js` needs `eval`). */
  fallbackHints?: { coords: boolean; evalJs: boolean };
  /** drop non-actionable candidates (off-screen / clipped / covered /
   *  disabled) entirely instead of ranking them last. A confident hidden
   *  hit still lures agents into coordinate fallbacks despite the warning;
   *  `visibleOnly` returns an empty list + the same warning rather than a
   *  misleading hit. Default false (hidden candidates kept, ranked last). */
  visibleOnly?: boolean;
  /** when set, scope ranking + ref-binding to this child Frame.
   *  Refs minted are bound to the frame on the registry so subsequent
   *  actions land inside the iframe. The bbox/actionable probes resolve
   *  via the frame's own locator surface. Omitted = main frame (existing
   *  behaviour, byte-identical). */
  frame?: Frame;
  /** stable frame ID of `frame`, used for ref namespacing in the
   *  registry and for the snapshot warning. Required when `frame` is set. */
  frameId?: string;
  /** shadow DOM piercing.
   *  - `undefined` (default) — preserves pre-v0.5.0 behaviour. Playwright's
   *    a11y tree auto-pierces open shadow roots; the DOM-walk fallback does
   *    not recurse into shadow content.
   *  - `"open"` — additionally have the DOM-walk fallback recurse through
   *    every reachable open shadow root.
   *  - `"closed"` — open-walk + a CDP `pierce:true` pass that surfaces
   *    elements inside CLOSED shadow roots. Best-effort: when CDP refuses
   *    the pierce call (older Chromium, attached-mode quirks), falls back
   *    to open-only and the result carries a warning. Closed-shadow
   *    candidates carry a warning of their own — they're inspectable
   *    evidence, not actionable targets (Playwright's locator engine
   *    cannot reach them). Closed-shadow CDP harvesting only runs on the
   *    main frame; in a frame-scoped find, `"closed"` degrades to `"open"`.
   *  - `false` — neither path recurses into shadow content. */
  pierce?: "open" | "closed" | false;
}

export interface FindResult {
  candidates: FindCandidate[];
  warnings: string[];
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
]);

/**
 * Per-call cap for the auto-waiting Playwright probes (`boundingBox`,
 * `isEnabled`) used in the candidate-evaluation loop. find() is a probe
 * tool, not an action — a probe must fail fast when its hint doesn't match
 * a live element. The default `actionTimeout` (30 s) is appropriate for
 * acting on a known element; without a cap here, find() against N candidates
 * whose hints don't resolve to a Playwright locator would burn N × 30 s of
 * wall-clock waiting for nothing. 500 ms comfortably covers a real
 * boundingBox resolution on a matched element (typically 1–50 ms) while
 * keeping the per-candidate worst case bounded.
 */
const PROBE_TIMEOUT_MS = 500;

// Non-interactive structural / layout / landmark wrappers. These *enclose* the
// thing an agent wants to act on; they are never themselves the click target.
// When a query is phrased loosely (a product alias rather than the test-attr
// tokens) one of these can outscore the actual control it contains, so we
// demote them below an actionable interactive match. Deliberately
// conservative — list/listitem/article/section are omitted because they can
// legitimately be the intended target in some UIs.
const CONTAINER_ROLES = new Set([
  "generic",
  "group",
  "region",
  "toolbar",
  "none",
  "presentation",
  "navigation",
  "complementary",
  "banner",
  "contentinfo",
  "main",
  "application",
  "document",
  "form",
  "search",
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
  // only exist on the DOM-walk side — the  #7 win on heavy-SPA targets.
  // when `frame` is set, scope to that frame's DOM-walk-only compose
  // path and bind refs to the frame on the registry so subsequent actions land
  // inside the iframe.
  // `pierce` propagates through to the dom-walk + (when "closed",
  // main-frame only) the CDP pierce path. Omitting `pierce` preserves
  // byte-identical pre-v0.5.0 output.
  const composed =
    opts.frame && opts.frameId
      ? await composeSnapshotForFrame(opts.frame, refs, opts.testAttributes, opts.frameId, {
          pierce: opts.pierce,
        })
      : await composeSnapshot(cdp, refs, opts.testAttributes, { pierce: opts.pierce });
  const { tree } = composed;
  if (!tree) {
    // Same byte-identical-back-compat reasoning as the success path:
    // surface compose warnings only when pierce was explicitly opted in.
    const w =
      opts.pierce !== undefined
        ? composed.warnings.filter((s) => !s.startsWith("low-content"))
        : [];
    return { candidates: [], warnings: w };
  }
  // The locator-resolution root: page for main-frame finds, frame for
  // frame-scoped finds. Probes (disambiguation, bbox fallback, actionable)
  // use this root so they exercise the correct DOM tree.
  const locatorRoot: Page | Frame = opts.frame ?? page;
  const q = opts.query.toLowerCase();
  const qTokens = q.split(/\s+/).filter(Boolean);
  const max = opts.maxCandidates ?? 5;
  const warnings: string[] = [];
  // when pierce was explicitly opted into, surface the compose
  // layer's shadow-DOM warnings (closed-shadow CDP availability, the
  // "closed-shadow candidates are inspect-only" caveat). Without an
  // explicit pierce arg, the find() envelope stays byte-identical to
  // pre-v0.5.0.
  if (opts.pierce !== undefined) {
    for (const w of composed.warnings) {
      // Skip the low-content warning — it pre-dates this and was
      // surfaced through snapshot only; smuggling it into find() now
      // would change pre-existing pierce-less callers' output the moment
      // they opt into pierce.
      if (w.startsWith("low-content")) continue;
      warnings.push(w);
    }
  }

  // limit walk to subtree rooted at contextRef.
  let walkRoot: A11yNode = tree;
  if (opts.contextRef) {
    const sub = findByRef(tree, opts.contextRef);
    if (sub) walkRoot = sub;
    else
      warnings.push(`contextRef=${opts.contextRef} not found; ranking over the full tree instead.`);
  }

  const scored: Array<{ node: A11yNode; score: number }> = [];
  for (const { node } of walk(walkRoot)) {
    let score = scoreNode(node, q, qTokens);
    if (score > 0 && opts.feedback) {
      score += opts.feedback.bonusFor(opts.query, {
        testId: node.testId,
        testIdAttr: node.testIdAttr,
        role: node.role,
        name: node.name,
      });
    }
    if (score > 0) scored.push({ node, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, max);

  // Per-candidate probing is independent (each candidate's hint, bbox,
  // and actionability are computed against the live page in isolation), so
  // run the top-N pool in parallel. Sequential probing was the dominant
  // find() cost: on a DOM-walk-sourced candidate whose role-locator doesn't
  // resolve to a real Playwright role, every probe call would auto-wait the
  // full `actionTimeout` window before returning. In default operation
  // find() was already capped by the outer 5 s `actionTimeoutMs` anti-wedge
  // but consumed it in full on pages with fall-through-role candidates;
  // without the cap, the 60 s anti-wedge deadline would clip in pathological
  // cases. The probe steps inside each task remain ordered (hint → bbox →
  // actionable depends on bbox), and `PROBE_TIMEOUT_MS` caps any single
  // probe call so a no-match hint fails fast instead of waiting on auto-wait.
  const candidates: FindCandidate[] = await Promise.all(
    top.map(async ({ node, score }) => {
      const { hint: bareHint, tier, stability } = buildSelectorHint(node);
      // disambiguate when the bare hint matches multiple DOM nodes.
      const hint = await disambiguateHint(locatorRoot, bareHint);
      // For frame-scoped finds, skip the CDP visible-rect path entirely
      // (its backendDOMNodeIds are rooted at the top target and don't
      // resolve into OOPIFs). Same-origin frames technically could be
      // probed via CDP with the right node-id juggling but the
      // locator-bounding-box path is portable and identical-behaviour.
      let bbox =
        opts.frame === undefined && node.backendDOMNodeId !== undefined
          ? await visibleRect(cdp, node.backendDOMNodeId)
          : null;
      // attached/BYOB: the CDP rect path can spuriously null out a rendered
      // DOM-walk node → fall back to Playwright's locator box before we let a
      // bad signal classify a visible element off-screen (which `visibleOnly`
      // would then drop entirely).
      if (bbox === null)
        bbox = await locatorBoundingBox(locatorRoot, hint, { timeoutMs: PROBE_TIMEOUT_MS });
      const actionable = await probeActionable(locatorRoot, hint, bbox);
      return {
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
        ...(node.context ? { context: node.context } : {}),
      };
    }),
  );

  // visibility-aware ranking. Stable-partition actionable candidates
  // ahead of non-actionable ones (off-screen / clipped / covered / disabled),
  // preserving score order within each tier — so a slightly-lower-scored
  // *visible* match outranks a high-scored hidden modal.
  const { ranked, visibleCount } = rankByVisibility(candidates, opts.visibleOnly === true);

  // confidence-floor warning (combined with any earlier warnings).
  const floor = opts.confidenceFloor ?? 0;
  if (floor > 0 && (ranked.length === 0 || ranked[0]!.score < floor)) {
    warnings.push(
      `no candidate scored confidently above ${floor} (top score: ${ranked[0]?.score ?? 0}). ` +
        `Consider falling through to a snapshot scan + raw selector, or rephrasing the query against the element's accessible name / test-attribute value.`,
    );
  }

  // when there *are* candidates but none are actionable, that's a strong
  // "the match is wrong" signal — the field report saw confident off-screen
  // dialogs returned for a plainly-visible target. Flag it, and suggest the
  // fallbacks the caller actually has enabled (never name a disabled tool).
  // base this on the pre-filter match count + visible count so it still
  // fires under `visibleOnly` (where `ranked` is empty when nothing's visible).
  if (visibleCount === 0 && candidates.length > 0) {
    warnings.push(noVisibleCandidateWarning(candidates.length, opts.fallbackHints));
  }

  return { candidates: ranked, warnings };
}

/**
 * Stable-partition candidates: actionable ones first (preserving score order),
 * non-actionable (off-screen / clipped / covered / disabled) last — so a
 * slightly-lower-scored *visible* match outranks a high-scored hidden modal.
 * `visibleOnly` drops the hidden tier entirely: an empty result + the
 * "no visible candidate" warning is safer than a confident hidden hit the
 * agent will chase into a coordinate fallback.
 *
 * Within the actionable tier, a second stable partition demotes
 * non-interactive structural/layout containers below interactive controls,
 * but *only* when at least one actionable interactive candidate exists — an
 * aliased query ("the X panel in the right rail") otherwise lets the
 * enclosing wrapper outrank the button/tab the agent actually wants. If no
 * actionable interactive candidate matched, containers are left in place
 * (they may be the best available target). Pure; exported for tests.
 */
export function rankByVisibility(
  candidates: FindCandidate[],
  visibleOnly: boolean,
): { ranked: FindCandidate[]; visibleCount: number } {
  let visible = candidates.filter((c) => c.actionable === true);
  const hidden = candidates.filter((c) => c.actionable !== true);

  const isContainer = (c: FindCandidate) =>
    CONTAINER_ROLES.has(c.role) && !INTERACTIVE_ROLES.has(c.role);
  if (visible.some((c) => INTERACTIVE_ROLES.has(c.role))) {
    const leaves = visible.filter((c) => !isContainer(c));
    const containers = visible.filter(isContainer);
    visible = [...leaves, ...containers];
  }

  return {
    ranked: visibleOnly ? visible : [...visible, ...hidden],
    visibleCount: visible.length,
  };
}

/**
 * the "all candidates off-screen → probably the wrong match" warning.
 * Capability-aware — only names a fallback tool the caller actually has
 * enabled (`coords` ⇐ `action`, `eval_js` ⇐ `eval`). Pure; exported for tests.
 */
export function noVisibleCandidateWarning(
  count: number,
  fallbackHints?: { coords: boolean; evalJs: boolean },
): string {
  const suggestions: string[] = [];
  if (fallbackHints?.coords)
    suggestions.push("compute the element rect and use `coords` on click/hover");
  if (fallbackHints?.evalJs) suggestions.push("read state directly via `eval_js`");
  const tail = suggestions.length ? ` You may want to: ${suggestions.join("; or ")}.` : "";
  return (
    `no visible candidate — all ${count} match(es) are off-screen / clipped / covered ` +
    `(actionable ≠ true). This usually means the query matched the wrong element ` +
    `(e.g. a hidden modal).${tail}`
  );
}

/**
 * . After find() produces a `selectorHint` for the visible candidate,
 * check whether that bare hint matches multiple DOM nodes; if it does, append a
 * disambiguator (`:visible` first, `:nth-match(..., 1)` last resort) so that a
 * caller who transcribes the hint into a flow-file doesn't re-introduce the
 * hidden-duplicate `boundingBox` hang. Best-effort: any error returns the bare hint.
 */
async function disambiguateHint(root: Page | Frame, hint: string): Promise<string> {
  try {
    const count = await root.locator(hint).count();
    if (count <= 1) return hint;
    const visibleHint = `${hint}:visible`;
    const visibleCount = await root.locator(visibleHint).count();
    if (visibleCount === 1) return visibleHint;
    if (visibleCount > 1) return `:nth-match(${visibleHint}, 1)`;
    return `:nth-match(${hint}, 1)`;
  } catch {
    return hint;
  }
}

/**
 * . Returns `true` iff the element is visible + enabled + on-screen.
 * Else returns a single-word reason. Best-effort; on any error returns `true`
 * (don't manufacture false-negatives).
 */
async function probeActionable(
  root: Page | Frame,
  hint: string,
  bbox: VisibleRect | null,
): Promise<FindCandidate["actionable"]> {
  if (bbox === null) return "off-screen";
  try {
    const loc = root.locator(hint).first();
    // isEnabled auto-waits to the action-timeout default (30 s) when the
    // locator doesn't resolve; cap it. isVisible is documented as
    // non-waiting (the option is deprecated/ignored) so it costs ~0.
    const [isEnabled, isVisible] = await Promise.all([
      loc.isEnabled({ timeout: PROBE_TIMEOUT_MS }).catch(() => true),
      loc.isVisible().catch(() => true),
    ]);
    if (!isEnabled) return "disabled";
    if (!isVisible) return "off-screen";
    // "covered" — requires `elementFromPoint` at the bbox center and an
    // identity check. Skipped for now (~+10 LOC + a CDP call; not load-bearing
    // for the headline cases). Leave the union member in place so callers
    // handle it; the value is just never produced yet.
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
  // weight testId hits more heavily, especially against
  // `<input>`-shaped roles where `name` is typically empty. Without this, a
  // query like "X-time-input-seconds inside Y-start-time-input" failed to
  // surface an `<input data-testid="X-time-input-seconds">` because the score
  // came entirely from accidental short-token hits.
  if (testIdLower === q) s += 15; // exact testId match wins big
  if (testIdLower.includes(q)) s += 10; // (was +5 pre-ask-#14)
  if (roleLower.includes(q)) s += 2;
  // per-testId-token weight is amplified for icon-only controls (no
  // accessible name) where the only signal is the testId itself. Without this
  // boost, an icon-only side-panel tab whose testId encodes the intent
  // (`side-panel-feature-tab`) loses ranking to a neighbour with one more
  // accidental name-token hit.
  const isIconOnly = !nameLower && !!testIdLower;
  for (const t of qTokens) {
    if (t.length < 2) continue;
    if (nameLower.includes(t)) s += 1;
    if (testIdLower.includes(t)) s += isIconOnly ? 3 : 2;
  }
  if (s > 0 && INTERACTIVE_ROLES.has(node.role)) s += 2;
  // Extra boost when the node is input-shaped AND any testId token matched —
  // this is the case round 3 exposed.
  if (testIdLower && INPUT_LIKE_ROLES.has(node.role)) {
    for (const t of qTokens) {
      if (t.length >= 2 && testIdLower.includes(t)) {
        s += 3;
        break;
      }
    }
  }
  // Trimmed text content (a `title` tooltip, an sr-only label, visible
  // glyph-adjacent text) — often the only human-readable hint on an
  // icon-only control whose accessible name is empty. Weaker than the
  // accessible name (it can be noisier), stronger when the control is
  // icon-only and the text is all we have.
  const textLower = (node.text ?? "").toLowerCase();
  if (textLower) {
    if (textLower === q) s += 6;
    else if (textLower.includes(q)) s += 3;
    for (const t of qTokens) {
      if (t.length < 2) continue;
      if (textLower.includes(t)) s += isIconOnly ? 2 : 1;
    }
  }
  // Active / selected state. A control already in a selected / pressed /
  // checked state that also matches the query is almost always the live
  // feature area the agent means — this is what disambiguates the active
  // side-panel tab from its inert icon-only siblings (the report's
  // "neighbouring selected-state" signal). Only bonuses an existing match.
  const isActive = node.selected === true || node.pressed === true || node.checked === true;
  if (s > 0 && isActive) s += 3;
  return s;
}

/**
 * The five-tier preference order from :
 *   1. `[<test-attr>="…"]`           → stability "high"  (any configured test-attribute)
 *   2. role + accessible name        → stability "medium"
 *   3. stable text on stable role    → covered by tier 2 (the DOM-walk's nameFor()
 *                                       computes name from aria-label / labelledby /
 *                                       textContent in that order, so a `<button>Submit</button>`
 *                                       already gets `role=button[name="Submit"]` via tier 2)
 *   4. structural (#id, semantic)    → stability "low"  (id present + id-shaped stable)
 *   5. positional (last resort)      → stability "low"
 *
 *  update: tier 4 now fires when the node has an HTML `id` attribute that
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
