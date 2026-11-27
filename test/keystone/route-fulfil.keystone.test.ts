// Route fulfilment keystone. `route`, `route_queue` and `sw_intercept_fetch`
// answer a request with a body the caller wrote. On a server with the DEFAULT
// capability set they answer data and static requests only; a document, script
// or worker request that matches goes to the real network, so the page runs
// what its own server sent. With `eval` enabled they answer every match.
//
// The resource type is the browser's own classification of the request, which
// is why this runs against a real Chromium: a faked `Route` proves the branch,
// and only a real page load proves that a `<script src>`, a navigation and a
// `new Worker(url)` arrive as the types the branch refuses. The script case
// uses `contentType: "application/json"` on purpose: a browser runs a classic
// script whatever its content type when the response carries no `nosniff`.
//
// `open_session({hars})` follows the same rule for the responses a HAR holds:
// the archive answers the page's fetch, and its copy of the page and of
// `/app.js` is used only with `eval`.
//
// The page reports what it loaded as one paragraph per source (`doc=`,
// `script=`, `api=`, `worker=`, `shared-fetch=`), so each case reads the result
// with an exact `text_search` and needs no `eval_js`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

const KEYSTONE_TIMEOUT = 120_000;

type Booted = Awaited<ReturnType<typeof createServer>>;

/** Script text that appends `<p>{token}</p>` to the page. */
const say = (token: string): string =>
  `(function(){var p=document.createElement("p");p.textContent=${JSON.stringify(token)};` +
  "document.body.appendChild(p);})();";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>route fulfil</title></head>
<body>
<p>doc=real</p>
<script src="/app.js"></script>
<script>
(function () {
  function say(t) { var p = document.createElement("p"); p.textContent = t; document.body.appendChild(p); }
  fetch("/api/data").then(function (r) { return r.json(); })
    .then(function (j) { say("api=" + j.from); })
    .catch(function () { say("api=error"); });
  try {
    var w = new Worker("/worker.js");
    w.onmessage = function (e) { say("worker=" + e.data); };
    w.onerror = function () { say("worker=error"); };
  } catch (e) { say("worker=error"); }
})();
</script>
</body></html>`;

// `/shared` is requested twice by this page: first as a script, then by fetch.
const QUEUE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>route queue</title></head>
<body>
<p>doc=real</p>
<script src="/shared"></script>
<script>
(function () {
  function say(t) { var p = document.createElement("p"); p.textContent = t; document.body.appendChild(p); }
  say("shared-script=" + (window.__shared || "none"));
  fetch("/shared").then(function (r) { return r.text(); })
    .then(function (t) { say("shared-fetch=" + (t === "canned" ? "canned" : "network")); })
    .catch(function () { say("shared-fetch=error"); });
})();
</script>
</body></html>`;

const RESPONSES: Record<string, { type: string; body: string }> = {
  "/page": { type: "text/html; charset=utf-8", body: PAGE },
  "/queue-page": { type: "text/html; charset=utf-8", body: QUEUE_PAGE },
  "/app.js": { type: "text/javascript", body: say("script=real") },
  "/worker.js": { type: "text/javascript", body: 'postMessage("real");' },
  "/api/data": { type: "application/json", body: '{"from":"network"}' },
  "/shared": { type: "text/javascript", body: 'window.__shared = "real";' },
};

let workspace: string;
let site: HttpServer;
let base: string;
const savedEnv: Record<string, string | undefined> = {};

async function boot(capabilities?: string): Promise<Booted> {
  if (capabilities) process.env.BROWX_CAPABILITIES = capabilities;
  else delete process.env.BROWX_CAPABILITIES;
  return createServer({ headless: true });
}

function callerFor(server: Booted) {
  return async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const fn = server.handlers[name];
    if (!fn) throw new Error(`route-fulfil keystone: no handler "${name}"`);
    const res = await fn(args);
    return JSON.parse((res.content[0] as { text: string }).text) as T;
  };
}

type Call = ReturnType<typeof callerFor>;

async function has(call: Call, session: string, token: string): Promise<boolean> {
  const found = await call<{ count: number }>("text_search", {
    session,
    text: token,
    exact: true,
    includeHidden: true,
  });
  return found.count >= 1;
}

/** Poll until the page shows `token`. The fetch and the worker report after
 *  the load event, so a single read straight after `navigate` can be early. */
async function appears(call: Call, session: string, token: string): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await has(call, session, token)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

interface Installed {
  ok: boolean;
  key: string;
  fulfils: string;
  queued?: number;
  active: string[];
}

interface Removed {
  ok: boolean;
  removed: string[];
  skippedExecutable?: number;
  active: string[];
}

interface Denied {
  ok: boolean;
  error: string;
  requiredCapability: string;
  reason?: string;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-route-fulfil-"));
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

describe("route fulfilment with the default capability set", () => {
  let server: Booted;
  let call: Call;
  const session = "ks-route-fulfil";

  beforeAll(async () => {
    server = await boot();
    call = callerFor(server);
    const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
    expect(opened.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "answers a fetch with the canned JSON",
    async () => {
      const installed = await call<Installed>("route", {
        session,
        urlPattern: "**/api/data",
        body: '{"from":"canned"}',
      });
      expect(installed.ok).toBe(true);
      expect(installed.fulfils).toBe("data");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "api=canned")).toBe(true);
      expect(await has(call, session, "api=network")).toBe(false);
      // The rest of the page is untouched.
      expect(await has(call, session, "doc=real")).toBe(true);
      expect(await has(call, session, "script=real")).toBe(true);

      const removed = await call<Removed>("unroute", { session });
      expect(removed.removed).toEqual(["* **/api/data"]);
      expect(removed.skippedExecutable).toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "leaves a script request to the network, whatever content type the route names",
    async () => {
      const installed = await call<Installed>("route", {
        session,
        urlPattern: "**/app.js",
        contentType: "application/json",
        body: say("script=canned"),
      });
      expect(installed.ok).toBe(true);
      expect(installed.fulfils).toBe("data");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "script=real")).toBe(true);
      expect(await has(call, session, "script=canned")).toBe(false);

      const removed = await call<Removed>("unroute", { session, urlPattern: "**/app.js" });
      expect(removed.removed).toEqual(["* **/app.js"]);
      expect(removed.skippedExecutable).toBeGreaterThanOrEqual(1);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "leaves a document request to the network",
    async () => {
      const installed = await call<Installed>("route", {
        session,
        urlPattern: "**/page",
        body: "<!doctype html><title>canned</title><p>doc=canned</p>",
      });
      expect(installed.ok).toBe(true);
      expect(installed.fulfils).toBe("data");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "doc=real")).toBe(true);
      expect(await has(call, session, "doc=canned")).toBe(false);

      const removed = await call<Removed>("unroute", { session });
      expect(removed.skippedExecutable).toBeGreaterThanOrEqual(1);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "leaves a worker script request to the network",
    async () => {
      const installed = await call<Installed>("route", {
        session,
        urlPattern: "**/worker.js",
        contentType: "application/json",
        body: 'postMessage("canned");',
      });
      expect(installed.ok).toBe(true);

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "worker=real")).toBe(true);
      expect(await has(call, session, "worker=canned")).toBe(false);

      await call("unroute", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it.each(["text/javascript", "text/html", "image/svg+xml"])(
    "refuses a route with contentType %s and installs nothing",
    async (contentType) => {
      const denied = await call<Denied>("route", {
        session,
        urlPattern: "**/refused",
        contentType,
        body: "x",
      });
      expect(denied.ok).toBe(false);
      expect(denied.requiredCapability).toBe("eval");
      expect(denied.error).toContain('capability "eval" is not enabled on this server');
      expect(denied.reason).toContain(contentType);

      const removed = await call<Removed>("unroute", { session });
      expect(removed.removed).toEqual([]);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "route_queue keeps its entry when the first match is a script request",
    async () => {
      const installed = await call<Installed>("route_queue", {
        session,
        urlPattern: "**/shared",
        responses: [{ body: "canned", contentType: "text/plain" }],
      });
      expect(installed.ok).toBe(true);
      expect(installed.queued).toBe(1);
      expect(installed.fulfils).toBe("data");

      await call("navigate", { session, url: `${base}/queue-page` });
      // The script request came first and ran the real script; the one queued
      // response was still there for the fetch that followed.
      expect(await appears(call, session, "shared-fetch=canned")).toBe(true);
      expect(await has(call, session, "shared-script=real")).toBe(true);

      const removed = await call<Removed>("unroute", { session });
      expect(removed.skippedExecutable).toBeGreaterThanOrEqual(1);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "sw_intercept_fetch leaves a script request to the network",
    async () => {
      const pattern = `${base}/app.js`;
      const added = await call<Installed>("sw_intercept_fetch", {
        session,
        pattern,
        response: { body: say("script=canned"), contentType: "application/json" },
      });
      expect(added.ok).toBe(true);
      expect(added.fulfils).toBe("data");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "script=real")).toBe(true);
      expect(await has(call, session, "script=canned")).toBe(false);

      const cleared = await call<Removed>("sw_unintercept_fetch", { session });
      expect(cleared.removed).toEqual([pattern]);
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("route fulfilment with eval enabled", () => {
  let server: Booted;
  let call: Call;
  const session = "ks-route-fulfil-eval";

  beforeAll(async () => {
    server = await boot("read,navigation,action,human,eval");
    call = callerFor(server);
    const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
    expect(opened.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "answers a script request with the canned script",
    async () => {
      const installed = await call<Installed>("route", {
        session,
        urlPattern: "**/app.js",
        contentType: "text/javascript",
        body: say("script=canned"),
      });
      expect(installed.ok).toBe(true);
      expect(installed.fulfils).toBe("all");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "script=canned")).toBe(true);
      expect(await has(call, session, "script=real")).toBe(false);

      const removed = await call<Removed>("unroute", { session });
      expect(removed.skippedExecutable).toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "answers a document request with the canned document",
    async () => {
      const installed = await call<Installed>("route", {
        session,
        urlPattern: "**/page",
        contentType: "text/html",
        body: "<!doctype html><title>canned</title><p>doc=canned</p>",
      });
      expect(installed.ok).toBe(true);
      expect(installed.fulfils).toBe("all");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "doc=canned")).toBe(true);
      expect(await has(call, session, "doc=real")).toBe(false);

      await call("unroute", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

/** One HAR entry answering GET `url` with `body` typed `mimeType`. */
function harEntry(url: string, mimeType: string, body: string): Record<string, unknown> {
  return {
    startedDateTime: new Date(0).toISOString(),
    time: 0,
    request: {
      method: "GET",
      url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: 0,
    },
    response: {
      status: 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [{ name: "content-type", value: mimeType }],
      content: { size: Buffer.byteLength(body), mimeType, text: body },
      redirectURL: "",
      headersSize: -1,
      bodySize: Buffer.byteLength(body),
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  };
}

/** Write a HAR holding the fixture's page, its `/app.js` and its `/api/data`,
 *  each marked `har`, and return its workspace-relative path. */
function writeReplayHar(name: string): string {
  const entries = [
    harEntry(`${base}/page`, "text/html; charset=utf-8", PAGE.replace("doc=real", "doc=har")),
    harEntry(`${base}/app.js`, "text/javascript", say("script=har")),
    harEntry(`${base}/api/data`, "application/json", '{"from":"har"}'),
  ];
  const har = { log: { version: "1.2", creator: { name: "keystone", version: "1" }, entries } };
  writeFileSync(join(workspace, name), JSON.stringify(har));
  return name;
}

describe("HAR replay with the default capability set", () => {
  let server: Booted;
  let call: Call;
  const session = "ks-har-replay";

  beforeAll(async () => {
    server = await boot();
    call = callerFor(server);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "serves the fetch from the HAR and loads the real page and script",
    async () => {
      const opened = await call<{ ok: boolean; harsReplay: number; fulfils: string }>(
        "open_session",
        { session, mode: "incognito", hars: [writeReplayHar("ks-replay-default.har")] },
      );
      expect(opened.ok).toBe(true);
      expect(opened.harsReplay).toBe(1);
      expect(opened.fulfils).toBe("data");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "api=har")).toBe(true);
      expect(await has(call, session, "doc=real")).toBe(true);
      expect(await has(call, session, "script=real")).toBe(true);
      expect(await has(call, session, "doc=har")).toBe(false);
      expect(await has(call, session, "script=har")).toBe(false);
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("HAR replay with eval enabled", () => {
  let server: Booted;
  let call: Call;
  const session = "ks-har-replay-eval";

  beforeAll(async () => {
    server = await boot("read,navigation,action,human,eval");
    call = callerFor(server);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "serves the page, the script and the fetch from the HAR",
    async () => {
      const opened = await call<{ ok: boolean; fulfils: string }>("open_session", {
        session,
        mode: "incognito",
        hars: [writeReplayHar("ks-replay-eval.har")],
      });
      expect(opened.ok).toBe(true);
      expect(opened.fulfils).toBe("all");

      await call("navigate", { session, url: `${base}/page` });
      expect(await appears(call, session, "api=har")).toBe(true);
      expect(await has(call, session, "doc=har")).toBe(true);
      expect(await has(call, session, "script=har")).toBe(true);
      expect(await has(call, session, "doc=real")).toBe(false);
    },
    KEYSTONE_TIMEOUT,
  );
});
