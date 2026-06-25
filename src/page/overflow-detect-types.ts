// `overflow_detect` — engine-blind domain shapes + pure helpers.
//
// The synth/limit/types-resolution layer of the overflow detector, split out
// of overflow-detect.ts so the DOMAIN (the four detector taxonomy types, the
// finding/evidence shapes, the EPSILON math, and the selector-synthesis tiers)
// lives free of any Playwright/CDP binding. The page-side detector
// (`PAGE_DETECT_FN`) and the `detectOverflow` adapter both import from here;
// the unit tests pin the pure helpers against fixture mock elements.
//
// Detector taxonomy (all four enabled by default; opt out via `types`):
//
//   - `layout`              — `scrollWidth/Height > clientWidth/Height` on
//                             an element whose computed `overflow` is
//                             `auto`/`scroll`. The platform IS providing a
//                             scrollbar but content overflows the visible
//                             padding box. Subtler than `clipped` (content
//                             is recoverable) but still worth surfacing.
//   - `clipped`             — same dimensional check, but `overflow-x|y` is
//                             `hidden`/`clip`. Content extending past the
//                             box is invisible with no scrollbar to
//                             recover. The high-value "the button got cut
//                             off" finding.
//   - `text-ellipsis`       — `text-overflow: ellipsis` AND
//                             `scrollWidth > clientWidth` on the text node
//                             itself. Carries `visibleText` (best-effort
//                             heuristic — the offsetWidth-bounded prefix)
//                             plus `fullText` (the truth the agent reads).
//   - `viewport-horizontal` — singleton check: `documentElement.scrollWidth
//                             > documentElement.clientWidth`. The "horizontal
//                             scrollbar on body" mobile-layout bug. One
//                             finding at most; selector `"html"`; evidence
//                             surfaces the overrun amount + the widest
//                             overrunning descendant when cheaply identifiable.
//
// EPSILON = 1 CSS px tolerates sub-pixel rounding noise — without it,
// pages that scale fonts or run on a fractional devicePixelRatio routinely
// trip false positives by ≤0.5 px.
//
// Bounded walk: `MAX_ELEMENTS_SCANNED = 10000`. When the cap is hit, the
// result carries `warnings:["scan stopped at MAX_ELEMENTS_SCANNED…"]` so
// the agent can re-run with `scope:"viewport"` for a narrower pass.

export type OverflowType = "layout" | "clipped" | "text-ellipsis" | "viewport-horizontal";

export type OverflowScope = "viewport" | "document";

export const ALL_TYPES: OverflowType[] = [
  "layout",
  "clipped",
  "text-ellipsis",
  "viewport-horizontal",
];

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const MAX_ELEMENTS_SCANNED = 10000;

export interface OverflowDetectArgs {
  /** Scope of the scan. `"document"` (default) walks every element; `"viewport"`
   *  skips elements whose bounding rect is fully outside the current viewport. */
  scope?: OverflowScope;
  /** Overflow shapes to surface. Default = all four. Empty array also
   *  treated as "all" (an empty filter is a usage error, not a no-op). */
  types?: OverflowType[];
  /** Cap on findings returned. Default 50, max 500. Findings past the cap
   *  are dropped (oldest-discovered are kept) and `truncated:true` is set. */
  limit?: number;
}

export interface OverflowBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type OverflowEvidence =
  | {
      // layout + clipped
      scrollWidth: number;
      clientWidth: number;
      scrollHeight: number;
      clientHeight: number;
      overflowX: string;
      overflowY: string;
    }
  | {
      // text-ellipsis
      scrollWidth: number;
      clientWidth: number;
      visibleText: string;
      fullText: string;
    }
  | {
      // viewport-horizontal
      documentScrollWidth: number;
      viewportWidth: number;
      overrunPx: number;
      widestDescendantSelector?: string;
      widestDescendantWidth?: number;
    }
  | {
      // synthesis-too-long fallback (rare; selector exceeded 200 chars)
      selectorTruncated: true;
      originalLength: number;
    };

export interface OverflowFinding {
  selector: string;
  bbox: OverflowBbox | null;
  type: OverflowType;
  evidence: OverflowEvidence;
}

export interface OverflowDetectResult {
  ok: true;
  scope: OverflowScope;
  findings: OverflowFinding[];
  truncated: boolean;
  warnings: string[];
}

/** Raw per-finding shape the page-side detector emits (before the adapter
 *  folds selector-truncation into evidence). Shared by `PAGE_DETECT_FN` and
 *  `detectOverflow`. */
export interface PageRawFinding {
  selector: string;
  selectorTruncated: boolean;
  selectorOriginalLength: number;
  bbox: OverflowBbox | null;
  type: OverflowType;
  evidence: OverflowEvidence;
}

export interface PageRawResult {
  findings: PageRawFinding[];
  scanCapped: boolean;
}

/** Selector synthesis tiers (page-side mirror in `PAGE_DETECT_FN`):
 *
 *   1. `[data-testid="..."]`
 *   2. `[role="..."][aria-label="..."]`           (both stable)
 *   3. nth-of-type CSS path bounded at 5 levels
 *   4. `tag.classes` (up to 3 classes)
 *
 *  Capped at 200 chars; longer falls through to `tag` only with an
 *  `evidence.selectorTruncated` flag.
 *
 *  Exported for unit tests against fixture mock elements.
 */
export const SELECTOR_MAX_LEN = 200;
export interface SelectorSynth {
  selector: string;
  truncated: boolean;
  originalLength: number;
}

/** Pure helper for synthesising a selector against a `MinimalElement` shape.
 *  Used by the unit tests; the page-side mirror in `PAGE_DETECT_FN` follows
 *  the same tier order but operates on real `Element` instances. */
export interface MinimalElement {
  tagName: string;
  testId: string | null;
  role: string | null;
  ariaLabel: string | null;
  classList: string[];
  /** Optional parent chain — first entry is the immediate parent. Used
   *  by the nth-of-type tier (bounded at 5 levels). Each entry must
   *  carry `nthOfType` (1-based) + `tagName`. */
  parentChain?: Array<{ tagName: string; nthOfType: number }>;
  nthOfType?: number;
}

export function synthesiseSelector(el: MinimalElement): SelectorSynth {
  const tag = (el.tagName || "").toLowerCase();
  let raw: string;

  // Tier 1 — data-testid.
  if (el.testId) {
    raw = `[data-testid="${escapeAttrValue(el.testId)}"]`;
  } else if (el.role && el.ariaLabel) {
    // Tier 2 — role + accessible name (both stable).
    raw = `[role="${escapeAttrValue(el.role)}"][aria-label="${escapeAttrValue(el.ariaLabel)}"]`;
  } else if (el.parentChain && el.parentChain.length > 0 && typeof el.nthOfType === "number") {
    // Tier 3 — nth-of-type CSS path, bounded at 5 levels.
    const levels: string[] = [];
    const chain = el.parentChain.slice(0, 5);
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = chain[i]!;
      levels.push(`${a.tagName.toLowerCase()}:nth-of-type(${a.nthOfType})`);
    }
    levels.push(`${tag}:nth-of-type(${el.nthOfType})`);
    raw = levels.join(" > ");
  } else if (el.classList.length > 0) {
    // Tier 4 — tag.classes (up to 3).
    const classes = el.classList.slice(0, 3).map(escapeClassName);
    raw = `${tag}.${classes.join(".")}`;
  } else {
    raw = tag || "*";
  }

  if (raw.length <= SELECTOR_MAX_LEN) {
    return { selector: raw, truncated: false, originalLength: raw.length };
  }
  return { selector: tag || "*", truncated: true, originalLength: raw.length };
}

function escapeAttrValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeClassName(c: string): string {
  // CSS identifier escape — limited to characters classlist actually surfaces;
  // we don't try to encode arbitrary text-of-the-rainbow class names, just
  // the ones a synthesised selector needs to round-trip.
  return c.replace(/([^A-Za-z0-9_-])/g, "\\$1");
}

/** Pure helper: cap findings at `limit`, set `truncated` when exceeded.
 *  Exported for unit tests. */
export function applyLimit<T>(findings: T[], limit: number): { kept: T[]; truncated: boolean } {
  if (findings.length <= limit) {
    return { kept: findings, truncated: false };
  }
  return { kept: findings.slice(0, limit), truncated: true };
}

/** Pure helper: which detector mask should be active. Empty array →
 *  all four (an empty filter is treated as "default", not "exclude
 *  everything" — the latter would be a usage error with no signal). */
export function resolveTypes(requested: OverflowType[] | undefined): Set<OverflowType> {
  if (!requested || requested.length === 0) return new Set(ALL_TYPES);
  // Filter to the known set so a typo doesn't silently turn into a
  // useless filter; unknowns are dropped.
  const out = new Set<OverflowType>();
  for (const t of requested) {
    if (ALL_TYPES.includes(t)) out.add(t);
  }
  if (out.size === 0) return new Set(ALL_TYPES);
  return out;
}

/** Pure helper for the EPSILON math — returns true when content actually
 *  overruns its container past the sub-pixel-noise tolerance. Centralised
 *  so the unit tests can pin the threshold + so changes flow through one
 *  site instead of four detector branches. */
export const OVERFLOW_EPSILON = 1;
export function overflows(
  scrollDim: number,
  clientDim: number,
  epsilon: number = OVERFLOW_EPSILON,
): boolean {
  return scrollDim > clientDim + epsilon;
}
