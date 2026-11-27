// Attached-session hold keystone. A real Chrome is spawned with an open CDP port
// and one server attaches to it. Every prompt goes to a stand-in host daemon over
// the operator channel, which answers at once, so no case waits out the
// five-minute confirm window.
//
//   1. An attached session holds the tools that change the browser, whichever
//      handler they live in, and the read tools that return its cookie values,
//      web storage or IndexedDB values, plus `heap_snapshot`:
//      each call reaches the daemon as a `byob_action` approval and comes back
//      as a `policy:` refusal when the daemon says no.
//   2. Read tools and the tools pinned as not held run without a prompt.
//   3. A managed session on the same server is not held.
//   4. After `approve_actions`, the held tools run and the daemon is not asked.

import { it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createSocket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import {
  startFakeDaemon,
  type FakeDaemon,
  type Frame,
} from "../../src/helper/__fixtures__/operator-daemon.js";
import { startFixture, type Fixture } from "./fixture.js";
import { engineGate, gatedDescribe } from "./keystone-gate.js";

const KEYSTONE_TIMEOUT = 120_000;

const chromeGate = engineGate("chromium");
const chromePath = chromeGate.path;
const describeHold = gatedDescribe(chromeGate);

type Server_ = Awaited<ReturnType<typeof createServer>>;
type Result = { ok?: boolean; error?: string; value?: unknown };

let fixture: Fixture;
let chrome: ChildProcess;
let daemon: FakeDaemon;
let server: Server_;
let workspace: string;
let profileDir: string;
const savedEnv: Record<string, string | undefined> = {};
/** Every approval the daemon was asked for, in order. It denies each one. */
const asked: Frame[] = [];

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

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const fn = server.handlers[name];
  if (!fn) throw new Error(`byob-hold keystone: no handler "${name}"`);
  const res = await fn(args);
  return JSON.parse((res.content[0] as { text: string }).text) as Result;
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("byob-hold keystone: condition never held");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  if (!chromeGate.run) return;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_") && k !== "BROWX_CHANNEL") {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-byob-hold-"));
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_CAPABILITIES =
    "read,navigation,action,human,eval,file-io,byob-attach,self-approval,operator-channel";

  fixture = await startFixture();
  profileDir = mkdtempSync(join(tmpdir(), "browx-byob-hold-profile-"));
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-allow-origins=*",
      // CI runners have no user namespaces and a small /dev/shm; without these
      // Chrome exits before it ever opens the debug port.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  chrome.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (chrome.exitCode !== null || Date.now() > deadline) {
      throw new Error(`Chrome never opened ${endpoint}: ${stderr.trim() || "(no stderr)"}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  daemon = await startFakeDaemon();
  process.env.BROWX_OPERATOR_SOCKET = daemon.socketPath;
  process.env.BROWX_OPERATOR_TOKEN = daemon.token;
  server = await createServer({ attachCdp: endpoint, headless: true });
  await waitFor(() => daemon.authenticated === 1);
  // The operator says no to everything, at once.
  void (async () => {
    for (;;) {
      const req = await daemon.nextRequest();
      asked.push(req);
      daemon.answer(req.id, { decision: "deny" });
    }
  })();

  await call("open_session", { session: "held", mode: "attached" });
  await call("open_session", { session: "managed", mode: "incognito" });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await daemon?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await exited;
  }
  await fixture?.close();
  for (const k of Object.keys(process.env))
    if (k.startsWith("BROWX_") && k !== "BROWX_CHANNEL") delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
}, KEYSTONE_TIMEOUT);

describeHold("attached-session hold — real Chrome, operator answers no", () => {
  /** One call per handler family that used to run without asking. */
  const HELD_CALLS: Array<[string, Record<string, unknown>]> = [
    ["navigate", { url: "about:blank" }],
    ["go_back", {}],
    ["double_click", { target: { selector: "body" } }],
    ["drag", { from: { selector: "body" }, to: { selector: "body" } }],
    ["eval_js", { expr: "1 + 1" }],
    ["route", { urlPattern: "**/api/*", status: 200, body: "{}" }],
    ["grant_permissions", { permissions: ["geolocation"] }],
    ["set_geolocation", { latitude: 1, longitude: 1 }],
    ["click", { selector: "body" }],
    ["cookies_get", { name: "ks-cookie" }],
    ["cookies_list", {}],
    ["dump_storage_state", {}],
    ["localstorage_get", { key: "ks-key" }],
    ["localstorage_list", {}],
    ["sessionstorage_get", { key: "ks-key" }],
    ["sessionstorage_list", {}],
    ["idb_get", { dbName: "ks-db", storeName: "ks-store", key: "ks-key" }],
    // Needs `file-io`, which this server has, so the call reaches the hold.
    ["heap_snapshot", {}],
  ];

  it(
    "holds each tool that changes the browser, and a no leaves it un-run",
    async () => {
      for (const [tool, args] of HELD_CALLS) {
        const before = asked.length;
        const r = await call(tool, { session: "held", ...args });
        expect(r.ok, `${tool} must not run`).toBe(false);
        expect(r.error, tool).toMatch(/^policy: /);
        expect(asked.length, `${tool} asks once`).toBe(before + 1);
        expect(asked.at(-1)).toMatchObject({
          kind: "approval",
          scope: "byob_action",
          tool,
          session: "held",
        });
      }
      // Nothing navigated: the attached tab is where the attach left it.
      const listed = (await call("list_sessions", {})) as unknown as {
        sessions: Array<{ id: string; url?: string }>;
      };
      const held = listed.sessions.find((s) => s.id === "held");
      expect(held?.url ?? "about:blank").not.toContain(fixture.url);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a navigate the scheme rules refuse without asking",
    async () => {
      const before = asked.length;
      const r = await call("navigate", { session: "held", url: "chrome://version" });
      expect(r.ok).toBe(false);
      expect(r.error, JSON.stringify(r)).toMatch(/^navigation-scheme: /);
      expect(asked.length).toBe(before);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "runs a read tool and a pinned not-held tool without asking",
    async () => {
      const before = asked.length;
      const snap = await server.handlers.snapshot!({ session: "held" });
      expect((snap.content[0] as { text: string }).text).not.toMatch(/policy: /);
      const waited = await call("wait_for", {
        session: "held",
        text: "never-there",
        timeoutMs: 300,
      });
      expect(waited.error ?? "").not.toMatch(/^policy: /);
      expect(asked.length).toBe(before);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "does not hold a managed session on the same server",
    async () => {
      const before = asked.length;
      const nav = await call("navigate", { session: "managed", url: `${fixture.url}/` });
      expect(nav.ok, JSON.stringify(nav)).toBe(true);
      const clicked = await call("click", {
        session: "managed",
        selector: '[data-testid="save-btn"]',
      });
      expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
      const evaluated = await call("eval_js", { session: "managed", expr: "1 + 1" });
      expect(evaluated.value).toBe(2);
      const cookies = await call("cookies_list", { session: "managed" });
      expect(cookies.ok, JSON.stringify(cookies)).toBe(true);
      const stored = await call("localstorage_list", { session: "managed" });
      expect(stored.ok, JSON.stringify(stored)).toBe(true);
      expect(asked.length).toBe(before);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "runs the held tools after approve_actions, without asking",
    async () => {
      await call("approve_actions", { scopes: ["byob_action"], ttlSeconds: 600 });
      const before = asked.length;
      const nav = await call("navigate", { session: "held", url: `${fixture.url}/` });
      expect(nav.ok, JSON.stringify(nav)).toBe(true);
      const evaluated = await call("eval_js", { session: "held", expr: "location.href" });
      expect(String(evaluated.value)).toContain(fixture.url);
      const clicked = await call("double_click", {
        session: "held",
        target: { selector: '[data-testid="save-btn"]' },
      });
      expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
      const geo = await call("set_geolocation", { session: "held", latitude: 1, longitude: 1 });
      expect(geo.error ?? "").not.toMatch(/^policy: /);
      expect(asked.length).toBe(before);
    },
    KEYSTONE_TIMEOUT,
  );
});
