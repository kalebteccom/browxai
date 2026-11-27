// Keystone — the default launch posture against a real server.
//
// A chromium session with no `channel` launches the installed Google Chrome and
// nothing else. On a host without Chrome (the CI box) it is refused with
// `chrome-not-installed`, before any browser starts. `BROWX_CHANNEL=chromium` is
// the opt-in for Playwright's bundled Chromium, and with it the same open
// launches. With no `profile`, every persistent session of a workspace lands on
// the workspace default profile, so a second one is refused by name instead of
// colliding in Chromium's own lock.

import { it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { findInstalledChrome } from "../../src/cli/chrome-launch.js";
import { startFixture, waitFor, type Fixture } from "./fixture.js";
import { engineGate, gatedDescribe, hostGate } from "./keystone-gate.js";

const KEYSTONE_TIMEOUT = 120_000;

type Server = Awaited<ReturnType<typeof createServer>>;

interface Opened {
  ok: boolean;
  code?: string;
  error?: string;
}

async function callJson<T>(server: Server, name: string, args: Record<string, unknown>) {
  const fn = server.handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn(args);
  return JSON.parse((res.content[0] as { text: string }).text) as T;
}

/** Clear every BROWX_ variable; `restore` puts them back. */
function isolatedEnv(): { restore: () => void } {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  return {
    restore: () => {
      for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    },
  };
}

const noChrome = hostGate(
  !findInstalledChrome(),
  "Google Chrome is installed on this host, so a launch with no channel does not refuse",
);

gatedDescribe(noChrome)("default launch with no installed Chrome — refused", () => {
  let server: Server;
  let workspace: string;
  let env: { restore: () => void };

  beforeAll(async () => {
    env = isolatedEnv();
    workspace = mkdtempSync(join(tmpdir(), "browx-nochrome-ks-"));
    process.env.BROWX_WORKSPACE = workspace;
    server = await createServer({ headless: true });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    env?.restore();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "open_session returns chrome-not-installed and names the opt-in",
    async () => {
      for (const mode of ["persistent", "incognito"]) {
        const opened = await callJson<Opened>(server, "open_session", {
          session: `ks-nochrome-${mode}`,
          mode,
        });
        expect(opened.ok, mode).toBe(false);
        expect(opened.code, mode).toBe("chrome-not-installed");
        expect(opened.error, mode).toMatch(/^chrome-not-installed: /);
        expect(opened.error, mode).toContain("BROWX_CHANNEL=chromium");
        expect(opened.error, mode).toContain('`channel: "chromium"`');
      }
      const listed = await callJson<{ sessions: Array<{ id: string }> }>(
        server,
        "list_sessions",
        {},
      );
      expect(listed.sessions.map((s) => s.id)).toEqual([]);
    },
    KEYSTONE_TIMEOUT,
  );
});

gatedDescribe(engineGate("chromium"))("open_session channel chromium — one session opts in", () => {
  let server: Server;
  let workspace: string;
  let env: { restore: () => void };

  beforeAll(async () => {
    env = isolatedEnv();
    workspace = mkdtempSync(join(tmpdir(), "browx-optin-ks-"));
    process.env.BROWX_WORKSPACE = workspace;
    server = await createServer({ headless: true });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    env?.restore();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "launches the bundled build for a session that names it, with no BROWX_CHANNEL",
    async () => {
      const opened = await callJson<Opened>(server, "open_session", {
        session: "ks-optin",
        mode: "incognito",
        channel: "chromium",
      });
      expect(opened.ok, opened.error).toBe(true);
      await callJson(server, "close_session", { session: "ks-optin" });
    },
    KEYSTONE_TIMEOUT,
  );
});

gatedDescribe(engineGate("chromium"))("BROWX_CHANNEL=chromium — the bundled build", () => {
  let fixture: Fixture;
  let server: Server;
  let workspace: string;
  let env: { restore: () => void };

  beforeAll(async () => {
    env = isolatedEnv();
    workspace = mkdtempSync(join(tmpdir(), "browx-realchrome-ks-"));
    process.env.BROWX_WORKSPACE = workspace;
    process.env.BROWX_CHANNEL = "chromium";
    fixture = await startFixture();
    server = await createServer({ headless: true });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    env?.restore();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "opens a persistent session with no per-session channel and navigates",
    async () => {
      const opened = await callJson<Opened>(server, "open_session", {
        session: "ks-real-a",
        mode: "persistent",
      });
      expect(opened.ok, opened.error).toBe(true);
      const nav = await callJson<{ ok: boolean }>(server, "navigate", {
        session: "ks-real-a",
        url: `${fixture.url}/`,
      });
      expect(nav.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "runs it on the workspace default profile, not on a directory named after the session",
    async () => {
      await waitFor(() => existsSync(join(workspace, "profile")), {
        what: "the default profile directory",
      });
      expect(readdirSync(join(workspace, "profile")).length).toBeGreaterThan(0);
      expect(existsSync(join(workspace, "profiles", "ks-real-a"))).toBe(false);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a second persistent session on the held default profile, naming the holder",
    async () => {
      const refused = await callJson<Opened>(server, "open_session", {
        session: "ks-real-b",
        mode: "persistent",
      });
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(/profile-in-use/);
      expect(refused.error).toContain('session "ks-real-a"');
      expect(refused.error).toContain("explicit `profile`");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "frees the default profile once its session closes",
    async () => {
      await callJson(server, "close_session", { session: "ks-real-a" });
      const reopened = await callJson<Opened>(server, "open_session", {
        session: "ks-real-d",
        mode: "persistent",
      });
      expect(reopened.ok, reopened.error).toBe(true);
      await callJson(server, "close_session", { session: "ks-real-d" });
    },
    KEYSTONE_TIMEOUT,
  );
});
