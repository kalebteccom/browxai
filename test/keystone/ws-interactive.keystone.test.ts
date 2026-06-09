// Phase-7 interactive-WS keystone — drives `ws_send` + `ws_intercept` end-to-end
// against a real headless Chromium and a minimal RFC 6455 echo server (see
// `fixture.ts`'s `/ws` route). The unit tests stub the page-side wrapper; this
// keystone proves the wrapper survives a real Chromium init-script injection
// and that `eval_js`-style `evaluate` calls into `__browxWs.*` actually take.

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
  workspace = mkdtempSync(join(tmpdir(), "browx-ws-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  // eval is needed to read `__browxWs.list()` from the agent side (the
  // `ws_send` happy-path can ALSO be driven without eval — the keystone
  // exercises both. The interactive-WS family itself is on under default
  // `action`.).
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

describe("ws_send / ws_intercept keystone", () => {
  it(
    "page opens WS, server echoes, ws_send pushes a frame, ws_intercept rewrites inbound",
    async () => {
      const session = "ks-ws";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "incognito",
      });
      expect(opened.ok).toBe(true);

      await callJson("navigate", { session, url: `${fixture.url}/ws-page` });

      // Wait for the page-side socket to reach OPEN. The page writes "open" into
      // #ws-state when the open event fires; we poll via eval_js.
      const state = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('ws-state').textContent",
          }),
        (r) => r.value === "open",
      );
      expect(state.value).toBe("open");

      // Initial `hello` from the page → echo → on the page as `echo:hello`.
      const log0 = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('ws-log').textContent",
          }),
        (r) => r.value.includes("echo:hello"),
      );
      expect(log0.value).toContain("echo:hello");

      // Discover the wsId via __browxWs.list(). The wrapper was lazy-installed
      // by the first ws_send / ws_intercept; we drive that by calling
      // ws_send with a bogus id first to force install, then list. Cleaner:
      // call ws_intercept (a no-op pattern) once, then list.
      await callJson("ws_intercept", {
        session,
        pattern: "wss://never-matches/**",
        response: "drop",
      });
      const list = await callJson<{
        ok: boolean;
        value: Array<{ wsId: string; url: string; readyState: number }>;
      }>("eval_js", { session, expr: "JSON.stringify(window.__browxWs.list())" });
      const sockets = JSON.parse((list as { value: string }).value) as Array<{
        wsId: string;
        url: string;
        readyState: number;
      }>;
      expect(sockets.length).toBeGreaterThan(0);
      const wsId = sockets[0]!.wsId;
      expect(sockets[0]!.url).toMatch(/\/ws$/);

      // ws_send → the server echoes → page log includes `echo:server-payload`.
      const sent = await callJson<{ ok: boolean; bytes: number }>("ws_send", {
        session,
        wsId,
        message: "server-payload",
      });
      expect(sent.ok).toBe(true);
      expect(sent.bytes).toBe("server-payload".length);

      const log1 = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('ws-log').textContent",
          }),
        (r) => r.value.includes("echo:server-payload"),
      );
      expect(log1.value).toContain("echo:server-payload");

      // ws_intercept(replace) — when the server-echoed payload matches the
      // pattern, the wrapper substitutes its data before the page handler runs.
      // Pattern matches the current WS URL (ws://127.0.0.1:PORT/ws) via **.
      const wsUrlPattern = `ws://${new URL(fixture.url).host}/**`;
      const interceptRes = await callJson<{ ok: boolean; active: string[] }>("ws_intercept", {
        session,
        pattern: wsUrlPattern,
        response: { data: "REPLACED_BY_INTERCEPT" },
      });
      expect(interceptRes.ok).toBe(true);
      expect(interceptRes.active).toContain(wsUrlPattern);

      // Drive a new round-trip: page sends INTERCEPT_ME, server echoes
      // "echo:INTERCEPT_ME" — wrapper REPLACES it with REPLACED_BY_INTERCEPT
      // before the message handler appends to the log.
      await callJson("click", {
        session,
        named: undefined,
        selector: '[data-testid="ws-trigger"]',
      });

      const log2 = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('ws-log').textContent",
          }),
        (r) => r.value.includes("REPLACED_BY_INTERCEPT"),
      );
      expect(log2.value).toContain("REPLACED_BY_INTERCEPT");
      // The intercepted `echo:INTERCEPT_ME` did NOT make it through verbatim.
      expect(log2.value).not.toContain("echo:INTERCEPT_ME");

      // ws_unintercept clears it; the next round echoes verbatim again.
      const cleared = await callJson<{ ok: boolean; active: string[] }>("ws_unintercept", {
        session,
        pattern: wsUrlPattern,
      });
      expect(cleared.ok).toBe(true);
      expect(cleared.active).not.toContain(wsUrlPattern);

      await callJson("ws_send", { session, wsId, message: "after-clear" });
      const log3 = await pollUntil(
        () =>
          callJson<{ ok: boolean; value: string }>("eval_js", {
            session,
            expr: "document.getElementById('ws-log').textContent",
          }),
        (r) => r.value.includes("echo:after-clear"),
      );
      expect(log3.value).toContain("echo:after-clear");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
