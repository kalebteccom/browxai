/// <reference lib="dom" />
// `overflow_detect` — the in-page detector function literal.
//
// The CDP/Playwright-bound half: `PAGE_DETECT_FN` walks the live DOM, applies
// the four overflow shape detectors, and returns raw findings. Split out of
// overflow-detect.ts so the engine-blind domain (types + pure helpers) stays
// free of any page-realm code. The `detectOverflow` adapter imports this
// literal and feeds it to `page.evaluate`.
//
// Page-side function is passed as a REAL function literal (not a
// stringified arrow) so Playwright's `Page.evaluate(fn, arg)` path
// serializes the source and invokes in-page with the arg. The same trap
// burned `dom_export`'s `PAGE_WALK_FN` and `element_export`'s discovery
// function — a stringified `(args) => {...}` evaluates to the function
// value uncalled, which CDP can't serialize → undefined. Kept a named
// uppercase `*_FN` literal for the `no-page-eval-stringified-arrow`
// ESLint exemption + the serialization contract.

import type {
  OverflowType,
  OverflowScope,
  OverflowBbox,
  OverflowEvidence,
  PageRawFinding,
  PageRawResult,
} from "./overflow-detect-types.js";

/** Page-side detector. Receives the resolved type mask + scope + scan
 *  budget; returns raw findings + a `scanCapped` flag. Walk is bounded
 *  by `MAX_ELEMENTS_SCANNED`. Passed as a real function literal — see
 *  the file-header note on the stringified-arrow trap. */
export const PAGE_DETECT_FN = (args: {
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
  /** Tier 3 — nth-of-type CSS path (≤5 levels), else a class selector, else the
   *  bare tag. */
  function synthTier3(el: Element, tag: string): string {
    const path: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; i < 5 && cur && cur.nodeType === 1 && cur !== document.documentElement; i++) {
      const ctag = (cur.tagName || "").toLowerCase();
      path.unshift(ctag + ":nth-of-type(" + nthOfType(cur) + ")");
      cur = cur.parentElement;
    }
    if (path.length > 0) return path.join(" > ");
    if (el.classList && el.classList.length > 0) {
      const cls: string[] = [];
      for (let i = 0; i < el.classList.length && i < 3; i++) cls.push(escapeCls(el.classList[i]!));
      return tag + "." + cls.join(".");
    }
    return tag || "*";
  }

  /** Compute the raw (un-truncated) selector via the tiered preference:
   *  data-testid → role+aria-label → tier-3 path. */
  function synthRaw(el: Element, tag: string): string {
    const testId = el.getAttribute("data-testid");
    if (testId) return '[data-testid="' + escapeAttr(testId) + '"]';
    const role = el.getAttribute("role");
    const ariaLabel = el.getAttribute("aria-label");
    if (role && ariaLabel) {
      return '[role="' + escapeAttr(role) + '"][aria-label="' + escapeAttr(ariaLabel) + '"]';
    }
    return synthTier3(el, tag);
  }

  function synth(el: Element): { selector: string; truncated: boolean; originalLength: number } {
    const tag = (el.tagName || "").toLowerCase();
    const raw = synthRaw(el, tag);
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
  if (wantVpHorizontal) detectViewportHorizontal();

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

      classifyElement(el, cs);
    }
  }

  return { findings, scanCapped };

  // --- nested classifiers (must stay nested for page serialization) ---

  /** Find the widest descendant whose bbox overruns the viewport (bounded scan
   *  of the first 500 candidates so the singleton stays cheap). */
  function widestOverrunDescendant(cw: number): { sel?: string; w: number } {
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
          widestSel = synth(c).selector;
        }
      }
    } catch {
      // best-effort widest-descendant scan; leave widestSel undefined on failure
    }
    return { sel: widestSel, w: widestW };
  }

  /** viewport-horizontal singleton — the document scrolls horizontally past the
   *  viewport. Best-effort; skips on hostile docs. */
  function detectViewportHorizontal(): void {
    try {
      const docEl = document.documentElement;
      if (!docEl) return;
      const sw = docEl.scrollWidth;
      const cw = docEl.clientWidth;
      if (sw <= cw + epsilon) return;
      const widest = widestOverrunDescendant(cw);
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
          ...(widest.sel
            ? { widestDescendantSelector: widest.sel, widestDescendantWidth: widest.w }
            : {}),
        },
      });
    } catch {
      // best-effort viewport-overflow probe; skip section on hostile docs
    }
  }

  function classifyElement(el: Element, cs: CSSStyleDeclaration): void {
    const geom = {
      sw: el.scrollWidth,
      sh: el.scrollHeight,
      cw: el.clientWidth,
      ch: el.clientHeight,
    };
    const overX = geom.sw > geom.cw + epsilon;
    const overY = geom.sh > geom.ch + epsilon;
    if (!overX && !overY && !wantEllipsis) return;
    const ox = cs.overflowX || "";
    const oy = cs.overflowY || "";
    detectLayoutClip(el, geom, { overX, overY, ox, oy });
    detectEllipsis(el, cs, geom, overX);
  }

  /** Layout (overflow on a scrollable axis) + clipped (overflow on a hidden/clip
   *  axis) findings share the same evidence shape; emit whichever matches. */
  function detectLayoutClip(
    el: Element,
    geom: { sw: number; sh: number; cw: number; ch: number },
    o: { overX: boolean; overY: boolean; ox: string; oy: string },
  ): void {
    const isScroll = (v: string): boolean => v === "auto" || v === "scroll";
    const isClip = (v: string): boolean => v === "hidden" || v === "clip";
    const evidence = {
      scrollWidth: geom.sw,
      clientWidth: geom.cw,
      scrollHeight: geom.sh,
      clientHeight: geom.ch,
      overflowX: o.ox,
      overflowY: o.oy,
    };
    if (wantLayout && ((o.overX && isScroll(o.ox)) || (o.overY && isScroll(o.oy)))) {
      pushFinding(el, "layout", evidence);
    }
    if (wantClipped && ((o.overX && isClip(o.ox)) || (o.overY && isClip(o.oy)))) {
      pushFinding(el, "clipped", evidence);
    }
  }

  function detectEllipsis(
    el: Element,
    cs: CSSStyleDeclaration,
    geom: { sw: number; cw: number },
    overX: boolean,
  ): void {
    if (!wantEllipsis || (cs.textOverflow || "") !== "ellipsis" || !overX) return;
    // full text (DOM truth) + a heuristic visible prefix proportional to
    // clientWidth/scrollWidth; the agent reads `fullText` for the truth.
    const fullText = (el.textContent || "").replace(/\s+/g, " ").trim();
    let visibleText = fullText;
    if (geom.sw > 0 && geom.cw > 0 && fullText.length > 0) {
      const cutoff = Math.max(0, Math.floor(fullText.length * (geom.cw / geom.sw)));
      visibleText = fullText.slice(0, cutoff);
    }
    pushFinding(el, "text-ellipsis", {
      scrollWidth: geom.sw,
      clientWidth: geom.cw,
      visibleText,
      fullText,
    });
  }

  function pushFinding(el: Element, type: OverflowType, evidence: OverflowEvidence): void {
    const s = synth(el);
    findings.push({
      selector: s.selector,
      selectorTruncated: s.truncated,
      selectorOriginalLength: s.originalLength,
      bbox: bboxOf(el),
      type,
      evidence,
    });
  }
};
