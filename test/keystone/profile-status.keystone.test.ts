// Keystone — `profile_status` against a real headless Chromium.
//
// The unit tests hand `profileStatus` a hand-built probe list. Only a real
// launch proves the two links that make the tool's "live" claim true: that a
// persistent session records the directory Chromium actually opened, and that
// the open context answers a cookie read. A mock satisfies both trivially.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

const KEYSTONE_TIMEOUT = 120_000;

interface ProfileRow {
  name: string;
  path: string;
  bytes: number;
  files: number;
  modifiedAt: string;
  live?: { sessions: string[]; cookieDomains?: string[]; observedAt: string };
  savedAuthState?: { name: string; cookieDomains: string[]; originsWithLocalStorage: string[] };
}
interface StatusBody {
  ok: boolean;
  count: number;
  profilesRoot: string;
  profiles: ProfileRow[];
  tokensEstimate: number;
}

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const fn = server.handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn(args);
  return JSON.parse((res.content[0] as { text: string }).text) as T;
}

const status = (args: Record<string, unknown> = {}): Promise<StatusBody> =>
  callJson<StatusBody>("profile_status", args);

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-profstat-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  fixture = await startFixture();
  server = await createServer({ headless: true });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("profile_status keystone — real Chromium", () => {
  it(
    "reports an empty inventory before any persistent session has opened",
    async () => {
      const body = await status();
      expect(body.ok).toBe(true);
      expect(body.count).toBe(0);
      expect(body.profiles).toEqual([]);
      expect(body.profilesRoot).toBe(join(workspace, "profiles"));
      expect(body.tokensEstimate).toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "reports a real persistent profile as live under the session id that opened it",
    async () => {
      const session = "ks-profile-a";
      const profile = "job-search-live";
      const opened = await callJson<{ ok: boolean }>("open_session", {
        session,
        mode: "persistent",
        profile,
      });
      expect(opened.ok).toBe(true);
      // Navigate + set a cookie so the live context has a domain to report.
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await callJson("cookies_set", { session, name: "ks", value: "1", url: `${fixture.url}/` });

      const body = await status();
      const row = body.profiles.find((p) => p.name === profile);
      expect(row, `profile "${profile}" present in the inventory`).toBeTruthy();
      // The path is the directory Chromium actually launched with.
      expect(row!.path).toBe(join(workspace, "profiles", profile));
      expect(existsSync(row!.path)).toBe(true);
      expect(row!.files).toBeGreaterThan(0);
      expect(row!.bytes).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(row!.modifiedAt))).toBe(false);

      // The live block — the headline claim.
      expect(row!.live?.sessions).toEqual([session]);
      expect(Number.isNaN(Date.parse(row!.live?.observedAt ?? ""))).toBe(false);
      expect(row!.live?.cookieDomains).toContain("127.0.0.1");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "drops the live block once the session closes, keeping the on-disk row",
    async () => {
      const body = await status({ profile: "job-search-live" });
      expect(body.count).toBe(1);
      const row = body.profiles[0]!;
      expect(row.live).toBeUndefined();
      // The profile itself survives — this is exactly the collectable-directory
      // signal: present on disk, nothing open, with an mtime to age it by.
      expect(row.files).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(row.modifiedAt))).toBe(false);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "labels a same-named auth slot as saved state, distinct from the live block",
    async () => {
      const session = "ks-profile-b";
      const profile = "saved-slot";
      await callJson("open_session", { session, mode: "persistent", profile });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await callJson("cookies_set", { session, name: "slot", value: "1", url: `${fixture.url}/` });
      const saved = await callJson<{ ok: boolean }>("auth_save", { session, name: profile });
      expect(saved.ok).toBe(true);
      await callJson("close_session", { session });

      const row = (await status({ profile })).profiles[0]!;
      expect(row.live, "closed session leaves no live block").toBeUndefined();
      expect(row.savedAuthState?.name).toBe(profile);
      expect(row.savedAuthState?.cookieDomains).toContain("127.0.0.1");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a path-escaping profile name with a structured error",
    async () => {
      const body = await status({ profile: "../../etc" });
      expect(body.ok).toBe(false);
      expect(String((body as unknown as { error: string }).error)).toMatch(
        /must resolve inside \$BROWX_WORKSPACE/,
      );
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "leaves incognito sessions out of the inventory entirely",
    async () => {
      const session = "ks-profile-incog";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      const names = (await status()).profiles.map((p) => p.name);
      expect(names).not.toContain(session);
      expect((await status()).profiles.every((p) => p.live === undefined)).toBe(true);
      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
