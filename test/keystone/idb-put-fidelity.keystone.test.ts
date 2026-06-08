// idb_put value-fidelity keystone — drives the FULL server-handler path
// (Zod → handler → idbPut → real Chromium → IDB), then reads back via
// raw eval_js (NOT idb_get) to verify what's actually in the store.
//
// Adopter report 2026-06-08: idb_put({value:{hello:"world",...}}) appeared
// to write a JSON STRING to IDB, not the structured object. They confirmed
// by reading via eval_js and seeing typeof === 'string'. This keystone is
// the gate — if the bug exists it fails; if the page-side code path is
// actually correct then the test proves it for the record.

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
  if (!fn) throw new Error(`idb-put keystone: no handler "${name}"`);
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
  workspace = mkdtempSync(join(tmpdir(), "browx-idbput-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  // eval needed so we can bypass idb_get and read raw bytes.
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

async function waitForSeed(session: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await callJson<{ ok: boolean }>(
      "verify_text",
      { session, selector: '[data-testid="storage-seed-state"]', text: "ready", exact: true },
    );
    if (r.ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("idb-put keystone: storage seeding never reached 'ready'");
}

async function rawIdbRead(session: string, dbName: string, storeName: string, key: string): Promise<{ type: string; value: unknown }> {
  const r = await callJson<{ ok: boolean; value?: { type: string; value: unknown }; error?: string }>(
    "eval_js",
    {
      session,
      expr: `(async () => {
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open(${JSON.stringify(dbName)});
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        const tx = db.transaction(${JSON.stringify(storeName)}, 'readonly');
        const store = tx.objectStore(${JSON.stringify(storeName)});
        const v = await new Promise((res, rej) => {
          const req = store.get(${JSON.stringify(key)});
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        db.close();
        return { type: typeof v, value: v };
      })()`,
    },
  );
  if (!r.ok || !r.value) throw new Error(`raw read failed: ${r.error ?? "unknown"}`);
  return r.value;
}

describe("idb_put fidelity keystone — values must round-trip as structured objects, not JSON strings", () => {
  it(
    "writes an object, reads back via raw eval_js as an object (not a JSON string)",
    async () => {
      const session = "ks-idbput-obj";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await waitForSeed(session);

      const payload = { hello: "world", n: 42, nested: { a: [1, 2, 3] } };

      const put = await callJson<{ ok: boolean; error?: string }>("idb_put", {
        session,
        dbName: "app",
        storeName: "kv",
        key: "ks-fidelity-obj",
        value: payload,
      });
      expect(put.ok).toBe(true);

      const raw = await rawIdbRead(session, "app", "kv", "ks-fidelity-obj");

      // THIS is the regression gate. If page-side `var value = ...`
      // double-stringifies, this will be `string` and the value will be
      // the JSON-encoded text. The bug-fix asserts type:"object".
      expect(raw.type).toBe("object");
      expect(raw.value).toEqual(payload);

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "writes a primitive (number, then string), reads it back as the same primitive",
    async () => {
      const session = "ks-idbput-prim";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await waitForSeed(session);

      await callJson("idb_put", {
        session, dbName: "app", storeName: "kv", key: "num", value: 42,
      });
      const rNum = await rawIdbRead(session, "app", "kv", "num");
      expect(rNum.type).toBe("number");
      expect(rNum.value).toBe(42);

      await callJson("idb_put", {
        session, dbName: "app", storeName: "kv", key: "str", value: "hello",
      });
      const rStr = await rawIdbRead(session, "app", "kv", "str");
      // A real string stays a string — preserving the platform shape.
      expect(rStr.type).toBe("string");
      expect(rStr.value).toBe("hello");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "idb_get returns the same shape that was stored (round-trip through the curated read tool)",
    async () => {
      const session = "ks-idbput-roundtrip";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await waitForSeed(session);

      const payload = { tag: "shape", arr: ["a", "b"], deep: { k: 1 } };
      await callJson("idb_put", {
        session, dbName: "app", storeName: "kv", key: "rt", value: payload,
      });

      const got = await callJson<{
        ok: boolean; found: boolean; value?: unknown;
      }>("idb_get", { session, dbName: "app", storeName: "kv", key: "rt" });
      expect(got.ok).toBe(true);
      expect(got.found).toBe(true);
      expect(got.value).toEqual(payload);
      expect(typeof got.value).toBe("object");

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "surfaces a warnings[] entry when `value` arrives as a JSON-shaped STRING (MCP client double-encoding gotcha)",
    async () => {
      const session = "ks-idbput-warn";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await waitForSeed(session);

      // Simulate the adopter's failure shape: client double-encoded the
      // complex object as a JSON string before the wire. Handler should
      // detect this and surface a structured warning while still storing
      // the value verbatim (some apps legitimately want a JSON string).
      const r = await callJson<{ ok: boolean; warnings?: string[] }>("idb_put", {
        session,
        dbName: "app",
        storeName: "kv",
        key: "ks-warn",
        value: '{"hello":"world","n":42}',
      });
      expect(r.ok).toBe(true);
      expect(r.warnings).toBeDefined();
      expect(r.warnings!.some((w) => w.toLowerCase().includes("json-encoded string"))).toBe(true);

      // Confirm the value WAS stored — verbatim, as a string — so apps
      // that genuinely meant to store a JSON string aren't broken.
      const raw = await rawIdbRead(session, "app", "kv", "ks-warn");
      expect(raw.type).toBe("string");
      expect(raw.value).toBe('{"hello":"world","n":42}');

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "does NOT surface the warning when `value` is a plain (non-JSON-shaped) string",
    async () => {
      const session = "ks-idbput-warn-neg";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: `${fixture.url}/` });
      await waitForSeed(session);

      const r = await callJson<{ ok: boolean; warnings?: string[] }>("idb_put", {
        session, dbName: "app", storeName: "kv", key: "plain", value: "hello world",
      });
      expect(r.ok).toBe(true);
      // The warning should fire ONLY for {/[ -shaped strings that JSON-parse
      // to an object/array. Plain strings stay quiet.
      expect(r.warnings).toBeUndefined();

      await callJson("close_session", { session });
    },
    KEYSTONE_TIMEOUT,
  );
});
