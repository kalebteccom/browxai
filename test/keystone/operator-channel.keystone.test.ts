// Operator-channel keystone. With the off-by-default `operator-channel`
// capability on and the daemon's socket in the environment, every confirm-hook
// request and `await_human` goes to the daemon over a real Unix socket, and only
// the daemon's answer counts.
//
// Real browsers, real sockets. A mocked socket or page would pass whether or not
// the page, DevTools or the agent can reach the answer, and that reach is the
// question.
//
//   1. Capability unset (MCP handlers): the socket gets no connection, the
//      variables are gone from the environment, nothing the agent can call names
//      the path or the token, and `set_config` cannot turn the capability on.
//   2. Capability set (MCP handlers, managed Chromium): approve and deny over the
//      socket on a held `navigate`, with the URL query stripped from what the
//      daemon is shown; one-shot, session and workspace grants and a refused
//      global one; `await_human` over the socket; a dropped connection denies at
//      the timeout.
//   3. Real Chromium, the isolated-world channel: a DevTools answer releases a
//      prompt when the operator channel is off, and answers nothing while it is
//      on. Page forgery answers nothing either way.
//   4. A socket directory with the wrong mode refuses to start the channel.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../../src/server.js";
import { BrowxBridge } from "../../src/helper/bridge.js";
import { confirmByobAction } from "../../src/policy/confirm.js";
import { openOperatorChannel } from "../../src/helper/operator-channel.js";
import { resolveCapabilities } from "../../src/util/capabilities.js";
import { startFakeDaemon, type FakeDaemon } from "../../src/helper/__fixtures__/operator-daemon.js";

const KEYSTONE_TIMEOUT = 120_000;
const WORLD_PREFIX = "browxai-";
const CAPS_ON = "read,navigation,action,human,operator-channel";
const CAPS_OFF = "read,navigation,action,human";

// Everything browxai writes to stderr, so a test can assert what never appears.
const stderrLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>page</title></head>
<body><button data-testid="save-btn">Save</button></body></html>`;

// Hammers every page-reachable way to answer, on an interval.
const FORGING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>forger</title></head>
<body><script>setInterval(function () {
  try { window.__browx && window.__browx.confirm(true); } catch (_) {}
  try { window.__browx && window.__browx.proceed(); } catch (_) {}
  try { Object.getOwnPropertyNames(window).forEach(function (k) {
    if (k.indexOf("__browx") === 0 && typeof window[k] === "function") {
      try { window[k](JSON.stringify({ kind: "signal", name: "respond", data: { kind: "confirm", value: true } })); } catch (_) {}
    }
  }); } catch (_) {}
  window.__forgeCount = (window.__forgeCount || 0) + 1;
}, 100);</script></body></html>`;

let http: Server;
let http2: Server;
let base: string;
let base2: string;
const savedEnv: Record<string, string | undefined> = {};

function isolateEnv(prefix: string): string {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      if (!(k in savedEnv)) savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  const ws = mkdtempSync(join(tmpdir(), prefix));
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
    if (!fn) throw new Error(`operator-channel keystone: no handler "${name}"`);
    const res = await fn(args);
    return JSON.parse((res.content[0] as { text: string }).text) as T;
  };
}

function operatorEnv(d: FakeDaemon): NodeJS.ProcessEnv {
  return { BROWX_OPERATOR_SOCKET: d.socketPath, BROWX_OPERATOR_TOKEN: d.token };
}

async function stillPending<T>(p: Promise<T>, ms: number): Promise<"pending" | T> {
  return Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function requestCount(d: FakeDaemon): number {
  return d.frames.filter((f) => f.type === "request").length;
}

function expectNoSecretsIn(text: string, d: FakeDaemon): void {
  expect(text).not.toContain(d.token);
  expect(text).not.toContain(d.socketPath);
  expect(text).not.toContain(d.dir);
}

beforeAll(async () => {
  process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    stderrLog.push(String(chunk));
    return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  http = createHttp((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url?.startsWith("/forge") ? FORGING_PAGE : PAGE);
  });
  http2 = createHttp((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => http2.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  base2 = `http://127.0.0.1:${(http2.address() as AddressInfo).port}`;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  process.stderr.write = realStderrWrite;
  await new Promise<void>((r) => http.close(() => r()));
  await new Promise<void>((r) => http2.close(() => r()));
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
}, KEYSTONE_TIMEOUT);

// ---------------------------------------------------------------------------
// 1. Capability unset.
// ---------------------------------------------------------------------------

describe("operator channel — capability unset", () => {
  let daemon: FakeDaemon;
  let server: Server_;
  let workspace: string;

  beforeAll(async () => {
    workspace = isolateEnv("browx-operator-off-");
    daemon = await startFakeDaemon();
    process.env.BROWX_CAPABILITIES = CAPS_OFF;
    Object.assign(process.env, operatorEnv(daemon));
    server = await createServer({ headless: true });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    await daemon?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it("never dials the socket, and removes both variables from the environment", async () => {
    await new Promise((r) => setTimeout(r, 800));
    expect(daemon.connections).toBe(0);
    expect(process.env.BROWX_OPERATOR_SOCKET).toBeUndefined();
    expect(process.env.BROWX_OPERATOR_TOKEN).toBeUndefined();
    expect(stderrLog.join("")).toContain("operator-channel capability is off");
  });

  it("await_human stays a DevTools prompt: it times out without touching the socket", async () => {
    const call = caller(server);
    await call("open_session", { session: "off", mode: "incognito" });
    const r = await call<{ timedOut: boolean; value: unknown }>("await_human", {
      session: "off",
      kind: "confirm",
      prompt: "capability off",
      timeoutMs: 1_500,
    });
    expect(r.timedOut).toBe(true);
    expect(daemon.connections).toBe(0);
    expect(requestCount(daemon)).toBe(0);
  });

  it("set_config cannot turn the capability on", async () => {
    const call = caller(server);
    const refused = await call<{ ok: boolean; error: string; widening: string[] }>("set_config", {
      scope: "user",
      patch: { capabilities: ["read", "navigation", "action", "human", "operator-channel"] },
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe("capabilities-not-widenable");
    expect(refused.widening).toEqual(["operator-channel"]);
    const resolved = await call<{ config: { capabilities: string[] } }>("get_config", {});
    expect(resolved.config.capabilities).not.toContain("operator-channel");
  });

  it("nothing the agent can call names the socket path or the token", async () => {
    const call = caller(server);
    const outputs = await Promise.all([
      call("get_config", {}),
      call("get_config", { scope: "env" }),
      call("list_approvals", {}),
      call("await_human", { session: "off", kind: "acknowledge", prompt: "x", timeoutMs: 500 }),
    ]);
    expectNoSecretsIn(JSON.stringify(outputs), daemon);
    expectNoSecretsIn(stderrLog.join(""), daemon);
  });
});

// ---------------------------------------------------------------------------
// 2. Capability set, through the MCP handlers on managed Chromium. The held
//    action is an off-allowlist `navigate`, which the navigate_off_allowlist
//    confirm hook asks about.
// ---------------------------------------------------------------------------

describe("operator channel — approvals, grants and await_human over the socket", () => {
  let daemon: FakeDaemon;
  let server: Server_;
  let workspace: string;
  let call: ReturnType<typeof caller>;

  beforeAll(async () => {
    workspace = isolateEnv("browx-operator-on-");
    daemon = await startFakeDaemon();
    process.env.BROWX_CAPABILITIES = CAPS_ON;
    process.env.BROWX_ALLOWED_ORIGINS = base;
    Object.assign(process.env, operatorEnv(daemon));
    server = await createServer({ headless: true });
    call = caller(server);
    await waitFor(() => daemon.authenticated === 1);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    await daemon?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  /** An incognito session already on an allowed page. */
  async function openOn(session: string): Promise<void> {
    await call("open_session", { session, mode: "incognito" });
    await call("navigate", { session, url: base });
  }

  /** A navigate off the allowlist: the confirm hook holds it. */
  const leave = (session: string, path = "/x") =>
    call<{ ok: boolean; error?: string }>("navigate", { session, url: `${base2}${path}` });

  it("enables the channel with a handshake that carries proofs, never the token", () => {
    expect(stderrLog.join("")).toContain("operator-channel capability is ENABLED");
    expect(JSON.stringify(daemon.frames)).not.toContain(daemon.token);
    expect(process.env.BROWX_OPERATOR_TOKEN).toBeUndefined();
  });

  it(
    "holds the navigate until the daemon approves, showing no query string",
    async () => {
      await openOn("nav");
      const moving = call<{ ok: boolean }>("navigate", {
        session: "nav",
        url: `${base2}/plain?secret=hunter2`,
      });
      const req = await daemon.nextRequest();
      expect(req).toMatchObject({
        kind: "approval",
        scope: "navigate_off_allowlist",
        tool: "navigate",
        session: "nav",
        untrusted: ["summary"],
        answers: ["approve", "deny"],
        grantScopes: ["session", "workspace"],
      });
      expect(String(req.summary)).toContain(new URL(base2).host);
      expect(String(req.summary)).not.toContain("hunter2");
      expect(await stillPending(moving, 1_500), "no answer, no navigation").toBe("pending");
      daemon.answer(req.id, { decision: "approve" });
      expect((await moving).ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "an approve is one-shot: the next navigate asks again, and a deny refuses it",
    async () => {
      const before = requestCount(daemon);
      const moving = leave("nav", "/denied");
      const req = await daemon.nextRequest();
      expect(requestCount(daemon)).toBe(before + 1);
      daemon.answer(req.id, { decision: "deny" });
      const r = await moving;
      expect(r.ok).toBe(false);
      expect(r.error ?? "").toMatch(/human-declined/);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a grant that is not session or workspace scoped is refused and the navigate stays held",
    async () => {
      await openOn("global");
      const moving = leave("global");
      const req = await daemon.nextRequest();
      daemon.answer(req.id, { decision: "approve", grant: { scope: "global", ttlSeconds: 600 } });
      await waitFor(() => daemon.frames.some((f) => f.type === "error"));
      expect(daemon.frames.filter((f) => f.type === "error").at(-1)).toMatchObject({
        id: req.id,
        code: "invalid-answer",
      });
      expect(await stillPending(moving, 1_000)).toBe("pending");
      daemon.answer(req.id, { decision: "approve" });
      expect((await moving).ok).toBe(true);
      const listed = await call<{ approvals: unknown[] }>("list_approvals", {});
      expect(listed.approvals).toEqual([]);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a session grant covers that session only, and closing the session drops it",
    async () => {
      await openOn("grant-a");
      const first = leave("grant-a", "/one");
      const req = await daemon.nextRequest();
      daemon.answer(req.id, {
        decision: "approve",
        grant: { scope: "session", ttlSeconds: 600 },
      });
      expect((await first).ok).toBe(true);

      const before = requestCount(daemon);
      expect((await leave("grant-a", "/two")).ok, "covered by the session grant").toBe(true);
      expect(requestCount(daemon)).toBe(before);
      const listed = await call<{ approvals: Array<{ scope: string; sessionId?: string }> }>(
        "list_approvals",
        {},
      );
      expect(listed.approvals).toMatchObject([
        { scope: "navigate_off_allowlist", sessionId: "grant-a" },
      ]);

      await openOn("grant-b");
      const other = leave("grant-b");
      const otherReq = await daemon.nextRequest();
      expect(otherReq.session).toBe("grant-b");
      daemon.answer(otherReq.id, { decision: "deny" });
      expect((await other).ok).toBe(false);

      await call("close_session", { session: "grant-a" });
      const after = await call<{ approvals: unknown[] }>("list_approvals", {});
      expect(after.approvals).toEqual([]);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a workspace grant covers every session",
    async () => {
      await openOn("ws-a");
      const first = leave("ws-a");
      const req = await daemon.nextRequest();
      daemon.answer(req.id, {
        decision: "approve",
        grant: { scope: "workspace", ttlSeconds: 600 },
      });
      expect((await first).ok).toBe(true);
      await openOn("ws-b");
      const before = requestCount(daemon);
      expect((await leave("ws-b")).ok).toBe(true);
      expect(requestCount(daemon)).toBe(before);
      const listed = await call<{ approvals: Array<{ sessionId?: string }> }>("list_approvals", {});
      expect(listed.approvals).toHaveLength(1);
      expect(listed.approvals[0]).not.toHaveProperty("sessionId");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "await_human: done with a value, an invalid value, and abort",
    async () => {
      await call("open_session", { session: "human", mode: "incognito" });
      const choose = call<{ timedOut: boolean; value: unknown }>("await_human", {
        session: "human",
        kind: "choose",
        prompt: "Which account?",
        choices: ["alice", "bob"],
        timeoutMs: 30_000,
      });
      const req = await daemon.nextRequest();
      expect(req).toMatchObject({
        kind: "human",
        humanKind: "choose",
        prompt: "Which account?",
        choices: ["alice", "bob"],
        untrusted: ["prompt", "choices"],
        answers: ["done", "abort"],
      });
      daemon.answer(req.id, { decision: "done", value: 7 });
      expect(await stillPending(choose, 1_000), "an out-of-range index answers nothing").toBe(
        "pending",
      );
      daemon.answer(req.id, { decision: "done", value: 1 });
      expect(await choose).toMatchObject({ value: 1, timedOut: false });

      const confirm = call<{ value: unknown }>("await_human", {
        session: "human",
        kind: "confirm",
        prompt: "Proceed?",
        timeoutMs: 30_000,
      });
      const confirmReq = await daemon.nextRequest();
      daemon.answer(confirmReq.id, { decision: "done", value: false });
      expect((await confirm).value).toBe(false);

      const aborted = call<{ value: unknown; error?: string }>("await_human", {
        session: "human",
        kind: "acknowledge",
        prompt: "Done?",
        timeoutMs: 30_000,
      });
      const abortReq = await daemon.nextRequest();
      daemon.answer(abortReq.id, { decision: "abort" });
      const r = await aborted;
      expect(r.value).toBeNull();
      expect(r.error ?? "").toMatch(/operator-aborted/);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a dropped connection never approves: the request is denied at its timeout",
    async () => {
      const waiting = call<{ timedOut: boolean; value: unknown }>("await_human", {
        session: "human",
        kind: "confirm",
        prompt: "Will the socket come back?",
        timeoutMs: 2_500,
      });
      await daemon.nextRequest();
      daemon.drop();
      const r = await waiting;
      expect(r.timedOut).toBe(true);
      expect(r.value).toBeNull();
    },
    KEYSTONE_TIMEOUT,
  );

  it("never put the socket path or the token in a log line", () => {
    expectNoSecretsIn(stderrLog.join(""), daemon);
  });
});

// ---------------------------------------------------------------------------
// 3. Real Chromium, the isolated-world channel. Playwright-launched, so the
//    test can open a CDP session on the page and call the bridge's world the way
//    a person does from DevTools.
// ---------------------------------------------------------------------------

describe("operator channel — DevTools answers", () => {
  let browser: Browser;
  let daemon: FakeDaemon;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    daemon = await startFakeDaemon();
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await daemon?.close();
  }, KEYSTONE_TIMEOUT);

  /** Call `expression` in the bridge's `browxai-<random>` isolated world of
   *  `page`, over a CDP session of our own: what a person does from DevTools. */
  async function asHuman(page: Page, bridge: BrowxBridge, expression: string): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    const worlds: number[] = [];
    cdp.on(
      "Runtime.executionContextCreated",
      (ev: { context: { id: number; name: string; origin: string } }) => {
        if (ev.context.name === bridge.world && !ev.context.origin.includes("-extension://"))
          worlds.push(ev.context.id);
      },
    );
    await cdp.send("Runtime.enable");
    // The bridge wires a new page asynchronously; wait for its world to appear.
    await waitFor(() => worlds.length > 0, 5_000).catch(() => undefined);
    expect(worlds.length, "the browxai isolated world exists on the page").toBeGreaterThan(0);
    expect(bridge.world.startsWith(WORLD_PREFIX)).toBe(true);
    const res = await cdp.send("Runtime.evaluate", {
      expression,
      contextId: worlds[worlds.length - 1]!,
    });
    expect(res.exceptionDetails, JSON.stringify(res.exceptionDetails)).toBeUndefined();
    await cdp.detach();
  }

  async function pageWith(bridge: BrowxBridge, path: string): Promise<Page> {
    const context = await browser.newContext();
    await bridge.attach(context);
    const page = await context.newPage();
    await page.goto(`${base}${path}`);
    return page;
  }

  const byobCtx = (bridge: BrowxBridge) => ({
    hooks: new Set(["byob_action" as const]),
    policy: { allowed: [], blocked: [] },
    bridge,
    isByob: true,
    sessionId: "devtools",
  });

  it(
    "operator channel off: a DevTools answer with the prompt's ticket releases the confirm",
    async () => {
      const bridge = new BrowxBridge();
      const page = await pageWith(bridge, "/plain");
      // Without the operator channel a bridge counts as a human channel only
      // once a page carries the isolated world.
      await waitFor(() => bridge.humanChannelAvailable());
      const before = stderrLog.length;
      const held = confirmByobAction("click", byobCtx(bridge));
      let ticket = "";
      await waitFor(() => {
        const m = stderrLog
          .slice(before)
          .join("")
          .match(/call __browx\.confirm\(true, "([0-9a-f]{6})"\)/);
        ticket = m?.[1] ?? "";
        return ticket !== "";
      });
      await asHuman(page, bridge, `__browx.confirm(true, "${ticket}")`);
      expect(await held).toMatchObject({ ok: true, reason: "human-approved" });
      await bridge.detach();
      await page.context().close();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "operator channel on: DevTools answers and page forgery answer nothing, only the socket does",
    async () => {
      const channel = openOperatorChannel(resolveCapabilities({ BROWX_CAPABILITIES: CAPS_ON }), {
        ...operatorEnv(daemon),
      });
      expect(channel).not.toBeNull();
      const bridge = new BrowxBridge({ operator: channel, sessionId: "devtools" });
      try {
        await waitFor(() => daemon.authenticated === 1);
        const page = await pageWith(bridge, "/forge");
        const before = requestCount(daemon);
        const held = confirmByobAction("click", byobCtx(bridge));
        const req = await daemon.nextRequest();
        expect(requestCount(daemon)).toBe(before + 1);
        expect(req).toMatchObject({ kind: "approval", scope: "byob_action", tool: "click" });
        // Every answer a person at DevTools can give, ticket guesses included.
        await asHuman(page, bridge, "__browx.confirm(true)");
        await asHuman(page, bridge, `__browx.confirm(true, "000000")`);
        await asHuman(page, bridge, "__browx.proceed()");
        expect(await stillPending(held, 2_000), "only the socket answers").toBe("pending");
        expect(
          await page.evaluate(
            () => (window as unknown as { __forgeCount?: number }).__forgeCount ?? 0,
          ),
          "the page forged answers throughout",
        ).toBeGreaterThan(10);
        daemon.answer(req.id, { decision: "approve" });
        expect(await held).toMatchObject({ ok: true, reason: "human-approved" });
        await page.context().close();
      } finally {
        await bridge.detach();
        channel?.close();
      }
    },
    KEYSTONE_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// 4. Wrong permissions refuse to start the channel.
// ---------------------------------------------------------------------------

describe("operator channel — socket permissions", () => {
  let workspace: string;
  afterAll(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("refuses to start on a socket directory that is not 0700, without naming it", async () => {
    workspace = isolateEnv("browx-operator-perm-");
    const daemon = await startFakeDaemon();
    try {
      chmodSync(daemon.dir, 0o750);
      process.env.BROWX_CAPABILITIES = CAPS_ON;
      Object.assign(process.env, operatorEnv(daemon));
      let message = "";
      try {
        await createServer({ headless: true });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("refusing to start the channel");
      expectNoSecretsIn(message, daemon);
      expect(daemon.connections).toBe(0);
    } finally {
      chmodSync(daemon.dir, 0o700);
      await daemon.close();
    }
  });
});
