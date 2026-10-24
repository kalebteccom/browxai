//  workers keystone — drives `workers_list` + `worker_message_send` +
// `worker_messages_read` end-to-end against a real headless Chromium and a
// fixture page that constructs a real `Worker`. The unit tests stub the
// page-side wrapper against a fake Page; this keystone proves the wrapper
// survives a real Chromium init-script injection and that `__browxWorkers.*`
// is reachable from the agent via `page.evaluate`.
//
// A service worker is listed through Playwright's `context.serviceWorkers()` and
// messaged with `Worker.evaluate`; its reply comes back through the page-side
// ring (`/sw-page`, `/sw.js`).
//
// SW intercept is intentionally left to a follow-up — a fixture-served SW
// would need a longer round-trip (registration + activation + claim before
// the next fetch goes through the SW). That path is exercised by the
// server-side bookkeeping unit tests + the CDP wiring is shared with the
// Web Worker auto-attach we exercise here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
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

  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
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
