// `point_probe` — read-only coordinate target inspection.
//
// In canvas / virtualised-timeline / painted UIs the real target isn't a
// clean accessible element, so an agent driving by `coords` is trusting a
// screenshot estimate of "what is actually under this point". point_probe
// answers it deterministically: the full `elementsFromPoint` stack with each
// layer's identity + the computed properties that decide hit-testing
// (pointer-events / visibility / z-index / cursor), plus the nearest scroll
// container and clickable ancestor. No agent JS (fixed server script).

import type { Page } from "playwright-core";

const MAX_STACK = 8;

export interface ProbedElement {
  tag: string;
  id?: string;
  testId?: string;
  role?: string;
  name?: string;
  classes?: string;
  pointerEvents: string;
  visibility: string;
  display: string;
  zIndex: string;
  cursor: string;
  bbox: { x: number; y: number; width: number; height: number } | null;
}

export interface PointProbeResult {
  ok: boolean;
  point: { x: number; y: number };
  /** `document.elementsFromPoint(x,y)` top-down, capped at 8. The first entry
   *  is what a real click at this point would hit. */
  stack: ProbedElement[];
  /** nearest scrollable ancestor of the top element (overflow auto/scroll
   *  with overflowing content), or null. */
  scrollContainer: ProbedElement | null;
  /** nearest clickable ancestor of the top element (a/button, role
   *  button/link, [onclick], [tabindex]), or null — what a click here would
   *  *semantically* activate even if the literal hit is a child glyph. */
  clickableAncestor: ProbedElement | null;
  /** present only when `crop:true` — a small PNG (base64) around the point,
   *  bounded; off by default to keep results token-cheap. */
  cropBase64?: string;
}

// `page.evaluate(string)` treats the string as an *expression* — a
// `function(arg){…}` string is never called and args are ignored. So this is
// an arg-less IIFE with the (numeric, zod-validated) coords interpolated in.
function buildProbeScript(x: number, y: number, max: number): string {
  return `(() => {
  var x = ${x}, y = ${y}, MAX = ${max};
  function summ(el) {
    if (!el || !el.tagName) return null;
    var cs = (el.ownerDocument && el.ownerDocument.defaultView)
      ? el.ownerDocument.defaultView.getComputedStyle(el) : null;
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    var cls = (typeof el.className === 'string' && el.className) ? el.className.slice(0, 120) : undefined;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      testId: el.getAttribute ? (el.getAttribute('data-testid') || undefined) : undefined,
      role: el.getAttribute ? (el.getAttribute('role') || undefined) : undefined,
      name: (el.getAttribute && el.getAttribute('aria-label')) ||
            (el.textContent ? el.textContent.trim().slice(0, 40) : undefined) || undefined,
      classes: cls,
      pointerEvents: cs ? cs.pointerEvents : '',
      visibility: cs ? cs.visibility : '',
      display: cs ? cs.display : '',
      zIndex: cs ? cs.zIndex : '',
      cursor: cs ? cs.cursor : '',
      bbox: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
    };
  }
  var els = (document.elementsFromPoint ? document.elementsFromPoint(x, y) : []).slice(0, MAX);
  var top = els[0] || null;
  function scrollAncestor(el) {
    var n = el;
    while (n && n.tagName) {
      var cs = getComputedStyle(n);
      var oy = cs.overflowY, ox = cs.overflowX;
      var scrolly = (oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight;
      var scrollx = (ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth;
      if (scrolly || scrollx) return n;
      n = n.parentElement;
    }
    return null;
  }
  function clickableAncestor(el) {
    var n = el;
    while (n && n.tagName) {
      var t = n.tagName.toLowerCase();
      var role = n.getAttribute ? n.getAttribute('role') : null;
      if (t === 'a' || t === 'button' || role === 'button' || role === 'link' ||
          (n.hasAttribute && (n.hasAttribute('onclick') || n.hasAttribute('tabindex')))) return n;
      n = n.parentElement;
    }
    return null;
  }
  return {
    stack: els.map(summ),
    scrollContainer: top ? summ(scrollAncestor(top)) : null,
    clickableAncestor: top ? summ(clickableAncestor(top)) : null,
  };
})()`;
}

export async function pointProbe(
  page: Page,
  point: { x: number; y: number },
  opts: { crop?: boolean } = {},
): Promise<PointProbeResult> {
  const probed = (await page.evaluate(buildProbeScript(point.x, point.y, MAX_STACK))) as Pick<
    PointProbeResult,
    "stack" | "scrollContainer" | "clickableAncestor"
  >;

  const result: PointProbeResult = {
    ok: true,
    point,
    stack: probed.stack ?? [],
    scrollContainer: probed.scrollContainer ?? null,
    clickableAncestor: probed.clickableAncestor ?? null,
  };

  if (opts.crop) {
    try {
      const half = 40;
      const buf = await page.screenshot({
        clip: {
          x: Math.max(0, point.x - half),
          y: Math.max(0, point.y - half),
          width: half * 2,
          height: half * 2,
        },
        type: "png",
      });
      result.cropBase64 = Buffer.from(buf).toString("base64");
    } catch {
      /* crop is best-effort — the probe stack is the primary signal */
    }
  }
  return result;
}
