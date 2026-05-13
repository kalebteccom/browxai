// Visible-rect bbox computation — first-consumer ask #5.
//
// `getBoundingClientRect()` intersected with each ancestor whose `overflow` isn't
// `visible`, then with the viewport. Returns null + clipped:true when the result
// is empty. Same definition site-docs's runtime computes, so calibration-time
// bbox == execution-time bbox for the same selector.

import type { CDPSession } from "playwright-core";

export interface VisibleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Function source (runs in page context). Stringified so we can pass it to
// `Runtime.callFunctionOn` with the resolved DOM node as `this`.
const VISIBLE_RECT_FN = `function () {
  function r(rect) { return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; }
  let b = r(this.getBoundingClientRect());
  let n = this.parentElement;
  while (n) {
    const cs = getComputedStyle(n);
    if (cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
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
  // Viewport
  b = {
    left:   Math.max(b.left,   0),
    top:    Math.max(b.top,    0),
    right:  Math.min(b.right,  window.innerWidth),
    bottom: Math.min(b.bottom, window.innerHeight),
  };
  if (b.right <= b.left || b.bottom <= b.top) return null;
  return { x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top };
}`;

/**
 * Compute the visible-rect bbox of a CDP-known DOM node. Returns null when the
 * element is fully clipped (offscreen, inside a collapsed overflow container,
 * detached). The caller surfaces null as `bbox: null, clipped: true`.
 */
export async function visibleRect(cdp: CDPSession, backendDOMNodeId: number): Promise<VisibleRect | null> {
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
