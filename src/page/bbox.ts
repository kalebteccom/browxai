// Visible-rect bbox computation — .
//
// `getBoundingClientRect()` intersected with each ancestor whose `overflow` isn't
// `visible`, then with the viewport. Returns null + clipped:true when the result
// is empty. Same definition site-docs's runtime computes, so calibration-time
// bbox == execution-time bbox for the same selector.

import type { CDPSession, Frame, Page } from "playwright-core";

export interface VisibleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Function source (runs in page context). Stringified so we can pass it to
// `Runtime.callFunctionOn` with the resolved DOM node as `this`.
//
// clipping is *only* triggered by `overflow: hidden` or `overflow: clip`.
// `overflow: auto` / `scroll` are scrollable, **not** clipping — the element's
// `getBoundingClientRect()` already accounts for the current scroll position,
// so the rect reflects the element's actual visible position. The previous
// check treated any non-`visible` overflow as clipping, which collapsed bboxes
// to zero on attached Chromes whose body/html or layout containers used
// `overflow: auto` (common pattern). Reported by the non-Claude verification
// run: visible elements returned `bbox: null` + `actionable: "off-screen"`.
const VISIBLE_RECT_FN = `function () {
  function r(rect) { return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; }
  function clips(cs) {
    return cs.overflow === 'hidden' || cs.overflow === 'clip'
        || cs.overflowX === 'hidden' || cs.overflowX === 'clip'
        || cs.overflowY === 'hidden' || cs.overflowY === 'clip';
  }
  let b = r(this.getBoundingClientRect());
  let n = this.parentElement;
  while (n) {
    const cs = getComputedStyle(n);
    if (clips(cs)) {
      const pr = r(n.getBoundingClientRect());
      b = {
        left:   Math.max(b.left,   pr.left),
        top:    Math.max(b.top,    pr.top),
        right:  Math.min(b.right,  pr.right),
        bottom: Math.min(b.bottom, pr.bottom),
      };
    }
    n = n.parentElement;
  }
  // Viewport. Fall back to documentElement / document.body dims when innerWidth/
  // innerHeight read as zero (some attached contexts report bogus window metrics
  // before first paint).
  var vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
  var vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
  if (!vw || !vh) {
    // Last resort: skip viewport intersection — return the un-clipped client rect.
    // Better to over-report bbox than to under-report (which currently produces
    // bogus 'off-screen' actionability).
    if (b.right <= b.left || b.bottom <= b.top) return null;
    return { x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top };
  }
  b = {
    left:   Math.max(b.left,   0),
    top:    Math.max(b.top,    0),
    right:  Math.min(b.right,  vw),
    bottom: Math.min(b.bottom, vh),
  };
  if (b.right <= b.left || b.bottom <= b.top) return null;
  return { x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top };
}`;

/**
 * Compute the visible-rect bbox of a CDP-known DOM node. Returns null when the
 * element is fully clipped (offscreen, inside a collapsed overflow container,
 * detached). The caller surfaces null as `bbox: null, clipped: true`.
 */
export async function visibleRect(
  cdp: CDPSession,
  backendDOMNodeId: number,
): Promise<VisibleRect | null> {
  try {
    const { object } = (await cdp.send("DOM.resolveNode", { backendNodeId: backendDOMNodeId })) as {
      object: { objectId?: string };
    };
    if (!object?.objectId) return null;
    const { result } = (await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: VISIBLE_RECT_FN,
      returnByValue: true,
    })) as { result: { value?: VisibleRect | null } };
    return result.value ?? null;
  } catch {
    // Node detached, no live DOM, etc. Treat as clipped.
    return null;
  }
}

/**
 * Playwright locator-based bounding box, used as a *fallback* when the CDP
 * `visibleRect` path returns null. On attached/BYOB Chromes the CDP
 * `DOM.resolveNode` → `Runtime.callFunctionOn` rect path can spuriously fail
 * for DOM-walk-sourced nodes (no live backend node, cross-frame quirks),
 * producing a bogus `bbox:null` → `off-screen` for an element that is in fact
 * rendered. Playwright's own `boundingBox()` resolves the element through the
 * locator engine and reports its real rendered box; a non-empty box means
 * "this is on the page" regardless of what the CDP path said. Best-effort:
 * any error / empty box → null (the caller then treats it as truly clipped).
 *
 * `opts.timeoutMs` caps Playwright's auto-wait so a probe call against an
 * unmatched selector fails fast instead of pinning the default `actionTimeout`
 * (30 s). This is the perf hot-path for `find()` candidate evaluation — find()
 * emits locator hints derived from DOM-walk-sourced roles that don't always
 * map to a real Playwright role selector (e.g. `role=a` when the tag is `<a>`),
 * and the bounding-box probe on those mismatched hints would otherwise hang
 * for the full action-timeout window per candidate. Default cap is 500 ms —
 * the wedge class is now a known hazard on every call site; per-caller opt-in
 * (e.g. `{ timeoutMs: 1000 }`) raises it when the caller can absorb the wait.
 */
export async function locatorBoundingBox(
  root: Page | Frame,
  selector: string,
  opts: { timeoutMs?: number } = {},
): Promise<VisibleRect | null> {
  const timeoutMs = opts.timeoutMs ?? 500;
  try {
    const box = await root.locator(selector).first().boundingBox({ timeout: timeoutMs });
    if (!box || box.width <= 0 || box.height <= 0) return null;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  } catch {
    return null;
  }
}
