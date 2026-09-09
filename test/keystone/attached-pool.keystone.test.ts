// Attached-target pool keystone (RFC 0005) — the regression gate for the
// silent-wrong-write defect. A real Chrome is spawned with an open CDP port and
// two attached sessions are opened against it; before the pool both resolved
// `contexts()[0].pages()[0]`, so one agent's fill landed on the other's form with
// no error. Mocks cannot prove this: the target identity only exists over CDP.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createSocket } from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../../src/server.js";
import { attachByobChromium } from "../../src/session/byob-attach.js";
import { startFixture, type Fixture } from "./fixture.js";

const KEYSTONE_TIMEOUT = 120_000;
const TASK_INPUT = '[data-testid="task-input"]';

const chromePath = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const describePool = chromePath && existsSync(chromePath) ? describe : describe.skip;

let fixture: Fixture;
let chrome: ChildProcess;
let endpoint: string;
let workspace: string;
let profileDir: string;
const savedEnv: Record<string, string | undefined> = {};

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

async function waitForCdp(url: string, proc: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    // A Chrome that died is the common failure and it never recovers, so report
    // its exit code and stderr instead of burning the full deadline on a
    // timeout that says nothing about why.
    if (proc.exitCode !== null) {
      throw new Error(
        `Chrome exited with code ${proc.exitCode} before opening ${url}: ${stderr().trim() || "(no stderr)"}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`CDP endpoint ${url} never came up: ${stderr().trim() || "(no stderr)"}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openPageUrls(): Promise<string[]> {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    return browser
      .contexts()
      .flatMap((c) => c.pages())
      .map((p) => p.url());
  } finally {
    await browser.close();
  }
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-attach-pool-"));
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,byob-attach";

  fixture = await startFixture();
  if (!chromePath || !existsSync(chromePath)) return;

  profileDir = mkdtempSync(join(tmpdir(), "browx-attach-pool-profile-"));
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
  await waitForCdp(endpoint, chrome, () => stderr);
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await exited;
  }
  await fixture?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.BROWX_CAPABILITIES;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  // The profile dir is Chrome's, not ours — it may still be flushing on exit.
  if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
}, KEYSTONE_TIMEOUT);

describePool("attached-target pool — two sessions, one Chrome", () => {
  it(
    "leases two distinct targets and keeps each session's writes on its own page",
    async () => {
      const a = await attachByobChromium({ attachCdp: endpoint, sessionId: "pool-a" });
      const b = await attachByobChromium({ attachCdp: endpoint, sessionId: "pool-b" });

      expect(a.targetId?.()).toBeTruthy();
      expect(b.targetId?.()).toBeTruthy();
      expect(a.targetId?.()).not.toBe(b.targetId?.());
      expect(a.page()).not.toBe(b.page());

      await a.page().goto(`${fixture.url}/`);
      await b.page().goto(`${fixture.url}/`);
      await a.page().fill(TASK_INPUT, "FROM-A");

      expect(await a.page().inputValue(TASK_INPUT)).toBe("FROM-A");
      expect(await b.page().inputValue(TASK_INPUT)).toBe("");

      // b found no free target, so it created one and owns it; a claimed the
      // tab the operator already had open and must leave it behind.
      const claimedUrl = a.page().url();
      await b.close();
      await a.close();

      const remaining = await openPageUrls();
      expect(remaining).toContain(claimedUrl);
      expect(remaining.length).toBe(1);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "keeps a fill in one MCP session off the other session's form",
    async () => {
      const server = await createServer({ attachCdp: endpoint, headless: true });
      const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
        const fn = server.handlers[name];
        if (!fn) throw new Error(`attached-pool keystone: no handler "${name}"`);
        const res = await fn(args);
        return JSON.parse((res.content[0] as { text: string }).text) as T;
      };
      try {
        await call("approve_actions", { scopes: ["byob_action"], ttlSeconds: 600 });
        await call("open_session", { session: "agent-a", mode: "attached" });
        await call("open_session", { session: "agent-b", mode: "attached" });
        await call("navigate", { session: "agent-a", url: `${fixture.url}/` });
        await call("navigate", { session: "agent-b", url: `${fixture.url}/` });

        const filled = await call<{ ok: boolean; element?: { value?: string | null } }>("fill", {
          session: "agent-a",
          selector: TASK_INPUT,
          value: "ONLY-A",
        });
        expect(filled.ok).toBe(true);
        expect(filled.element?.value).toBe("ONLY-A");

        const bBlank = await call<{ ok: boolean }>("verify_value", {
          session: "agent-b",
          selector: TASK_INPUT,
          value: "",
        });
        expect(bBlank.ok).toBe(true);

        const aKept = await call<{ ok: boolean }>("verify_value", {
          session: "agent-a",
          selector: TASK_INPUT,
          value: "ONLY-A",
        });
        expect(aKept.ok).toBe(true);
      } finally {
        await server.shutdown();
      }
    },
    KEYSTONE_TIMEOUT,
  );
});
