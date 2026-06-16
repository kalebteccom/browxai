// `core` — the read/eval/stealth landing surface. Stable anchors for snapshot,
// find, inspect, text_search, verify_*, screenshot, generate_locator, point_probe,
// eval_js/poll_eval, and a place for stealth/extensions probes.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const core: Surface = {
  id: "core",
  path: "/core",
  title: "Core read surface",
  blurb: "headings, links, buttons, status regions, hidden + overflowing elements",
  html: () =>
    doc(
      "Core read surface",
      `
<section class="card">
  <h2 id="greeting" data-testid="greeting">Hello, browxai</h2>
  <p data-testid="lede">The quick brown fox jumps over the lazy dog.</p>
  <p>Find me by text: <span data-testid="needle">unique-needle-7f3a</span>.</p>
  <a href="/forms" data-testid="to-forms" role="link">Go to forms</a>
  <button id="ping" data-testid="ping">Ping</button>
  <output id="status" data-status data-testid="status">idle</output>
</section>

<section class="card">
  <h2>Lists for extract / verify_count</h2>
  <ul data-testid="fruits">
    <li class="fruit">apple</li>
    <li class="fruit">banana</li>
    <li class="fruit">cherry</li>
  </ul>
  <span hidden data-testid="hidden-el">invisible</span>
  <input data-testid="text-value" value="prefilled" readonly />
</section>

<section class="card">
  <h2>Overflow probe</h2>
  <div data-testid="overflow-box" style="width:120px;height:40px;overflow:hidden;white-space:nowrap;border:1px solid #888">
    this text is far too wide for its tiny clipping container and overflows horizontally
  </div>
</section>

<section class="card">
  <h2>Stealth / fingerprint probe</h2>
  <pre id="fp" data-testid="fingerprint"></pre>
</section>
`,
      {
        surfaceId: "core",
        script: `
const status = document.getElementById('status');
document.getElementById('ping').addEventListener('click', () => {
  status.textContent = 'pong';
  status.setAttribute('data-clicked', '1');
});
// Fingerprint readout (for stealth verification).
document.getElementById('fp').textContent = JSON.stringify({
  webdriver: navigator.webdriver,
  languages: navigator.languages,
  plugins: navigator.plugins.length,
  hasChrome: typeof window.chrome,
}, null, 2);
// A counter that eval_js / poll_eval can observe advancing.
window.__counter = 0;
setInterval(() => { window.__counter++; }, 100);
`,
      },
    ),
};
