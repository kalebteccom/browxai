// `console` — emits log/info/warn/error/debug on load and on demand, plus an
// uncaught error and an unhandled rejection trigger. Exercises console_read.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const consoleSurface: Surface = {
  id: "console",
  path: "/console",
  title: "Console surface",
  blurb: "console.log/info/warn/error/debug + uncaught error + rejection",
  html: () =>
    doc(
      "Console surface",
      `
<section class="card">
  <button id="emit" data-testid="emit-logs">emit all levels</button>
  <button id="boom" data-testid="throw-error">throw uncaught</button>
  <button id="reject" data-testid="reject-promise">unhandled rejection</button>
  <output id="c-out" data-status data-testid="console-status">ready</output>
</section>
`,
      {
        surfaceId: "console",
        script: `
console.log('load-log');
console.info('load-info');
document.getElementById('emit').addEventListener('click', () => {
  console.log('btn-log %s', 'arg');
  console.info('btn-info');
  console.warn('btn-warn');
  console.error('btn-error');
  console.debug('btn-debug');
  document.getElementById('c-out').textContent = 'emitted';
});
document.getElementById('boom').addEventListener('click', () => { setTimeout(() => { throw new Error('uncaught-boom'); }, 0); });
document.getElementById('reject').addEventListener('click', () => { Promise.reject(new Error('unhandled-rejection')); });
`,
      },
    ),
};
