/* global document, window, getComputedStyle, NodeFilter -- measure() runs inside page.evaluate, in the browser. */
// Facts about a loaded page at its current viewport, read with page.evaluate(measure).
// It has to stay one self-contained function: Playwright sends its source text to the page.
//   scrollW / vw      document scroll width against the viewport width (overflow-x when scrollW is larger)
//   wider             elements whose own box is wider than the viewport
//   uncontained       elements whose box ends past the right edge and that sit in no clipping or scrolling ancestor
//   words             words of visible text that overlap the first screen (a text node counts whole when any part of it is inside)
//   h1                every h1 with its text and whether it takes up room on screen
export function measure() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const root = document.documentElement;
  const tidy = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (el) =>
    el.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
      opacityProperty: true,
      visibilityProperty: true,
    });
  const label = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (cls ? `.${cls}` : "");
  };

  const overflowCache = new Map();
  const clips = (el) => {
    if (!overflowCache.has(el)) overflowCache.set(el, getComputedStyle(el).overflowX !== "visible");
    return overflowCache.get(el);
  };
  const contained = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
      if (clips(p)) return true;
    }
    return false;
  };

  let wider = 0;
  let uncontained = 0;
  const samples = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width > vw + 0.5) wider += 1;
    if (r.right > vw + 0.5 && r.width > 0 && !contained(el)) {
      uncontained += 1;
      if (samples.length < 3) samples.push(`${label(el)}:${Math.round(r.right)}`);
    }
  }

  let words = 0;
  const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || skip.test(parent.tagName) || !visible(parent)) continue;
    range.selectNodeContents(node);
    const inside = Array.from(range.getClientRects()).some(
      (r) =>
        r.width > 1.5 && r.height > 1.5 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
    );
    if (!inside) continue;
    words += (node.textContent ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }

  const h1 = Array.from(document.querySelectorAll("h1")).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      text: tidy(el.textContent).slice(0, 120),
      onScreen: visible(el) && r.width > 1.5 && r.height > 1.5,
    };
  });

  return {
    vw,
    vh,
    scrollW: root.scrollWidth,
    docH: Math.max(root.scrollHeight, document.body.scrollHeight),
    wider,
    uncontained,
    samples,
    words,
    h1,
    lede: tidy(document.querySelector(".browx-lede")?.textContent).slice(0, 160),
    theme: root.dataset.theme ?? "",
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    bg: getComputedStyle(document.body).backgroundColor,
  };
}
