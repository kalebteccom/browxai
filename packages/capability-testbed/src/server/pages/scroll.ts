// `scroll` — a long page with a sticky header, an infinite-scroll sentinel, and
// an overflowing container. Exercises scroll, set_viewport, overflow_detect,
// point_probe, and lazy-content waits.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const scroll: Surface = {
  id: "scroll",
  path: "/scroll",
  title: "Scroll & overflow surface",
  blurb: "tall page, sticky header, infinite-scroll sentinel, overflow box",
  html: () => {
    const blocks = Array.from(
      { length: 40 },
      (_v, i) => `<p data-block="${i}" data-testid="block-${i}">paragraph block number ${i}</p>`,
    ).join("\n");
    return doc(
      "Scroll & overflow surface",
      `
<div style="position:sticky;top:0;background:#0b6;color:#fff;padding:.5rem" data-testid="sticky-header">sticky header</div>
<div data-testid="overflow-x" style="width:160px;overflow:auto;white-space:nowrap;border:1px solid #888">
  ${"wide ".repeat(60)}
</div>
${blocks}
<div id="sentinel" data-testid="sentinel" style="height:1px"></div>
<div id="loaded" data-testid="lazy-loaded" hidden>lazy content loaded</div>
<p id="bottom" data-testid="bottom">bottom anchor</p>
`,
      {
        surfaceId: "scroll",
        script: `
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      const el = document.getElementById('loaded');
      el.hidden = false;
      el.textContent = 'lazy content loaded at ' + Date.now();
    }
  }
});
io.observe(document.getElementById('sentinel'));
`,
      },
    );
  },
};
