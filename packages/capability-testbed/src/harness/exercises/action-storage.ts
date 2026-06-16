import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

const STORAGE = {
  seed: '[data-testid="seed-storage"]',
  out: '[data-testid="storage-out"]',
} as const;

function exercise(fn: (ctx: ExerciseCtx) => Promise<ExerciseResult>): Exercise {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      return {
        outcome: "error",
        detail: err instanceof Error ? err.message : "Exercise threw a non-Error value",
        evidence: String(err),
      };
    }
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function firstText(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  for (const item of value.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
}

function payload(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data;
  const text = firstText(value);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function payloadRecord(value: unknown, label: string): JsonRecord {
  const data = payload(value);
  if (!isRecord(data)) throw new Error(`${label} did not return a JSON object`);
  return data;
}

function recordAt(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringAt(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberAt(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanAt(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireOk(record: JsonRecord, label: string): void {
  if (record.ok !== true) {
    throw new Error(`${label} did not return ok:true`);
  }
}

function safeSession(ctx: ExerciseCtx): string {
  return ctx.session.replace(/[^A-Za-z0-9._-]/g, "_");
}

function storageUrl(ctx: ExerciseCtx): string {
  return `${ctx.baseUrl}/storage`;
}

async function gotoStorage(ctx: ExerciseCtx): Promise<void> {
  await ctx.goto("/storage");
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  const result = await ctx.call("verify_text", { selector, text, exact });
  const data = payloadRecord(result, "verify_text");
  requireOk(data, "verify_text");
  return data;
}

async function seedStorage(ctx: ExerciseCtx): Promise<void> {
  await gotoStorage(ctx);
  await ctx.call("click", { selector: STORAGE.seed });
  await verifyText(ctx, STORAGE.out, "seeded", true);
}

async function cookieValue(ctx: ExerciseCtx, name: string): Promise<string | null> {
  const data = payloadRecord(
    await ctx.call("cookies_get", { name, url: storageUrl(ctx) }),
    "cookies_get",
  );
  requireOk(data, "cookies_get");
  const cookie = recordAt(data, "cookie");
  return cookie ? (stringAt(cookie, "value") ?? null) : null;
}

async function cookieNames(ctx: ExerciseCtx): Promise<string[]> {
  const data = payloadRecord(
    await ctx.call("cookies_list", { urls: [storageUrl(ctx)] }),
    "cookies_list",
  );
  requireOk(data, "cookies_list");
  return asRecords(data.cookies)
    .map((cookie) => stringAt(cookie, "name"))
    .filter((name): name is string => name !== undefined);
}

async function webStorageValue(
  ctx: ExerciseCtx,
  kind: "localstorage" | "sessionstorage",
  key: string,
): Promise<string | null> {
  const data = payloadRecord(await ctx.call(`${kind}_get`, { key }), `${kind}_get`);
  requireOk(data, `${kind}_get`);
  const value = data.value;
  return typeof value === "string" ? value : null;
}

async function webStorageEntries(
  ctx: ExerciseCtx,
  kind: "localstorage" | "sessionstorage",
): Promise<JsonRecord[]> {
  const data = payloadRecord(await ctx.call(`${kind}_list`), `${kind}_list`);
  requireOk(data, `${kind}_list`);
  return asRecords(data.entries);
}

function hasEntry(entries: readonly JsonRecord[], key: string): boolean {
  return entries.some((entry) => stringAt(entry, "key") === key);
}

async function idbValue(ctx: ExerciseCtx, key: string): Promise<unknown> {
  const data = payloadRecord(
    await ctx.call("idb_get", { dbName: "testbed-db", storeName: "kv", key }),
    "idb_get",
  );
  requireOk(data, "idb_get");
  return data.found === true ? data.value : undefined;
}

async function cacheEntry(
  ctx: ExerciseCtx,
  cacheName: string,
  url: string,
): Promise<JsonRecord> {
  const data = payloadRecord(await ctx.call("caches_get", { cacheName, url }), "caches_get");
  requireOk(data, "caches_get");
  return data;
}

async function authSlotNames(ctx: ExerciseCtx): Promise<string[]> {
  const data = payloadRecord(await ctx.call("auth_list"), "auth_list");
  requireOk(data, "auth_list");
  return asRecords(data.slots)
    .map((slot) => stringAt(slot, "name"))
    .filter((name): name is string => name !== undefined);
}

const cookies_set = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const name = `ck-${safeSession(ctx)}`;
  const set = payloadRecord(
    await ctx.call("cookies_set", { name, value: "cookie-action-value", url: storageUrl(ctx) }),
    "cookies_set",
  );
  requireOk(set, "cookies_set");
  const value = await cookieValue(ctx, name);
  if (value === "cookie-action-value") {
    return pass("cookies_set wrote a cookie visible through cookies_get", { set, name, value });
  }
  return fail("cookies_set did not round-trip through cookies_get", { set, name, value });
});

const cookies_delete = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const name = `ck-delete-${safeSession(ctx)}`;
  requireOk(
    payloadRecord(
      await ctx.call("cookies_set", { name, value: "delete-me", url: storageUrl(ctx) }),
      "cookies_set",
    ),
    "cookies_set",
  );
  if ((await cookieValue(ctx, name)) !== "delete-me") {
    return fail("setup cookie was not visible before cookies_delete", { name });
  }
  const deleted = payloadRecord(
    await ctx.call("cookies_delete", { name, url: storageUrl(ctx) }),
    "cookies_delete",
  );
  requireOk(deleted, "cookies_delete");
  const value = await cookieValue(ctx, name);
  if (value === null) return pass("cookies_delete removed the named cookie", { deleted, name });
  return fail("cookies_delete left the cookie visible", { deleted, name, value });
});

const cookies_clear = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const one = `ck-clear-a-${safeSession(ctx)}`;
  const two = `ck-clear-b-${safeSession(ctx)}`;
  for (const name of [one, two]) {
    requireOk(
      payloadRecord(
        await ctx.call("cookies_set", { name, value: "clear-me", url: storageUrl(ctx) }),
        "cookies_set",
      ),
      "cookies_set",
    );
  }
  const cleared = payloadRecord(await ctx.call("cookies_clear"), "cookies_clear");
  requireOk(cleared, "cookies_clear");
  const names = await cookieNames(ctx);
  if (!names.includes(one) && !names.includes(two)) {
    return pass("cookies_clear removed all exercise cookies for the storage origin", {
      cleared,
      names,
    });
  }
  return fail("cookies_clear left exercise cookies behind", { cleared, names, expectedGone: [one, two] });
});

const localstorage_set = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const key = `ls-set-${safeSession(ctx)}`;
  const set = payloadRecord(
    await ctx.call("localstorage_set", { key, value: "local-action-value" }),
    "localstorage_set",
  );
  requireOk(set, "localstorage_set");
  const value = await webStorageValue(ctx, "localstorage", key);
  if (value === "local-action-value") {
    return pass("localstorage_set wrote a key visible through localstorage_get", { set, key, value });
  }
  return fail("localstorage_set did not round-trip through localstorage_get", { set, key, value });
});

const localstorage_delete = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const key = `ls-delete-${safeSession(ctx)}`;
  requireOk(
    payloadRecord(await ctx.call("localstorage_set", { key, value: "delete-me" }), "localstorage_set"),
    "localstorage_set",
  );
  const deleted = payloadRecord(await ctx.call("localstorage_delete", { key }), "localstorage_delete");
  requireOk(deleted, "localstorage_delete");
  const value = await webStorageValue(ctx, "localstorage", key);
  if (value === null) return pass("localstorage_delete removed the key", { deleted, key });
  return fail("localstorage_delete left the key visible", { deleted, key, value });
});

const localstorage_clear = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const keys = [`ls-clear-a-${safeSession(ctx)}`, `ls-clear-b-${safeSession(ctx)}`];
  for (const key of keys) {
    requireOk(
      payloadRecord(await ctx.call("localstorage_set", { key, value: "clear-me" }), "localstorage_set"),
      "localstorage_set",
    );
  }
  const cleared = payloadRecord(await ctx.call("localstorage_clear"), "localstorage_clear");
  requireOk(cleared, "localstorage_clear");
  const entries = await webStorageEntries(ctx, "localstorage");
  if (keys.every((key) => !hasEntry(entries, key))) {
    return pass("localstorage_clear removed all localStorage keys for the origin", {
      cleared,
      count: entries.length,
    });
  }
  return fail("localstorage_clear left exercise keys behind", { cleared, entries, keys });
});

const sessionstorage_set = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const key = `ss-set-${safeSession(ctx)}`;
  const set = payloadRecord(
    await ctx.call("sessionstorage_set", { key, value: "session-action-value" }),
    "sessionstorage_set",
  );
  requireOk(set, "sessionstorage_set");
  const value = await webStorageValue(ctx, "sessionstorage", key);
  if (value === "session-action-value") {
    return pass("sessionstorage_set wrote a key visible through sessionstorage_get", {
      set,
      key,
      value,
    });
  }
  return fail("sessionstorage_set did not round-trip through sessionstorage_get", { set, key, value });
});

const sessionstorage_delete = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const key = `ss-delete-${safeSession(ctx)}`;
  requireOk(
    payloadRecord(
      await ctx.call("sessionstorage_set", { key, value: "delete-me" }),
      "sessionstorage_set",
    ),
    "sessionstorage_set",
  );
  const deleted = payloadRecord(
    await ctx.call("sessionstorage_delete", { key }),
    "sessionstorage_delete",
  );
  requireOk(deleted, "sessionstorage_delete");
  const value = await webStorageValue(ctx, "sessionstorage", key);
  if (value === null) return pass("sessionstorage_delete removed the key", { deleted, key });
  return fail("sessionstorage_delete left the key visible", { deleted, key, value });
});

const sessionstorage_clear = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const keys = [`ss-clear-a-${safeSession(ctx)}`, `ss-clear-b-${safeSession(ctx)}`];
  for (const key of keys) {
    requireOk(
      payloadRecord(
        await ctx.call("sessionstorage_set", { key, value: "clear-me" }),
        "sessionstorage_set",
      ),
      "sessionstorage_set",
    );
  }
  const cleared = payloadRecord(await ctx.call("sessionstorage_clear"), "sessionstorage_clear");
  requireOk(cleared, "sessionstorage_clear");
  const entries = await webStorageEntries(ctx, "sessionstorage");
  if (keys.every((key) => !hasEntry(entries, key))) {
    return pass("sessionstorage_clear removed all sessionStorage keys for the page", {
      cleared,
      count: entries.length,
    });
  }
  return fail("sessionstorage_clear left exercise keys behind", { cleared, entries, keys });
});

const idb_put = exercise(async (ctx) => {
  await seedStorage(ctx);
  const key = `idb-put-${safeSession(ctx)}`;
  const value = { value: "idb-action-value", count: 1 };
  const put = payloadRecord(
    await ctx.call("idb_put", { dbName: "testbed-db", storeName: "kv", key, value }),
    "idb_put",
  );
  requireOk(put, "idb_put");
  const stored = idbValue(ctx, key);
  const storedValue = await stored;
  if (isRecord(storedValue) && storedValue.value === "idb-action-value" && storedValue.count === 1) {
    return pass("idb_put wrote a structured value visible through idb_get", {
      put,
      key,
      stored: storedValue,
    });
  }
  return fail("idb_put did not round-trip through idb_get", { put, key, stored: storedValue });
});

const idb_delete = exercise(async (ctx) => {
  await seedStorage(ctx);
  const key = `idb-delete-${safeSession(ctx)}`;
  requireOk(
    payloadRecord(
      await ctx.call("idb_put", {
        dbName: "testbed-db",
        storeName: "kv",
        key,
        value: "delete-me",
      }),
      "idb_put",
    ),
    "idb_put",
  );
  const deleted = payloadRecord(
    await ctx.call("idb_delete", { dbName: "testbed-db", storeName: "kv", key }),
    "idb_delete",
  );
  requireOk(deleted, "idb_delete");
  const value = await idbValue(ctx, key);
  if (value === undefined) return pass("idb_delete removed the stored key", { deleted, key });
  return fail("idb_delete left the key visible through idb_get", { deleted, key, value });
});

const idb_clear = exercise(async (ctx) => {
  await seedStorage(ctx);
  const keys = [`idb-clear-a-${safeSession(ctx)}`, `idb-clear-b-${safeSession(ctx)}`];
  for (const key of keys) {
    requireOk(
      payloadRecord(
        await ctx.call("idb_put", { dbName: "testbed-db", storeName: "kv", key, value: "clear-me" }),
        "idb_put",
      ),
      "idb_put",
    );
  }
  const cleared = payloadRecord(
    await ctx.call("idb_clear", { dbName: "testbed-db", storeName: "kv" }),
    "idb_clear",
  );
  requireOk(cleared, "idb_clear");
  const values = await Promise.all([...keys, "idb-key"].map((key) => idbValue(ctx, key)));
  if (values.every((value) => value === undefined)) {
    return pass("idb_clear removed every record from the kv object store", { cleared, keys });
  }
  return fail("idb_clear left values in the kv object store", { cleared, keys, values });
});

const caches_put = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const cacheName = `cache-put-${safeSession(ctx)}`;
  const url = `${ctx.baseUrl}/cache-put-item`;
  const put = payloadRecord(
    await ctx.call("caches_put", {
      cacheName,
      url,
      response: { status: 201, headers: { "content-type": "text/plain" }, body: "cache-action-value" },
    }),
    "caches_put",
  );
  requireOk(put, "caches_put");
  const got = await cacheEntry(ctx, cacheName, url);
  if (got.found === true && got.kind === "text" && got.text === "cache-action-value") {
    return pass("caches_put wrote a Cache API entry visible through caches_get", { put, got });
  }
  return fail("caches_put did not round-trip through caches_get", { put, got });
});

const caches_delete = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const cacheName = `cache-delete-${safeSession(ctx)}`;
  const url = `${ctx.baseUrl}/cache-delete-item`;
  requireOk(
    payloadRecord(
      await ctx.call("caches_put", {
        cacheName,
        url,
        response: { headers: { "content-type": "text/plain" }, body: "delete-me" },
      }),
      "caches_put",
    ),
    "caches_put",
  );
  const deleted = payloadRecord(await ctx.call("caches_delete", { cacheName, url }), "caches_delete");
  requireOk(deleted, "caches_delete");
  const got = await cacheEntry(ctx, cacheName, url);
  if (booleanAt(deleted, "existed") === true && got.found === false) {
    return pass("caches_delete removed the cache entry", { deleted, got });
  }
  return fail("caches_delete did not remove the cache entry", { deleted, got });
});

const caches_clear = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const cacheName = `cache-clear-${safeSession(ctx)}`;
  const urls = [`${ctx.baseUrl}/cache-clear-a`, `${ctx.baseUrl}/cache-clear-b`];
  for (const url of urls) {
    requireOk(
      payloadRecord(
        await ctx.call("caches_put", {
          cacheName,
          url,
          response: { headers: { "content-type": "text/plain" }, body: "clear-me" },
        }),
        "caches_put",
      ),
      "caches_put",
    );
  }
  const cleared = payloadRecord(await ctx.call("caches_clear", { cacheName }), "caches_clear");
  requireOk(cleared, "caches_clear");
  const listed = payloadRecord(await ctx.call("caches_list", { cacheName }), "caches_list");
  requireOk(listed, "caches_list");
  if (numberAt(cleared, "cleared") === 2 && numberAt(listed, "count") === 0) {
    return pass("caches_clear removed every entry while leaving the cache storage readable", {
      cleared,
      listed,
    });
  }
  return fail("caches_clear did not empty the cache storage", { cleared, listed });
});

const caches_delete_storage = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const cacheName = `cache-drop-${safeSession(ctx)}`;
  requireOk(
    payloadRecord(
      await ctx.call("caches_put", {
        cacheName,
        url: `${ctx.baseUrl}/cache-drop-item`,
        response: { body: "drop-me" },
      }),
      "caches_put",
    ),
    "caches_put",
  );
  const deleted = payloadRecord(
    await ctx.call("caches_delete_storage", { cacheName }),
    "caches_delete_storage",
  );
  requireOk(deleted, "caches_delete_storage");
  const storages = payloadRecord(await ctx.call("caches_list_storages"), "caches_list_storages");
  requireOk(storages, "caches_list_storages");
  const names = Array.isArray(storages.names) ? storages.names.filter((name) => typeof name === "string") : [];
  if (booleanAt(deleted, "existed") === true && !names.includes(cacheName)) {
    return pass("caches_delete_storage removed the whole cache storage", { deleted, names });
  }
  return fail("caches_delete_storage left the cache storage listed", { deleted, names });
});

const inject_storage_state = exercise(async (ctx) => {
  await gotoStorage(ctx);
  await ctx.call("localstorage_set", { key: "stale-key", value: "stale-value" });
  const state = {
    cookies: [],
    origins: [
      {
        origin: ctx.baseUrl,
        localStorage: [{ name: "injected-key", value: "injected-value" }],
      },
    ],
  };
  const injected = payloadRecord(
    await ctx.call("inject_storage_state", { state, mode: "replace" }),
    "inject_storage_state",
  );
  requireOk(injected, "inject_storage_state");
  await gotoStorage(ctx);
  const injectedValue = await webStorageValue(ctx, "localstorage", "injected-key");
  const staleValue = await webStorageValue(ctx, "localstorage", "stale-key");
  if (injectedValue === "injected-value" && staleValue === null) {
    return pass("inject_storage_state replaced localStorage with the supplied storage blob", {
      injected,
      injectedValue,
      staleValue,
    });
  }
  return fail("inject_storage_state did not apply replace semantics", {
    injected,
    injectedValue,
    staleValue,
  });
});

const auth_save = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const name = `auth-save-${safeSession(ctx)}`;
  await ctx.call("localstorage_set", { key: "auth-save-key", value: "auth-save-value" });
  const saved = payloadRecord(await ctx.call("auth_save", { name }), "auth_save");
  requireOk(saved, "auth_save");
  const slots = await authSlotNames(ctx);
  if (slots.includes(name)) {
    return pass("auth_save wrote a named storage-state slot visible through auth_list", {
      saved,
      slots,
    });
  }
  return fail("auth_save did not create a visible auth slot", { saved, slots, name });
});

const auth_load = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const name = `auth-load-${safeSession(ctx)}`;
  await ctx.call("localstorage_set", { key: "auth-load-key", value: "auth-load-value" });
  requireOk(payloadRecord(await ctx.call("auth_save", { name }), "auth_save"), "auth_save");
  requireOk(payloadRecord(await ctx.call("localstorage_clear"), "localstorage_clear"), "localstorage_clear");
  const loaded = payloadRecord(await ctx.call("auth_load", { name }), "auth_load");
  requireOk(loaded, "auth_load");
  await gotoStorage(ctx);
  const value = await webStorageValue(ctx, "localstorage", "auth-load-key");
  if (value === "auth-load-value") {
    return pass("auth_load reapplied a saved storage-state slot to the session", { loaded, value });
  }
  return fail("auth_load did not restore the saved localStorage key", { loaded, value });
});

const auth_delete = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const name = `auth-delete-${safeSession(ctx)}`;
  await ctx.call("localstorage_set", { key: "auth-delete-key", value: "auth-delete-value" });
  requireOk(payloadRecord(await ctx.call("auth_save", { name }), "auth_save"), "auth_save");
  const deleted = payloadRecord(await ctx.call("auth_delete", { name }), "auth_delete");
  requireOk(deleted, "auth_delete");
  const slots = await authSlotNames(ctx);
  if (booleanAt(deleted, "existed") === true && !slots.includes(name)) {
    return pass("auth_delete removed the named auth-state slot", { deleted, slots });
  }
  return fail("auth_delete left the named auth-state slot visible", { deleted, slots, name });
});

const artifact_save = exercise(async (ctx) => {
  await gotoStorage(ctx);
  const name = `artifact-${safeSession(ctx)}.json`;
  const content = JSON.stringify({ tool: "artifact_save", ok: true });
  const saved = payloadRecord(await ctx.call("artifact_save", { name, content }), "artifact_save");
  requireOk(saved, "artifact_save");
  const got = payloadRecord(await ctx.call("artifact_get", { name }), "artifact_get");
  requireOk(got, "artifact_get");
  if (got.content === content && numberAt(saved, "size") === content.length) {
    return pass("artifact_save wrote a session artifact readable through artifact_get", {
      saved,
      got,
    });
  }
  return fail("artifact_save did not round-trip through artifact_get", { saved, got, content });
});

const exercises = {
  cookies_set,
  cookies_delete,
  cookies_clear,
  localstorage_set,
  localstorage_delete,
  localstorage_clear,
  sessionstorage_set,
  sessionstorage_delete,
  sessionstorage_clear,
  idb_put,
  idb_delete,
  idb_clear,
  caches_put,
  caches_delete,
  caches_clear,
  caches_delete_storage,
  inject_storage_state,
  auth_save,
  auth_load,
  auth_delete,
  artifact_save,
} satisfies ExerciseMap;

export default exercises;
