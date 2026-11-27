// `caches_put` and a cache-first service worker. `caches_put` is an `action` tool
// that stores a response the caller wrote under the page's origin. An app whose
// service worker answers a script request from CacheStorage then hands the page
// that stored response, so what the page runs depends on what was stored.
//
// The fixture page registers a service worker that answers `/app.js` from the
// cache when it holds an entry and from the network otherwise. The page reports
// what it ran as one paragraph per source (`doc=`, `script=`, `sw=`), so each
// case reads the result with an exact `text_search` and needs no `eval_js`.
//
// Without `eval`, `caches_put` refuses a JavaScript content type and stores a
// JSON-typed body with `X-Content-Type-Options: nosniff`, so the worker hands
// the page a response the browser will not run as a script. With `eval` the
// stored script runs. Only a real Chromium shows that, because the worker, the
// cache lookup and the script MIME check are the browser's own.

import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { engineGate, gatedDescribe } from "./keystone-gate.js";

const KEYSTONE_TIMEOUT = 120_000;

const chromeGate = engineGate("chromium");
const describeChromium = gatedDescribe(chromeGate);

type Booted = Awaited<ReturnType<typeof createServer>>;

/** Script text that appends `<p>{token}</p>` to the page. */
const say = (token: string): string =>
  `(function(){var p=document.createElement("p");p.textContent=${JSON.stringify(token)};` +
  "document.body.appendChild(p);})();";

const SW = `
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  if (new URL(e.request.url).pathname !== "/app.js") return;
  e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); }));
});
`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>caches sw</title></head>
<body>
<p>doc=real</p>
<script>
(function () {
  function say(t) { var p = document.createElement("p"); p.textContent = t; document.body.appendChild(p); }
  if (navigator.serviceWorker.controller) say("sw=controlling");
  navigator.serviceWorker.register("/sw.js").then(function () {
    return navigator.serviceWorker.ready;
  }).then(function () { say("sw=ready"); }).catch(function () { say("sw=error"); });
})();
</script>
<script src="/app.js"></script>
</body></html>`;

const RESPONSES: Record<string, { type: string; body: string }> = {
  "/page": { type: "text/html; charset=utf-8", body: PAGE },
  "/sw.js": { type: "text/javascript", body: SW },
  "/app.js": { type: "text/javascript", body: say("script=real") },
};

let workspace: string;
let site: HttpServer;
let base: string;
let server: Booted | undefined;
const savedEnv: Record<string, string | undefined> = {};

async function call<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = server?.handlers[name];
  if (!fn) throw new Error(`caches-put-sw keystone: no handler "${name}"`);
  const res = await fn(args);
  return JSON.parse((res.content[0] as { text: string }).text) as T;
}

async function has(session: string, token: string): Promise<boolean> {
  const found = await call<{ count: number }>("text_search", {
    session,
    text: token,
    exact: true,
    includeHidden: true,
  });
  return found.count >= 1;
}

/** Poll until the page shows `token`. */
async function appears(session: string, token: string): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await has(session, token)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Open a session whose page is controlled by the fixture's service worker. */
async function controlledSession(session: string): Promise<void> {
  const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
  expect(opened.ok).toBe(true);
  await call("navigate", { session, url: `${base}/page` });
  expect(await appears(session, "sw=ready")).toBe(true);
  await call("navigate", { session, url: `${base}/page` });
  expect(await appears(session, "sw=controlling")).toBe(true);
  expect(await appears(session, "script=real")).toBe(true);
}

beforeAll(async () => {
  if (!chromeGate.run) return;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-caches-sw-"));
  process.env.BROWX_WORKSPACE = workspace;
  site = createHttpServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const hit = RESPONSES[path];
    if (!hit) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": hit.type, "cache-control": "no-store" });
    res.end(hit.body);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => (site ? site.close(() => resolve()) : resolve()));
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

/** Boot a server with `capabilities` for one describe block. */
function serverFor(capabilities?: string): void {
  beforeAll(async () => {
    if (!chromeGate.run) return;
    if (capabilities) process.env.BROWX_CAPABILITIES = capabilities;
    else delete process.env.BROWX_CAPABILITIES;
    server = await createServer({ headless: true });
  }, KEYSTONE_TIMEOUT);
  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    server = undefined;
  }, KEYSTONE_TIMEOUT);
}

describeChromium("caches_put behind a cache-first service worker, default capabilities", () => {
  serverFor();

  it(
    "refuses a JavaScript content type and stores nothing",
    async () => {
      const session = "ks-sw-js";
      await controlledSession(session);
      const put = await call<{ ok: boolean; requiredCapability?: string; reason?: string }>(
        "caches_put",
        {
          session,
          cacheName: "app",
          url: `${base}/app.js`,
          response: { headers: { "content-type": "text/javascript" }, body: say("script=cached") },
        },
      );
      expect(put.ok).toBe(false);
      expect(put.requiredCapability).toBe("eval");
      expect(put.reason).toContain("text/javascript");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(session, "script=real")).toBe(true);
      expect(await has(session, "script=cached")).toBe(false);
      await call("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "stores a JSON-typed body with nosniff, and the page does not run it",
    async () => {
      const session = "ks-sw-json";
      await controlledSession(session);
      const put = await call<{ ok: boolean }>("caches_put", {
        session,
        cacheName: "app",
        url: `${base}/app.js`,
        response: { headers: { "content-type": "application/json" }, body: say("script=cached") },
      });
      expect(put.ok, JSON.stringify(put)).toBe(true);
      const got = await call<{ found: boolean; headers: Record<string, string> }>("caches_get", {
        session,
        cacheName: "app",
        url: `${base}/app.js`,
      });
      expect(got.found).toBe(true);
      expect(got.headers["x-content-type-options"]).toBe("nosniff");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(session, "sw=controlling")).toBe(true);
      // Give the script tag time to load and be refused.
      await appears(session, "script=cached");
      expect(await has(session, "script=cached")).toBe(false);
      await call("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

describeChromium("caches_put behind a cache-first service worker, with eval", () => {
  serverFor("read,navigation,action,human,eval");

  it(
    "stores a JavaScript body as given, and the page runs it",
    async () => {
      const session = "ks-sw-eval";
      await controlledSession(session);
      const put = await call<{ ok: boolean }>("caches_put", {
        session,
        cacheName: "app",
        url: `${base}/app.js`,
        response: { headers: { "content-type": "text/javascript" }, body: say("script=cached") },
      });
      expect(put.ok, JSON.stringify(put)).toBe(true);

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(session, "script=cached")).toBe(true);
      expect(await has(session, "script=real")).toBe(false);
      await call("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
