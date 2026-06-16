// `workers` — a dedicated Web Worker and a Service Worker. Exercises workers_list,
// worker_message_send, worker_messages_read, sw_intercept_fetch/sw_unintercept_fetch.
// The SW and worker scripts are served as real same-origin routes (a SW cannot be
// a blob URL).
import type { Surface } from "../types.js";
import { doc } from "../html.js";

const WORKER_JS = `
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'square') {
    self.postMessage({ type: 'result', value: e.data.value * e.data.value });
  } else {
    self.postMessage({ type: 'echo', value: e.data });
  }
});
self.postMessage({ type: 'ready' });
`;

const SW_JS = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === '/workers/sw-ping') {
    e.respondWith(new Response(JSON.stringify({ fromServiceWorker: true }), {
      headers: { 'content-type': 'application/json' },
    }));
  }
});
`;

export const workers: Surface = {
  id: "workers",
  path: "/workers",
  title: "Workers surface",
  blurb: "dedicated Web Worker + Service Worker with message round-trips",
  html: () =>
    doc(
      "Workers surface",
      `
<section class="card">
  <button id="spawn" data-testid="spawn-worker">spawn worker + square(7)</button>
  <button id="reg-sw" data-testid="register-sw">register service worker</button>
  <button id="sw-fetch" data-testid="sw-fetch">fetch /workers/sw-ping</button>
  <pre id="w-out" data-testid="worker-out"></pre>
</section>
`,
      {
        surfaceId: "workers",
        script: `
const out = document.getElementById('w-out');
let worker;
document.getElementById('spawn').addEventListener('click', () => {
  worker = new Worker('/workers/worker.js');
  worker.addEventListener('message', (e) => { out.textContent += JSON.stringify(e.data) + '\\n'; });
  worker.postMessage({ type: 'square', value: 7 });
  window.__worker = worker;
});
document.getElementById('reg-sw').addEventListener('click', async () => {
  try {
    const reg = await navigator.serviceWorker.register('/workers/sw.js', { scope: '/workers/' });
    out.textContent += 'sw-registered:' + (reg.scope || 'ok') + '\\n';
  } catch (err) { out.textContent += 'sw-error:' + err + '\\n'; }
});
document.getElementById('sw-fetch').addEventListener('click', async () => {
  const r = await fetch('/workers/sw-ping');
  out.textContent += 'sw-ping:' + (await r.text()) + '\\n';
});
`,
      },
    ),
  routes: [
    {
      method: "GET",
      path: "/workers/worker.js",
      handle: ({ res }) => {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(WORKER_JS);
      },
    },
    {
      method: "GET",
      path: "/workers/sw.js",
      handle: ({ res }) => {
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "service-worker-allowed": "/",
        });
        res.end(SW_JS);
      },
    },
    {
      method: "GET",
      path: "/workers/sw-ping",
      handle: ({ res }) => {
        // Network fallback when the SW is not controlling the request.
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ fromServiceWorker: false }));
      },
    },
  ],
};
