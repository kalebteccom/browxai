//  workers keystone — drives `workers_list` + `worker_message_send` +
// `worker_messages_read` end-to-end against a real headless Chromium and a
// fixture page that constructs a real `Worker`. The unit tests stub the
// page-side wrapper against a fake Page; this keystone proves the wrapper
// survives a real Chromium init-script injection and that `__browxWorkers.*`
// is reachable from the agent via `page.evaluate`.
//
// A service worker is listed through Playwright's `context.serviceWorkers()` and
// messaged with `Worker.evaluate`; its reply comes back through the page-side
// ring (`/sw-page`, `/sw.js`). Once the session has listed a service worker
// live, it stays listed as `stopped` after the worker goes away. A script URL
// the page plants in its own message ring never lists, and a message that names
// a blocked origin is dropped on read.
//
// Chromium keeps a service worker running while a DevTools client is attached
// to it, and Playwright is one, so unregistering alone never stops it. The
// stopped-worker test therefore runs against an attached Chromium the keystone
// also holds a CDP connection to, and stops the worker with
// `ServiceWorker.stopAllWorkers`.
//
// SW intercept is intentionally left to a follow-up — a fixture-served SW
// would need a longer round-trip (registration + activation + claim before
// the next fetch goes through the SW). That path is exercised by the
// server-side bookkeeping unit tests + the CDP wiring is shared with the
// Web Worker auto-attach we exercise here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;
const BLOCKED_ORIGIN = "https://blocked.invalid";

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function callOn<T = Record<string, unknown>>(
  on: Handlers,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = on[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return callOn<T>(handlers, name, args);
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  budgetMs = 5000,
  stepMs = 50,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - start > budgetMs) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-workers-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // eval is needed to read state out of the page (#worker-state, etc.);
  // workers_list / worker_message_send / worker_messages_read are under the
  // default capabilities. sw_intercept_fetch is `action` (also default).
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,eval";
  // An origin no fixture page lives on. The stopped-worker test plants a message
  // from a worker on it into the page ring, and the read must drop it.
  process.env.BROWX_BLOCKED_ORIGINS = BLOCKED_ORIGIN;

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  delete process.env.BROWX_BLOCKED_ORIGINS;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("workers_list / worker_message_send / worker_messages_read keystone", () => {
  it(
    "page opens a Web Worker, list sees it, send drives onmessage, read drains the ring",
    async () => {
      const session = "ks-workers";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);

      await callJson("navigate", { session, url: `${fixture.url}/workers-page` });

      // Page reports "ready" once the worker postMessage'd "worker-ready".
      const state = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('worker-state').textContent",
          }),
        (r) => r.value === "ready",
      );
      expect(state.value).toBe("ready");

      // workers_list — should report the live Web Worker with a ww-N id.
      const listed = await pollUntil(
        () =>
          callJson<{
            ok: boolean;
            workers: Array<{ workerId: string; type: string; url: string }>;
          }>("workers_list", { session }),
        (r) => r.workers.some((w) => w.type === "web"),
      );
      expect(listed.ok).toBe(true);
      const webWorkers = listed.workers.filter((w) => w.type === "web");
      expect(webWorkers.length).toBeGreaterThanOrEqual(1);
      const workerId = webWorkers[0]!.workerId;
      expect(workerId).toMatch(/^ww-\d+$/);

      // worker_messages_read — the "worker-ready" frame should already be
      // sitting in the ring. (The page's own onmessage logged it; the ring
      // is independent — the wrapper's addEventListener fires for every
      // message-from-worker.)
      const initial = await pollUntil(
        () =>
          callJson<{ ok: boolean; messages: Array<{ workerId: string; data: string }> }>(
            "worker_messages_read",
            { session, workerId },
          ),
        (r) => r.messages.some((m) => m.data === "worker-ready"),
      );
      expect(initial.ok).toBe(true);
      expect(initial.messages.some((m) => m.data === "worker-ready")).toBe(true);
      // Drain semantics: a re-read returns no "worker-ready" again.
      const drained = await callJson<{ messages: Array<{ data: string }> }>(
        "worker_messages_read",
        { session, workerId },
      );
      expect(drained.messages.find((m) => m.data === "worker-ready")).toBeUndefined();

      // worker_message_send — the worker echoes "echo:<payload>". The page's
      // own onmessage logs it to #worker-log AND the ring buffers it.
      const sent = await callJson<{ ok: boolean }>("worker_message_send", {
        session,
        workerId,
        message: "from-agent",
      });
      expect(sent.ok).toBe(true);

      // Page log should pick up "echo:from-agent" (page-level message handler).
      const log = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('worker-log').textContent",
          }),
        (r) => r.value.includes("echo:from-agent"),
      );
      expect(log.value).toContain("echo:from-agent");

      // Ring also has it.
      const echo = await pollUntil(
        () =>
          callJson<{ messages: Array<{ data: string }> }>("worker_messages_read", {
            session,
            workerId,
          }),
        (r) => r.messages.some((m) => m.data === "echo:from-agent"),
      );
      expect(echo.messages.some((m) => m.data === "echo:from-agent")).toBe(true);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a service worker's reply to the page comes back through worker_messages_read",
    async () => {
      const session = "ks-workers-sw-msg";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);

      await callJson("navigate", { session, url: `${fixture.url}/sw-page` });

      // The page registers /sw.js, pings it once active, and shows the reply.
      const state = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('sw-state').textContent",
          }),
        (r) => r.value === "pong:ping",
        15_000,
      );
      expect(state.value).toBe("pong:ping");

      const read = await pollUntil(
        () =>
          callJson<{
            ok: boolean;
            messages: Array<{ workerId: string; data: string; at: number }>;
          }>("worker_messages_read", { session }),
        (r) => r.messages.some((m) => m.data === "pong:ping"),
      );
      expect(read.ok).toBe(true);
      const pong = read.messages.find((m) => m.data === "pong:ping");
      expect(pong).toBeDefined();
      expect(pong!.workerId).toMatch(/^sw-\d+$/);
      expect(typeof pong!.at).toBe("number");

      // Drain semantics: the same message is not returned twice.
      const again = await callJson<{ messages: Array<{ data: string }> }>("worker_messages_read", {
        session,
        workerId: pong!.workerId,
      });
      expect(again.messages.find((m) => m.data === "pong:ping")).toBeUndefined();

      // Every sw-N a read returned messages for is listed by workers_list.
      const listed = await callJson<{ workers: Array<{ workerId: string }> }>("workers_list", {
        session,
        type: "service",
      });
      expect(listed.workers.map((w) => w.workerId)).toContain(pong!.workerId);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "workers_list sees a service worker and worker_message_send reaches it",
    async () => {
      const session = "ks-workers-sw-send";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);

      await callJson("navigate", { session, url: `${fixture.url}/sw-page` });

      // The page registers /sw.js, pings it once active, and shows the reply.
      const state = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('sw-state').textContent",
          }),
        (r) => r.value === "pong:ping",
        15_000,
      );
      expect(state.value).toBe("pong:ping");

      // workers_list names the worker `sw-N` by its script URL.
      const listed = await pollUntil(
        () =>
          callJson<{
            ok: boolean;
            workers: Array<{ workerId: string; type: string; url: string; state?: string }>;
          }>("workers_list", { session, type: "service" }),
        (r) => r.workers.some((w) => w.url.endsWith("/sw.js")),
      );
      expect(listed.ok).toBe(true);
      const sw = listed.workers.find((w) => w.url.endsWith("/sw.js"));
      expect(sw).toBeDefined();
      expect(sw!.type).toBe("service");
      expect(sw!.workerId).toMatch(/^sw-\d+$/);

      // Clear the "pong:ping" reply so the next read holds only what the send causes.
      const first = await pollUntil(
        () =>
          callJson<{ messages: Array<{ workerId: string; data: string }> }>(
            "worker_messages_read",
            { session, workerId: sw!.workerId },
          ),
        (r) => r.messages.some((m) => m.data === "pong:ping"),
      );
      expect(first.messages.some((m) => m.data === "pong:ping")).toBe(true);

      // The message reaches the worker's `message` listener. The event has no
      // `source`, so the worker answers its clients, and the page ring records it.
      const sent = await callJson<{ ok: boolean; workerId: string }>("worker_message_send", {
        session,
        workerId: sw!.workerId,
        message: "from-agent",
      });
      expect(sent.ok).toBe(true);
      expect(sent.workerId).toBe(sw!.workerId);

      const reply = await pollUntil(
        () =>
          callJson<{ messages: Array<{ workerId: string; data: string }> }>(
            "worker_messages_read",
            { session, workerId: sw!.workerId },
          ),
        (r) => r.messages.some((m) => m.data === "pong:from-agent"),
      );
      const pong = reply.messages.find((m) => m.data === "pong:from-agent");
      expect(pong).toBeDefined();
      expect(pong!.workerId).toBe(sw!.workerId);

      // A worker id nobody holds returns an error.
      const missing = await callJson<{ ok: boolean; error?: string }>("worker_message_send", {
        session,
        workerId: "sw-999",
        message: "x",
      });
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatch(/no service worker/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "sw_intercept_fetch records a pattern and lists it back without a live SW",
    async () => {
      // Server-side bookkeeping smoke — the CDP wiring is identical to the
      // Web Worker path we just exercised. A full SW round-trip is deferred
      // (it would need an explicit registration + activation in the fixture).
      const session = "ks-workers-sw";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);

      await callJson("navigate", { session, url: `${fixture.url}/workers-page` });

      const added = await callJson<{ ok: boolean; key: string; active: string[] }>(
        "sw_intercept_fetch",
        {
          session,
          pattern: "https://api.example/**",
          response: { status: 200, body: "{}", contentType: "application/json" },
        },
      );
      expect(added.ok).toBe(true);
      expect(added.key).toBe("https://api.example/**");
      expect(added.active).toContain("https://api.example/**");

      const cleared = await callJson<{ ok: boolean; removed: string[]; active: string[] }>(
        "sw_unintercept_fetch",
        {
          session,
          pattern: "https://api.example/**",
        },
      );
      expect(cleared.ok).toBe(true);
      expect(cleared.removed).toContain("https://api.example/**");
      expect(cleared.active).not.toContain("https://api.example/**");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});

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

describeAttached("workers_list keystone — attached Chromium, a stopped service worker", () => {
  let chrome: ChildProcess;
  let profileDir: string;
  let endpoint: string;
  let attached: Awaited<ReturnType<typeof createServer>>;
  let observer: Browser;
  let fileCapabilities: string | undefined;

  const call = <T = Record<string, unknown>>(name: string, args: Record<string, unknown>) =>
    callOn<T>(attached.handlers, name, args);

  beforeAll(async () => {
    fileCapabilities = process.env.BROWX_CAPABILITIES;
    process.env.BROWX_CAPABILITIES = "read,navigation,action,human,eval,byob-attach";
    profileDir = mkdtempSync(join(tmpdir(), "browx-workers-attached-profile-"));
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
    attached = await createServer({ attachCdp: endpoint, headless: true });
    observer = await chromium.connectOverCDP(endpoint);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await observer?.close().catch(() => undefined);
    await attached?.shutdown().catch(() => undefined);
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill();
      await exited;
    }
    if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
    if (fileCapabilities === undefined) delete process.env.BROWX_CAPABILITIES;
    else process.env.BROWX_CAPABILITIES = fileCapabilities;
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
    "a service worker seen live stays listed as stopped, and page-planted script URLs never list",
    async () => {
      const session = "ks-workers-sw-stopped";
      const opened = await call<{ ok: boolean }>("open_session", { session, mode: "attached" });
      expect(opened.ok).toBe(true);

      await call("navigate", { session, url: `${fixture.url}/sw-page?ks=stopped` });
      const state = await pollUntil(
        () =>
          call<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('sw-state').textContent",
          }),
        (r) => r.value === "pong:ping",
        15_000,
      );
      expect(state.value).toBe("pong:ping");

      type Listing = { workerId: string; type: string; url: string; state?: string };
      const listService = () =>
        call<{ ok: boolean; workers: Listing[] }>("workers_list", { session, type: "service" });

      // Live: the real /sw.js is listed `running`. This listing is what marks
      // the id as seen live.
      const live = await pollUntil(listService, (r) =>
        r.workers.some((w) => w.url.endsWith("/sw.js")),
      );
      expect(live.ok).toBe(true);
      const sw = live.workers.find((w) => w.url.endsWith("/sw.js"));
      expect(sw, `listing: ${JSON.stringify(live.workers)}`).toBeDefined();
      expect(sw!.workerId).toMatch(/^sw-\d+$/);
      expect(sw!.state).toBe("running");

      // The page owns its service-worker message ring, so it can claim any
      // script URL it likes. Plant two on every drain: one on the fixture's own
      // origin that no worker ever ran from, and one on a blocked origin.
      const plantedUrl = `${fixture.url}/planted-sw.js`;
      const blockedUrl = `${BLOCKED_ORIGIN}/sw.js`;
      const planted = await call<{ ok: boolean; value: boolean }>("eval_js", {
        session,
        expr: `(() => {
          const w = window.__browxWorkers;
          if (!w) return false;
          const real = w.drainSw;
          w.drainSw = function () {
            return real.call(w).concat([
              { url: ${JSON.stringify(plantedUrl)}, data: "planted-allowed", at: Date.now() },
              { url: ${JSON.stringify(blockedUrl)}, data: "planted-blocked", at: Date.now() },
            ]);
          };
          return true;
        })()`,
      });
      expect(planted.value).toBe(true);

      type Read = { ok: boolean; messages: Array<{ workerId: string; data: string }> };
      const read = await call<Read>("worker_messages_read", { session });
      expect(read.ok).toBe(true);
      // The blocked worker's message is dropped. The fixture-origin one is
      // returned under an id of its own, distinct from the real worker's.
      expect(read.messages.find((m) => m.data === "planted-blocked")).toBeUndefined();
      const plantedMsg = read.messages.find((m) => m.data === "planted-allowed");
      expect(plantedMsg).toBeDefined();
      expect(plantedMsg!.workerId).toMatch(/^sw-\d+$/);
      expect(plantedMsg!.workerId).not.toBe(sw!.workerId);

      const expectNoPlanted = (workers: Listing[]): void => {
        const urls = workers.map((w) => w.url);
        expect(urls).not.toContain(plantedUrl);
        expect(urls.some((u) => u.startsWith(BLOCKED_ORIGIN))).toBe(false);
        expect(workers.map((w) => w.workerId)).not.toContain(plantedMsg!.workerId);
      };
      expectNoPlanted((await listService()).workers);

      // Stop the worker. Unregistering makes the active version redundant, and
      // `stopAllWorkers` stops it even with DevTools clients attached, so its
      // target goes away and Playwright drops the worker.
      const unregistered = await call<{ ok: boolean; value: boolean }>("eval_js", {
        session,
        expr: `navigator.serviceWorker.getRegistration("/").then((r) => (r ? r.unregister() : false))`,
      });
      expect(unregistered.value).toBe(true);
      const page = await findPage("ks=stopped");
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
      await cdp.detach().catch(() => undefined);

      const stopped = await pollUntil(
        listService,
        (r) => r.workers.some((w) => w.workerId === sw!.workerId && w.state === "stopped"),
        20_000,
      );
      const row = stopped.workers.find((w) => w.workerId === sw!.workerId);
      expect(row, `listing after stop: ${JSON.stringify(stopped.workers)}`).toEqual({
        workerId: sw!.workerId,
        type: "service",
        url: sw!.url,
        state: "stopped",
      });
      expect(stopped.workers.filter((w) => w.workerId === sw!.workerId)).toHaveLength(1);
      expectNoPlanted(stopped.workers);

      // A second read re-ingests both planted entries; the blocked one is still
      // dropped and neither shows up in a listing afterwards.
      const again = await call<Read>("worker_messages_read", { session });
      expect(again.messages.find((m) => m.data === "planted-blocked")).toBeUndefined();
      expectNoPlanted((await listService()).workers);

      await call("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
