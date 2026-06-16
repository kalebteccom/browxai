// `perf` — a deliberately busy page: a layout-thrash loop, a memory allocator, a
// rAF animation, and a CPU-heavy compute button. Exercises perf_start/stop/insights,
// perf_audit, coverage_start/stop, layout_thrash_trace, heap_snapshot/retainers,
// memory_diff, cpu_emulate, clock, seed_random.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const perf: Surface = {
  id: "perf",
  path: "/perf",
  title: "Performance surface",
  blurb: "layout thrash, memory growth, animation, CPU-heavy compute",
  html: () =>
    doc(
      "Performance surface",
      `
<section class="card">
  <button id="thrash" data-testid="thrash">layout thrash x500</button>
  <button id="alloc" data-testid="alloc">allocate 50k objects</button>
  <button id="compute" data-testid="compute">CPU compute (sum primes)</button>
  <div id="box" data-testid="anim-box" style="width:40px;height:40px;background:#0b6"></div>
  <output id="perf-out" data-status data-testid="perf-out">idle</output>
</section>
`,
      {
        surfaceId: "perf",
        script: `
const out = document.getElementById('perf-out');
const box = document.getElementById('box');
// Forced reflow loop (read-after-write).
document.getElementById('thrash').addEventListener('click', () => {
  for (let i = 0; i < 500; i++) { box.style.width = (40 + (i % 20)) + 'px'; void box.offsetWidth; }
  out.textContent = 'thrashed';
});
// Retained allocation (heap growth between two snapshots).
window.__retained = window.__retained || [];
document.getElementById('alloc').addEventListener('click', () => {
  for (let i = 0; i < 50000; i++) window.__retained.push({ i, s: 'x'.repeat(16) });
  out.textContent = 'allocated:' + window.__retained.length;
});
document.getElementById('compute').addEventListener('click', () => {
  let sum = 0;
  for (let n = 2; n < 200000; n++) { let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; } if (p) sum += n; }
  out.textContent = 'primesum:' + sum;
});
// Continuous rAF animation for tracing.
let t = 0;
function tick() { box.style.transform = 'translateX(' + (Math.sin(t += 0.1) * 50) + 'px)'; requestAnimationFrame(tick); }
requestAnimationFrame(tick);
`,
      },
    ),
};
