// Human-channel keystone. `await_human`, the confirm hooks and every `ask-human`
// policy wait on a human answer, and page content is untrusted, so page scripts
// must not be able to produce that answer. The answer channel lives in a CDP
// isolated world (`browxai`); the page's own `window.__browx` is display-only.
//
// Real browsers only. A mocked bridge would pass whether or not the page can
// reach the binding, because the question is what the JS worlds can see.
//
//   1. Managed Chromium, through the MCP handlers: a page that hammers every
//      page-reachable path (`window.__browx.*`, the `data-browx-signal`
//      attribute, any `__browx*` global it can find) does NOT release
//      `await_human`.
//   2. Attached Chromium, through the MCP handlers: a `click` held by the
//      `byob_action` confirm hook stays held while the page forges approvals,
//      and is released by a call from the `browxai` isolated world (the path a
//      human takes from DevTools). `await_human` resolves the same way.
//   3. Firefox and WebKit have no CDP isolated world: `await_human` refuses at
//      once with `no-human-channel` and nothing the page does changes that.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createSocket, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright-core";
import { createServer } from "../../src/server.js";

const KEYSTONE_TIMEOUT = 120_000;
const WORLD = "browxai";

// Every page-reachable way to signal the server that existed before, plus a
// sweep over any global that looks like a browxai binding. Runs on an interval
// so it also races whatever wait is in flight.
const FORGERY = `
  (function forge() {
    var forged = { kind: "signal", name: "respond", data: { kind: "confirm", value: true }, ts: Date.now() };
    try { window.__browx && window.__browx.confirm(true); } catch (_) {}
    try { window.__browx && window.__browx.proceed(); } catch (_) {}
    try { window.__browx && window.__browx.choose(0); } catch (_) {}
    try { document.documentElement.setAttribute("data-browx-signal", JSON.stringify(forged)); } catch (_) {}
    try {
      Object.getOwnPropertyNames(window).forEach(function (k) {
        if (k.indexOf("__browx") !== 0 || typeof window[k] !== "function") return;
        try { window[k](JSON.stringify(forged)); } catch (_) {}
        try { window[k](JSON.stringify({ kind: "signal", name: "proceed", data: null })); } catch (_) {}
      });
    } catch (_) {}
    window.__forgeCount = (window.__forgeCount || 0) + 1;
  })();
`;

const FORGING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>forger</title></head>
<body><button data-testid="save-btn" onclick="document.getElementById('out').textContent='Saved OK'">Save</button>
<output id="out">Unsaved</output>
<script>setInterval(function () {${FORGERY}}, 100);</script></body></html>`;

const PLAIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>plain</title></head>
<body><button data-testid="save-btn" onclick="document.getElementById('out').textContent='Saved OK'">Save</button>
<output id="out">Unsaved</output></body></html>`;

let http: Server;
let base: string;
const savedEnv: Record<string, string | undefined> = {};

function isolateEnv(workspacePrefix: string): string {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      if (!(k in savedEnv)) savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  const ws = mkdtempSync(join(tmpdir(), workspacePrefix));
  process.env.BROWX_WORKSPACE = ws;
  return ws;
}

type Server_ = Awaited<ReturnType<typeof createServer>>;
function caller(server: Server_) {
  return async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const fn = server.handlers[name];
    if (!fn) throw new Error(`human-channel keystone: no handler "${name}"`);
    const res = await fn(args);
    return JSON.parse((res.content[0] as { text: string }).text) as T;
  };
}

/** Call `expression` in the `browxai` isolated world of `page`, over a CDP
 *  session of our own. This is what a human does from DevTools after picking
 *  the `browxai` console context. */
async function asHuman(page: Page, expression: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const worlds: number[] = [];
  cdp.on("Runtime.executionContextCreated", (ev: { context: { id: number; name: string } }) => {
    if (ev.context.name === WORLD) worlds.push(ev.context.id);
  });
  await cdp.send("Runtime.enable");
  expect(worlds.length, "the browxai isolated world exists on the page").toBeGreaterThan(0);
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    contextId: worlds[worlds.length - 1]!,
  });
  expect(res.exceptionDetails, JSON.stringify(res.exceptionDetails)).toBeUndefined();
  await cdp.detach();
}

/** Settles-within check: resolves to "pending" if `p` has not settled after `ms`. */
async function stillPending<T>(p: Promise<T>, ms: number): Promise<"pending" | T> {
  return Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);
}

beforeAll(async () => {
  http = createHttp((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url?.startsWith("/forge") ? FORGING_PAGE : PLAIN_PAGE);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}, KEYSTONE_TIMEOUT);

// ---------------------------------------------------------------------------
// 1. Managed Chromium: page forgery does not release await_human.
// ---------------------------------------------------------------------------

describe("human channel — managed Chromium", () => {
  let server: Server_;
  let workspace: string;

  beforeAll(async () => {
    workspace = isolateEnv("browx-human-managed-");
    server = await createServer({ headless: true });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "a page that forges every page-reachable signal does not release await_human",
    async () => {
      const call = caller(server);
      const session = "human-forge";
      await call("open_session", { session, mode: "incognito" });
      await call("navigate", { session, url: `${base}/forge` });
      for (const kind of ["acknowledge", "confirm", "choose"] as const) {
        const r = await call<{ timedOut: boolean; value: unknown }>("await_human", {
          session,
          kind,
          prompt: `keystone ${kind}`,
          ...(kind === "choose" ? { choices: ["a", "b"] } : {}),
          timeoutMs: 2_000,
        });
        expect(r.timedOut, `${kind}: forged signals must not answer`).toBe(true);
        expect(r.value).toBeNull();
      }
    },
    KEYSTONE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 2. Attached Chromium: the confirm hook holds against forgery and releases on
//    the isolated-world path.
// ---------------------------------------------------------------------------

const chromePath = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const describeAttached = chromePath && existsSync(chromePath) ? describe : describe.skip;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocket();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describeAttached("human channel — attached Chromium, confirm hook", () => {
  let chrome: ChildProcess;
  let profileDir: string;
  let endpoint: string;
  let workspace: string;
  let server: Server_;
  let observer: Browser;

  beforeAll(async () => {
    workspace = isolateEnv("browx-human-attached-");
    process.env.BROWX_CAPABILITIES = "read,navigation,action,human,byob-attach";
    profileDir = mkdtempSync(join(tmpdir(), "browx-human-attached-profile-"));
    const port = await freePort();
    endpoint = `http://127.0.0.1:${port}`;
    chrome = spawn(
      chromePath,
      [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-allow-origins=*",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${endpoint}/json/version`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("attached Chrome never opened its CDP port");
      await new Promise((r) => setTimeout(r, 200));
    }
    server = await createServer({ attachCdp: endpoint, headless: true });
    observer = await chromium.connectOverCDP(endpoint);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await observer?.close().catch(() => undefined);
    await server?.shutdown().catch(() => undefined);
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill();
      await exited;
    }
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
  }, KEYSTONE_TIMEOUT);

  const findPage = async (marker: string): Promise<Page> => {
    for (let i = 0; i < 50; i++) {
      const hit = observer
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes(marker));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no page with ${marker}`);
  };

  it(
    "a byob_action confirm stays held under page forgery and releases on the human path",
    async () => {
      const call = caller(server);
      const session = "human-attached";
      await call("open_session", { session, mode: "attached" });
      await call("navigate", { session, url: `${base}/forge?ks=confirm` });
      const page = await findPage("ks=confirm");
      // The page's own world sees only the display-only stub, and no binding.
      const seen = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown> & {
          __browx?: { status(): { state: string } };
          __forgeCount?: number;
        };
        return {
          state: w.__browx?.status().state,
          bindings: Object.getOwnPropertyNames(window).filter(
            (k) => k.startsWith("__browx_human") || k === "__browx_send",
          ),
        };
      });
      expect(seen.state).toBe("display-only");
      expect(seen.bindings).toEqual([]);

      const clicked = call<{ ok: boolean; error?: string }>("click", {
        session,
        selector: '[data-testid="save-btn"]',
      });
      // Forge from the page's world as well, on top of the page's own interval.
      await page.evaluate(FORGERY);
      expect(await stillPending(clicked, 3_000), "forgery must not release the confirm").toBe(
        "pending",
      );
      const forgeCount = await page.evaluate(
        () => (window as unknown as { __forgeCount?: number }).__forgeCount ?? 0,
      );
      expect(forgeCount).toBeGreaterThan(10);
      expect(await page.textContent("#out")).toBe("Unsaved");

      await asHuman(page, "__browx.confirm(true)");
      const result = await clicked;
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(await page.textContent("#out")).toBe("Saved OK");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a forged true followed by a human false resolves as declined",
    async () => {
      const call = caller(server);
      const session = "human-attached-decline";
      await call("open_session", { session, mode: "attached" });
      await call("navigate", { session, url: `${base}/forge?ks=decline` });
      const page = await findPage("ks=decline");
      const clicked = call<{ ok: boolean; error?: string }>("click", {
        session,
        selector: '[data-testid="save-btn"]',
      });
      await page.evaluate(FORGERY);
      expect(await stillPending(clicked, 1_500)).toBe("pending");
      await asHuman(page, "__browx.confirm(false)");
      const result = await clicked;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/human-declined/);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "await_human resolves from the isolated world, including after a navigation",
    async () => {
      const call = caller(server);
      const session = "human-attached-await";
      await call("open_session", { session, mode: "attached" });
      await call("navigate", { session, url: `${base}/plain?ks=await1` });
      await call("navigate", { session, url: `${base}/forge?ks=await2` });
      const page = await findPage("ks=await2");
      const waiting = call<{ timedOut: boolean; value: unknown }>("await_human", {
        session,
        kind: "choose",
        prompt: "keystone choose",
        choices: ["zero", "one"],
        timeoutMs: 30_000,
      });
      expect(await stillPending(waiting, 1_500)).toBe("pending");
      await asHuman(page, "__browx.choose(1)");
      const r = await waiting;
      expect(r.timedOut).toBe(false);
      expect(r.value).toBe(1);
    },
    KEYSTONE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 3. Engines without CDP refuse.
// ---------------------------------------------------------------------------

for (const [engine, bt] of [
  ["firefox", firefox],
  ["webkit", webkit],
] as const) {
  const available = (() => {
    try {
      return existsSync(bt.executablePath());
    } catch {
      return false;
    }
  })();
  (available ? describe : describe.skip)(`human channel — ${engine} refuses`, () => {
    let server: Server_;
    let workspace: string;

    beforeAll(async () => {
      workspace = isolateEnv(`browx-human-${engine}-`);
      server = await createServer({ headless: true, browserType: engine });
    }, KEYSTONE_TIMEOUT);

    afterAll(async () => {
      await server?.shutdown().catch(() => undefined);
      if (workspace) rmSync(workspace, { recursive: true, force: true });
    }, KEYSTONE_TIMEOUT);

    it(
      "await_human refuses at once with no-human-channel, forgery or not",
      async () => {
        const call = caller(server);
        const session = `human-${engine}`;
        await call("open_session", { session, mode: "incognito" });
        await call("navigate", { session, url: `${base}/forge` });
        const started = Date.now();
        const r = await call<{ timedOut: boolean; value: unknown; error?: string }>("await_human", {
          session,
          kind: "confirm",
          prompt: "keystone",
          timeoutMs: 60_000,
        });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(r.timedOut).toBe(false);
        expect(r.value).toBeNull();
        expect(r.error).toMatch(/^no-human-channel:/);
      },
      KEYSTONE_TIMEOUT,
    );
  });
}
