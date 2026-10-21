// Keystone — the default launch posture against a real browser.
//
// A persistent session with no `channel` tries the installed Google Chrome and
// falls back to the bundled Chromium with a logged warning when Chrome is not
// installed; the CI box has none, so this lane exercises the fallback. With no
// `profile`, every persistent session of a workspace lands on the workspace
// default profile, so a second one is refused by name instead of colliding in
// Chromium's own lock. Incognito stays independent of both.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { findInstalledChrome } from "../../src/cli/chrome-launch.js";
import { startFixture, waitFor, type Fixture } from "./fixture.js";

const KEYSTONE_TIMEOUT = 120_000;

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let workspace: string;
let stderr = "";
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const fn = server.handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn(args);
  return JSON.parse((res.content[0] as { text: string }).text) as T;
}

interface Opened {
  ok: boolean;
  error?: string;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-realchrome-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  const realWrite = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return realWrite(chunk);
  }) as typeof process.stderr.write);
  fixture = await startFixture();
  server = await createServer({ headless: true });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  vi.restoreAllMocks();
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("default launch posture keystone — real browser", () => {
  it(
    "opens a persistent session with no channel and logs the fallback when Chrome is absent",
    async () => {
      const opened = await callJson<Opened>("open_session", {
        session: "ks-real-a",
        mode: "persistent",
      });
      expect(opened.ok).toBe(true);
      await callJson("navigate", { session: "ks-real-a", url: `${fixture.url}/` });

      if (findInstalledChrome()) {
        expect(stderr).not.toMatch(/no installed "chrome" browser found/);
      } else {
        await waitFor(() => /no installed "chrome" browser found/.test(stderr), {
          what: "the bundled-Chromium fallback warning",
        });
        expect(stderr).toMatch(/launching Playwright's bundled Chromium/);
      }
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
      const refused = await callJson<Opened>("open_session", {
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
    "lets an explicit profile and an incognito session run beside it",
    async () => {
      const named = await callJson<Opened>("open_session", {
        session: "ks-real-b",
        mode: "persistent",
        profile: "ks-real-named",
      });
      expect(named.ok).toBe(true);
      expect(existsSync(join(workspace, "profiles", "ks-real-named"))).toBe(true);
      const incognito = await callJson<Opened>("open_session", {
        session: "ks-real-c",
        mode: "incognito",
      });
      expect(incognito.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "frees the default profile once its session closes",
    async () => {
      await callJson("close_session", { session: "ks-real-a" });
      const reopened = await callJson<Opened>("open_session", {
        session: "ks-real-d",
        mode: "persistent",
      });
      expect(reopened.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );
});
