// `network` — fetch/XHR endpoints + a WebSocket echo. Exercises network_read,
// network_body, route/route_queue/unroute, network_emulate, act_and_wait_for_network,
// and the ws_read/ws_send/ws_intercept family. A /api/secret route returns a
// token-bearing body so register_secret masking can be verified end-to-end.
import type { Surface } from "../types.js";
import { doc, json } from "../html.js";

export const network: Surface = {
  id: "network",
  path: "/network",
  title: "Network surface",
  blurb: "fetch/XHR JSON + slow + streaming endpoints, WebSocket echo",
  html: () =>
    doc(
      "Network surface",
      `
<section class="card">
  <button id="do-json" data-testid="do-json">fetch /api/json</button>
  <button id="do-slow" data-testid="do-slow">fetch /api/slow (1s)</button>
  <button id="do-post" data-testid="do-post">POST /api/echo</button>
  <pre id="net-out" data-testid="net-out"></pre>
</section>

<section class="card">
  <h2>WebSocket echo</h2>
  <button id="ws-connect" data-testid="ws-connect">connect</button>
  <button id="ws-send" data-testid="ws-send">send hello</button>
  <pre id="ws-out" data-testid="ws-out"></pre>
</section>
`,
      {
        surfaceId: "network",
        script: `
const out = document.getElementById('net-out');
async function show(p) { out.textContent = await (await p).text(); }
document.getElementById('do-json').addEventListener('click', () => show(fetch('/api/json')));
document.getElementById('do-slow').addEventListener('click', () => show(fetch('/api/slow')));
document.getElementById('do-post').addEventListener('click', () =>
  show(fetch('/api/echo', { method: 'POST', body: JSON.stringify({ ping: 1 }), headers: { 'content-type': 'application/json' } })));

let sock;
const wsOut = document.getElementById('ws-out');
document.getElementById('ws-connect').addEventListener('click', () => {
  sock = new WebSocket('ws://' + location.host + '/ws/echo');
  sock.addEventListener('open', () => { wsOut.textContent += 'open\\n'; });
  sock.addEventListener('message', (e) => { wsOut.textContent += 'recv:' + e.data + '\\n'; });
});
document.getElementById('ws-send').addEventListener('click', () => { sock && sock.send('hello'); });
`,
      },
    ),
  routes: [
    {
      method: "GET",
      path: "/api/json",
      handle: ({ res }) => {
        const { type, body } = json({ ok: true, items: [1, 2, 3], message: "json-payload" });
        res.writeHead(200, { "content-type": type });
        res.end(body);
      },
    },
    {
      method: "GET",
      path: "/api/slow",
      handle: ({ res }) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            const { type, body } = json({ ok: true, slow: true });
            res.writeHead(200, { "content-type": type });
            res.end(body);
            resolve();
          }, 1000);
        }),
    },
    {
      method: "POST",
      path: "/api/echo",
      handle: ({ res, body }) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ echo: body }));
      },
    },
    {
      method: "GET",
      path: "/api/secret",
      handle: ({ res }) => {
        // A response body carrying a sensitive-looking token, for register_secret
        // egress-masking verification.
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ token: "sk-test-DEADBEEF-secret-value", user: "demo" }));
      },
    },
    {
      method: "GET",
      path: "/api/stream",
      handle: ({ res }) =>
        new Promise<void>((resolve) => {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          let n = 0;
          const t = setInterval(() => {
            res.write(`chunk-${n}\n`);
            if (++n >= 5) {
              clearInterval(t);
              res.end("done\n");
              resolve();
            }
          }, 100);
        }),
    },
  ],
  sockets: [
    {
      path: "/ws/echo",
      onConnect: (socket) => {
        socket.send("welcome");
        socket.onMessage((text) => socket.send("echo:" + text));
      },
    },
  ],
};
