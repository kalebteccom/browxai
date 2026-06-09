/// <reference lib="dom" />
// `overflow_detect` — diagnose page-layout overflow.
//
// The silent UI-breakage primitive: clipped buttons, ellipsis-truncated
// labels, horizontal-scrollbar-on-mobile bugs. Agents repeatedly miss
// these because a screenshot looks "fine" (the clipped pixel doesn't
// shout) and `find()` doesn't surface "the element rendered but its
// content was lost". This tool walks the DOM, applies four overflow
// shape detectors, and returns one finding per offending element.
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
//
// Page-side function is passed as a REAL function literal (not a
// stringified arrow) so Playwright's `Page.evaluate(fn, arg)` path
// serializes the source and invokes in-page with the arg. The same trap
// burned `dom_export`'s `PAGE_WALK_FN` and `element_export`'s discovery
// function — a stringified `(args) => {...}` evaluates to the function
// value uncalled, which CDP can't serialize → undefined.

export type OverflowType = "layout" | "clipped" | "text-ellipsis" | "viewport-horizontal";

export type OverflowScope = "viewport" | "document";

const ALL_TYPES: OverflowType[] = ["layout", "clipped", "text-ellipsis", "viewport-horizontal"];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_ELEMENTS_SCANNED = 10000;

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
const SELECTOR_MAX_LEN = 200;
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

interface PageRawFinding {
  selector: string;
  selectorTruncated: boolean;
  selectorOriginalLength: number;
  bbox: OverflowBbox | null;
  type: OverflowType;
  evidence: OverflowEvidence;
}

interface PageRawResult {
  findings: PageRawFinding[];
  scanCapped: boolean;
}

/** Page-side detector. Receives the resolved type mask + scope + scan
 *  budget; returns raw findings + a `scanCapped` flag. Walk is bounded
 *  by `MAX_ELEMENTS_SCANNED`. Passed as a real function literal — see
 *  the file-header note on the stringified-arrow trap. */
const PAGE_DETECT_FN = (args: {
  types: OverflowType[];
  scope: OverflowScope;
  maxElements: number;
  epsilon: number;
  selectorMaxLen: number;
}): PageRawResult => {
  const wantLayout = args.types.indexOf("layout") !== -1;
  const wantClipped = args.types.indexOf("clipped") !== -1;
  const wantEllipsis = args.types.indexOf("text-ellipsis") !== -1;
  const wantVpHorizontal = args.types.indexOf("viewport-horizontal") !== -1;
  const epsilon = args.epsilon;
  const selectorMaxLen = args.selectorMaxLen;

  const findings: PageRawFinding[] = [];

  function escapeAttr(v: string): string {
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function escapeCls(c: string): string {
    return c.replace(/([^A-Za-z0-9_-])/g, "\\$1");
  }
  function nthOfType(node: Element): number {
    let n = 1;
    let prev = node.previousElementSibling;
    while (prev) {
      if (prev.tagName === node.tagName) n++;
      prev = prev.previousElementSibling;
    }
    return n;
  }
  function synth(el: Element): { selector: string; truncated: boolean; originalLength: number } {
    const tag = (el.tagName || "").toLowerCase();
    let raw = "";
    const testId = el.getAttribute("data-testid");
    if (testId) {
      raw = '[data-testid="' + escapeAttr(testId) + '"]';
    } else {
      const role = el.getAttribute("role");
      const ariaLabel = el.getAttribute("aria-label");
      if (role && ariaLabel) {
        raw = '[role="' + escapeAttr(role) + '"][aria-label="' + escapeAttr(ariaLabel) + '"]';
      } else {
        // Tier 3 — nth-of-type CSS path bounded at 5 levels (4 ancestors + self).
        const path: string[] = [];
        let cur: Element | null = el;
        for (
          let i = 0;
          i < 5 && cur && cur.nodeType === 1 && cur !== document.documentElement;
          i++
        ) {
          const ctag = (cur.tagName || "").toLowerCase();
          path.unshift(ctag + ":nth-of-type(" + nthOfType(cur) + ")");
          cur = cur.parentElement;
        }
        if (path.length > 0) {
          raw = path.join(" > ");
        } else if (el.classList && el.classList.length > 0) {
          const cls: string[] = [];
          for (let i = 0; i < el.classList.length && i < 3; i++) {
            cls.push(escapeCls(el.classList[i]!));
          }
          raw = tag + "." + cls.join(".");
        } else {
          raw = tag || "*";
        }
      }
    }
    if (raw.length <= selectorMaxLen) {
      return { selector: raw, truncated: false, originalLength: raw.length };
    }
    return { selector: tag || "*", truncated: true, originalLength: raw.length };
  }
  function bboxOf(el: Element): OverflowBbox | null {
    try {
      const r = el.getBoundingClientRect();
      if (!r) return null;
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    } catch (_) {
      return null;
    }
  }
  function inViewport(el: Element): boolean {
    try {
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      // Fully off-screen if right<=0 OR bottom<=0 OR left>=vw OR top>=vh.
      if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  // 1. viewport-horizontal — singleton finding before the element walk.
  let scanCapped = false;
  if (wantVpHorizontal) {
    try {
      const docEl = document.documentElement;
      if (docEl) {
        const sw = docEl.scrollWidth;
        const cw = docEl.clientWidth;
        if (sw > cw + epsilon) {
          // Best-effort: identify the widest descendant whose bbox extends
          // past the viewport. Bounded scan (first 500 candidates) so the
          // singleton stays cheap.
          let widestSel: string | undefined;
          let widestW = 0;
          try {
            const candidates = document.body
              ? document.body.querySelectorAll("*")
              : ([] as unknown as NodeListOf<Element>);
            const max = candidates.length < 500 ? candidates.length : 500;
            for (let i = 0; i < max; i++) {
              const c = candidates[i]!;
              const r = c.getBoundingClientRect();
              if (r.right > cw + epsilon && r.width > widestW) {
                widestW = r.width;
                const s = synth(c);
                widestSel = s.selector;
              }
            }
          } catch {
            // best-effort widest-descendant scan; leave widestSel undefined on failure
          }
          findings.push({
            selector: "html",
            selectorTruncated: false,
            selectorOriginalLength: 4,
            bbox: { x: 0, y: 0, w: cw, h: docEl.clientHeight },
            type: "viewport-horizontal",
            evidence: {
              documentScrollWidth: sw,
              viewportWidth: cw,
              overrunPx: sw - cw,
              ...(widestSel
                ? { widestDescendantSelector: widestSel, widestDescendantWidth: widestW }
                : {}),
            },
          });
        }
      }
    } catch {
      // best-effort viewport-overflow probe; skip section on hostile docs
    }
  }

  // 2. Element walk for layout / clipped / text-ellipsis.
  if (wantLayout || wantClipped || wantEllipsis) {
    let all: NodeListOf<Element>;
    try {
      all = document.querySelectorAll("*");
    } catch (_) {
      return { findings, scanCapped: false };
    }
    const totalCount = all.length;
    const scanLimit = totalCount < args.maxElements ? totalCount : args.maxElements;
    if (totalCount > args.maxElements) scanCapped = true;

    for (let i = 0; i < scanLimit; i++) {
      const el = all[i]!;
      if (el.nodeType !== 1) continue;
      if (args.scope === "viewport" && !inViewport(el)) continue;

      let cs: CSSStyleDeclaration | null = null;
      try {
        cs = getComputedStyle(el);
      } catch (_) {
        continue;
      }
      if (!cs) continue;

      const sw = el.scrollWidth;
      const sh = el.scrollHeight;
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      const overX = sw > cw + epsilon;
      const overY = sh > ch + epsilon;

      const ox = cs.overflowX || "";
      const oy = cs.overflowY || "";

      const isScroll = (v: string): boolean => v === "auto" || v === "scroll";
      const isClip = (v: string): boolean => v === "hidden" || v === "clip";

      if (wantLayout && (overX || overY)) {
        const axisScrollableX = isScroll(ox);
        const axisScrollableY = isScroll(oy);
        if ((overX && axisScrollableX) || (overY && axisScrollableY)) {
          const s = synth(el);
          findings.push({
            selector: s.selector,
            selectorTruncated: s.truncated,
            selectorOriginalLength: s.originalLength,
            bbox: bboxOf(el),
            type: "layout",
            evidence: {
              scrollWidth: sw,
              clientWidth: cw,
              scrollHeight: sh,
              clientHeight: ch,
              overflowX: ox,
              overflowY: oy,
            },
          });
        }
      }

      if (wantClipped && (overX || overY)) {
        const clipX = isClip(ox);
        const clipY = isClip(oy);
        if ((overX && clipX) || (overY && clipY)) {
          const s = synth(el);
          findings.push({
            selector: s.selector,
            selectorTruncated: s.truncated,
            selectorOriginalLength: s.originalLength,
            bbox: bboxOf(el),
            type: "clipped",
            evidence: {
              scrollWidth: sw,
              clientWidth: cw,
              scrollHeight: sh,
              clientHeight: ch,
              overflowX: ox,
              overflowY: oy,
            },
          });
        }
      }

      if (wantEllipsis) {
        const to = cs.textOverflow || "";
        if (to === "ellipsis" && overX) {
          // Element's full text (DOM truth) + a best-effort visible prefix.
          // The visible prefix is heuristic: substring of the textContent
          // proportional to clientWidth/scrollWidth. The agent reads
          // `fullText` for the truth.
          const fullText = (el.textContent || "").replace(/\s+/g, " ").trim();
          let visibleText = fullText;
          if (sw > 0 && cw > 0 && fullText.length > 0) {
            const ratio = cw / sw;
            const cutoff = Math.max(0, Math.floor(fullText.length * ratio));
            visibleText = fullText.slice(0, cutoff);
          }
          const s = synth(el);
          findings.push({
            selector: s.selector,
            selectorTruncated: s.truncated,
            selectorOriginalLength: s.originalLength,
            bbox: bboxOf(el),
            type: "text-ellipsis",
            evidence: {
              scrollWidth: sw,
              clientWidth: cw,
              visibleText,
              fullText,
            },
          });
        }
      }
    }
  }

  return { findings, scanCapped };
};

/** Thin Page-shaped adapter so the unit tests can stub the page surface.
 *  Mirrors the patterns in `dom_export` / `element_export`. `evaluate`
 *  takes a real function (Playwright serializes it + invokes in-page) —
 *  passing a stringified arrow returns the function uncalled. */
export interface OverflowDetectPage {
  evaluate<T, Arg>(fn: (arg: Arg) => T | Promise<T>, args?: Arg): Promise<T>;
}

export async function detectOverflow(
  page: OverflowDetectPage,
  args: OverflowDetectArgs = {},
): Promise<OverflowDetectResult> {
  const scope: OverflowScope = args.scope ?? "document";
  const typeSet = resolveTypes(args.types);
  const rawLimit = args.limit ?? DEFAULT_LIMIT;
  if (!(rawLimit > 0)) {
    throw new Error(`overflow_detect: limit must be > 0 — got ${rawLimit}.`);
  }
  const limit = Math.min(rawLimit, MAX_LIMIT);

  const raw = await page.evaluate(PAGE_DETECT_FN, {
    types: Array.from(typeSet),
    scope,
    maxElements: MAX_ELEMENTS_SCANNED,
    epsilon: OVERFLOW_EPSILON,
    selectorMaxLen: SELECTOR_MAX_LEN,
  });

  const findings: OverflowFinding[] = [];
  for (const rf of raw.findings) {
    // If selector was truncated, fold the original-length note into
    // evidence — the agent shouldn't have to guess why the selector is
    // a bare tag.
    if (rf.selectorTruncated) {
      findings.push({
        selector: rf.selector,
        bbox: rf.bbox,
        type: rf.type,
        evidence: {
          selectorTruncated: true,
          originalLength: rf.selectorOriginalLength,
        },
      });
    } else {
      findings.push({
        selector: rf.selector,
        bbox: rf.bbox,
        type: rf.type,
        evidence: rf.evidence,
      });
    }
  }

  const { kept, truncated } = applyLimit(findings, limit);
  const warnings: string[] = [];
  if (raw.scanCapped) {
    warnings.push(
      `scan stopped at MAX_ELEMENTS_SCANNED (${MAX_ELEMENTS_SCANNED}) — re-run with scope:viewport for a narrower pass`,
    );
  }

  return {
    ok: true,
    scope,
    findings: kept,
    truncated,
    warnings,
  };
}
