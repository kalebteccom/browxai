// Cache API + IndexedDB keystone — drives the Phase 7 storage-state CRUD
// surface against a real headless Chromium. The fixture page populates
// `caches.open("v1")` with a text + binary entry and `indexedDB.open("app")`
// with a "kv" store carrying two records; this suite reads them back,
// mutates them, and asserts the round-trip.
//
// Origin-scope assertions: every tool rejects with the "Navigate the
// session" hint when the session is on about:blank — the same posture
// localStorage / sessionStorage take.

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
  if (!fn) throw new Error(`cache-idb keystone: no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-cache-idb-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  fixture = await startFixture();
  server = await createServer({ headless: true });
  handlers = server.handlers;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await server?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

// Poll the fixture page's #storageSeedState until it reports "ready" — the
// page seeds caches + IDB in an async IIFE and the keystone shouldn't race
// against the initial population.
async function waitForSeed(session: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await callJson<{ ok: boolean }>("verify_text", {
      session,
      selector: '[data-testid="storage-seed-state"]',
      text: "ready",
      exact: true,
    });
    if (r.ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("cache-idb keystone: storage seeding never reached 'ready'");
}

describe("cache + idb keystone — Phase 7 storage CRUD against real Chromium", () => {
  it(
    "Cache API round-trip — list / get text + binary / put / delete / clear / delete_storage",
    async () => {
      const session = "ks-cache";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await waitForSeed(session);

      // (1) caches_list_storages — the fixture-seeded "v1" is visible.
      const listStorages = await callJson<{ names: string[]; origin: string }>(
        "caches_list_storages",
        { session },
      );
      expect(listStorages.names).toContain("v1");
      expect(listStorages.origin).toBe(new URL(fixture.url).origin);

      // (2) caches_list — both entries in "v1".
      const entries = await callJson<{ entries: Array<{ url: string }>; count: number }>(
        "caches_list",
        { session, cacheName: "v1" },
      );
      expect(entries.count).toBeGreaterThanOrEqual(2);
      const urls = entries.entries.map((e) => e.url);
      expect(urls.some((u) => u.endsWith("/cached/hello.json"))).toBe(true);
      expect(urls.some((u) => u.endsWith("/cached/img.png"))).toBe(true);

      // (3) caches_get — text body comes back as kind:"text" w/ parseable JSON.
      const helloUrl = urls.find((u) => u.endsWith("/cached/hello.json"))!;
      const txt = await callJson<{
        found: boolean;
        kind: string;
        text: string;
        status: number;
        contentType: string;
      }>("caches_get", { session, cacheName: "v1", url: helloUrl });
      expect(txt.found).toBe(true);
      expect(txt.kind).toBe("text");
      expect(JSON.parse(txt.text)).toEqual({ hi: "world" });
      expect(txt.status).toBe(200);
      expect(txt.contentType).toMatch(/application\/json/);

      // (4) caches_get — binary body comes back as kind:"binary" + base64.
      const imgUrl = urls.find((u) => u.endsWith("/cached/img.png"))!;
      const bin = await callJson<{
        found: boolean;
        kind: string;
        contentBase64: string;
        byteLength: number;
      }>("caches_get", { session, cacheName: "v1", url: imgUrl });
      expect(bin.found).toBe(true);
      expect(bin.kind).toBe("binary");
      expect(bin.byteLength).toBe(4);
      expect(Buffer.from(bin.contentBase64, "base64").toString("hex")).toBe("89504e47");

      // (5) caches_put — agent-side put + readback.
      const newUrl = `${fixture.url}/cached/agent.txt`;
      await callJson("caches_put", {
        session,
        cacheName: "v1",
        url: newUrl,
        response: { body: "agent-wrote-this", headers: { "content-type": "text/plain" } },
      });
      const back = await callJson<{ found: boolean; kind: string; text: string }>("caches_get", {
        session,
        cacheName: "v1",
        url: newUrl,
      });
      expect(back.found).toBe(true);
      expect(back.kind).toBe("text");
      expect(back.text).toBe("agent-wrote-this");

      // (6) urlPattern filter narrows to /cached/.
      const filtered = await callJson<{ count: number; entries: Array<{ url: string }> }>(
        "caches_list",
        { session, cacheName: "v1", urlPattern: "/cached/" },
      );
      expect(filtered.count).toBeGreaterThanOrEqual(3);
      expect(filtered.entries.every((e) => e.url.includes("/cached/"))).toBe(true);

      // (7) caches_delete — first call existed:true, second false.
      const del1 = await callJson<{ existed: boolean }>("caches_delete", {
        session,
        cacheName: "v1",
        url: newUrl,
      });
      expect(del1.existed).toBe(true);
      const del2 = await callJson<{ existed: boolean }>("caches_delete", {
        session,
        cacheName: "v1",
        url: newUrl,
      });
      expect(del2.existed).toBe(false);

      // (8) caches_clear — wipes remaining entries, storage stays around.
      const clear = await callJson<{ cleared: number }>("caches_clear", {
        session,
        cacheName: "v1",
      });
      expect(clear.cleared).toBeGreaterThanOrEqual(2);
      const post = await callJson<{ names: string[] }>("caches_list_storages", { session });
      expect(post.names).toContain("v1");

      // (9) caches_delete_storage — drops it; idempotent.
      const drop1 = await callJson<{ existed: boolean }>("caches_delete_storage", {
        session,
        cacheName: "v1",
      });
      expect(drop1.existed).toBe(true);
      const drop2 = await callJson<{ existed: boolean }>("caches_delete_storage", {
        session,
        cacheName: "v1",
      });
      expect(drop2.existed).toBe(false);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "IndexedDB round-trip — list dbs / list stores / get / put / delete / clear",
    async () => {
      const session = "ks-idb";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await waitForSeed(session);

      // (1) idb_list_databases — Chromium exposes the databases() API.
      const dbs = await callJson<{
        supported: boolean;
        databases: Array<{ name: string; version: number }>;
      }>("idb_list_databases", { session });
      expect(dbs.supported).toBe(true);
      expect(dbs.databases.some((d) => d.name === "app")).toBe(true);

      // (2) idb_list_stores — "kv" is present.
      const stores = await callJson<{ stores: string[]; version: number }>("idb_list_stores", {
        session,
        dbName: "app",
      });
      expect(stores.stores).toContain("kv");

      // (3) idb_get — seeded records readable.
      const u1 = await callJson<{ found: boolean; value: { name: string } }>("idb_get", {
        session,
        dbName: "app",
        storeName: "kv",
        key: "u1",
      });
      expect(u1.found).toBe(true);
      expect(u1.value).toEqual({ name: "Ada" });

      // (4) idb_get — missing key returns found:false.
      const ghost = await callJson<{ found: boolean }>("idb_get", {
        session,
        dbName: "app",
        storeName: "kv",
        key: "ghost",
      });
      expect(ghost.found).toBe(false);

      // (5) idb_put — agent-side write + readback.
      await callJson("idb_put", {
        session,
        dbName: "app",
        storeName: "kv",
        key: "u3",
        value: { name: "Grace" },
      });
      const back = await callJson<{ found: boolean; value: { name: string } }>("idb_get", {
        session,
        dbName: "app",
        storeName: "kv",
        key: "u3",
      });
      expect(back.found).toBe(true);
      expect(back.value).toEqual({ name: "Grace" });

      // (6) idb_put against a missing store — schema-hint rejection.
      const missing = await callJson<{ ok: boolean; error?: string }>("idb_put", {
        session,
        dbName: "app",
        storeName: "absent",
        key: "k",
        value: 1,
      });
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatch(/does not exist|upgrade transaction/);

      // (7) idb_delete — first call ok; second still ok (idempotent).
      await callJson("idb_delete", { session, dbName: "app", storeName: "kv", key: "u3" });
      const gone = await callJson<{ found: boolean }>("idb_get", {
        session,
        dbName: "app",
        storeName: "kv",
        key: "u3",
      });
      expect(gone.found).toBe(false);

      // (8) idb_clear — empties the store; subsequent gets miss.
      await callJson("idb_clear", { session, dbName: "app", storeName: "kv" });
      const r = await callJson<{ found: boolean }>("idb_get", {
        session,
        dbName: "app",
        storeName: "kv",
        key: "u1",
      });
      expect(r.found).toBe(false);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "origin guard — both surfaces reject when navigated to about:blank",
    async () => {
      const session = "ks-storage-guard";
      await callJson("open_session", { session, mode: "incognito" });
      // No navigate — session is on about:blank by default.

      const cachesRes = await callJson<{ ok: boolean; error?: string }>("caches_list_storages", {
        session,
      });
      expect(cachesRes.ok).toBe(false);
      expect(cachesRes.error).toMatch(/Navigate the session/);

      const idbRes = await callJson<{ ok: boolean; error?: string }>("idb_list_databases", {
        session,
      });
      expect(idbRes.ok).toBe(false);
      expect(idbRes.error).toMatch(/Navigate the session/);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
