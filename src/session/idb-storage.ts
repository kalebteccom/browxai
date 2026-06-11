// IndexedDB CRUD —  storage-state surface extension.
//
// Sibling of cookies / localStorage / sessionStorage / Cache API CRUD.
// Drives the W3C IndexedDB API via `page.evaluate` — the same posture as
// the web-storage helpers (origin-scoped; the session MUST be navigated
// to the target origin first; about:blank rejected).
//
// What's actually stored: each IDB database has named object stores, each
// holding records keyed by a primary key. The CRUD surface here treats
// values as JSON-serialisable — IDB itself can store structured-clonable
// values (Blob/ArrayBuffer/Date/Map/Set), but we go through `JSON.stringify`
// at the page boundary because the MCP transport is JSON-only. Non-JSON
// values (cyclic refs / functions / DOM nodes) are reported as a structured
// error rather than silently dropped — see `idbGet` /  `idbPut` below.
//
// Keys go through JSON too — IDB accepts strings, numbers, dates, and
// arrays as keys. Strings + numbers + array-of-strings/numbers all
// round-trip cleanly through JSON; Date keys are stringified to ISO and
// re-parsed on the way back in. Documented in the tool descriptions.
//
// Capability split (server.ts):
//   - reads  (`idb_list_databases`, `idb_list_stores`, `idb_get`) → `read`
//   - writes (`idb_put`, `idb_delete`, `idb_clear`)               → `action`
//
// Tracker-ID hygiene: zero. Each entry is identified by its
// `(dbName, storeName, key)` triple — the platform's native key.

import type { Page } from "playwright-core";

const IDB_API = "indexedDB";

function idbOriginGuard(page: Page, tool: string): void {
  let url: string;
  try {
    url = page.url();
  } catch {
    url = "";
  }
  if (!url || url === "about:blank") {
    throw new Error(
      `${tool}: IndexedDB is origin-scoped and the page is at "${url || "(unknown)"}". ` +
        `Navigate the session to the target origin first.`,
    );
  }
}

// --- reads -----------------------------------------------------------------

/** Enumerate every database visible to the current origin. Uses
 *  `indexedDB.databases()` — supported by Chromium-family browsers
 *  (the target platform). On engines without it, returns an empty list
 *  with a `supported:false` flag rather than throwing. */
export async function idbListDatabases(
  page: Page,
  tool: string,
): Promise<{
  databases: Array<{ name: string; version: number }>;
  origin: string;
  supported: boolean;
}> {
  idbOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `if (typeof ${IDB_API} === "undefined" || typeof ${IDB_API}.databases !== "function") ` +
    `  return { databases: [], origin: location.origin, supported: false }; ` +
    `var dbs = await ${IDB_API}.databases(); ` +
    `return { databases: dbs.map(function (d) { return { name: d.name || "", version: d.version || 0 }; }), ` +
    `         origin: location.origin, supported: true }; })()`;
  return await page.evaluate(expr);
}

/** List the object-store names inside a database (read-only — does NOT
 *  trigger an upgrade). */
export async function idbListStores(
  page: Page,
  args: { dbName: string },
  tool: string,
): Promise<{ stores: string[]; dbName: string; version: number; origin: string }> {
  if (!args.dbName) throw new Error(`${tool}: \`dbName\` is required`);
  idbOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var db = await new Promise(function (resolve, reject) { ` +
    `  var req = ${IDB_API}.open(${JSON.stringify(args.dbName)}); ` +
    `  req.onsuccess = function () { resolve(req.result); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `  req.onblocked = function () { reject(new Error("idb_list_stores: open blocked — close other connections to \\"" + ${JSON.stringify(args.dbName)} + "\\" first")); }; ` +
    `}); ` +
    `var names = Array.prototype.slice.call(db.objectStoreNames); ` +
    `var version = db.version; ` +
    `db.close(); ` +
    `return { stores: names, dbName: ${JSON.stringify(args.dbName)}, version: version, origin: location.origin }; })()`;
  return await page.evaluate(expr);
}

/** Get the value at a key. Returns `{found:false}` if absent. Non-JSON
 *  values surface as a structured error rather than a silent `undefined`. */
export async function idbGet(
  page: Page,
  args: { dbName: string; storeName: string; key: unknown },
  tool: string,
): Promise<
  | { found: false; dbName: string; storeName: string; key: unknown; origin: string }
  | { found: true; dbName: string; storeName: string; key: unknown; value: unknown; origin: string }
> {
  if (!args.dbName) throw new Error(`${tool}: \`dbName\` is required`);
  if (!args.storeName) throw new Error(`${tool}: \`storeName\` is required`);
  if (args.key === undefined || args.key === null) throw new Error(`${tool}: \`key\` is required`);
  idbOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var key = ${JSON.stringify(args.key)}; ` +
    `var db = await new Promise(function (resolve, reject) { ` +
    `  var req = ${IDB_API}.open(${JSON.stringify(args.dbName)}); ` +
    `  req.onsuccess = function () { resolve(req.result); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `  req.onblocked = function () { reject(new Error("${tool}: open blocked")); }; ` +
    `}); ` +
    `if (!db.objectStoreNames.contains(${JSON.stringify(args.storeName)})) { ` +
    `  db.close(); ` +
    `  throw new Error("${tool}: object store \\"" + ${JSON.stringify(args.storeName)} + "\\" does not exist in db \\"" + ${JSON.stringify(args.dbName)} + "\\""); ` +
    `} ` +
    `var tx = db.transaction(${JSON.stringify(args.storeName)}, "readonly"); ` +
    `var store = tx.objectStore(${JSON.stringify(args.storeName)}); ` +
    `var value = await new Promise(function (resolve, reject) { ` +
    `  var req = store.get(key); ` +
    `  req.onsuccess = function () { resolve(req.result); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `}); ` +
    `db.close(); ` +
    `if (value === undefined) return { found: false, dbName: ${JSON.stringify(args.dbName)}, storeName: ${JSON.stringify(args.storeName)}, key: key, origin: location.origin }; ` +
    `var jsonable; ` +
    `try { jsonable = JSON.parse(JSON.stringify(value)); } catch (e) { ` +
    `  throw new Error("${tool}: value at (\\"" + ${JSON.stringify(args.dbName)} + "\\", \\"" + ${JSON.stringify(args.storeName)} + "\\") is not JSON-serialisable (" + (e && e.message || e) + ") — agentic browser surface returns JSON over MCP; the platform value is preserved IN the IDB store but cannot be returned over this transport"); ` +
    `} ` +
    `return { found: true, dbName: ${JSON.stringify(args.dbName)}, storeName: ${JSON.stringify(args.storeName)}, key: key, value: jsonable, origin: location.origin }; })()`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await page.evaluate(expr)) as any;
}

/** Put a value at a key. The object store must already exist — this
 *  function does NOT create stores (store creation requires an upgrade
 *  transaction, which adopters who own the schema should do themselves).
 *
 *  Values are JSON-cloned at the page boundary; non-serialisable inputs
 *  reject at MCP-validation time (Zod tree). */
export async function idbPut(
  page: Page,
  args: { dbName: string; storeName: string; key: unknown; value: unknown },
  tool: string,
): Promise<{ ok: true; dbName: string; storeName: string; key: unknown; origin: string }> {
  if (!args.dbName) throw new Error(`${tool}: \`dbName\` is required`);
  if (!args.storeName) throw new Error(`${tool}: \`storeName\` is required`);
  if (args.key === undefined || args.key === null) throw new Error(`${tool}: \`key\` is required`);
  if (args.value === undefined) throw new Error(`${tool}: \`value\` is required`);
  idbOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var key = ${JSON.stringify(args.key)}; ` +
    `var value = ${JSON.stringify(args.value)}; ` +
    `var db = await new Promise(function (resolve, reject) { ` +
    `  var req = ${IDB_API}.open(${JSON.stringify(args.dbName)}); ` +
    `  req.onsuccess = function () { resolve(req.result); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `  req.onblocked = function () { reject(new Error("${tool}: open blocked")); }; ` +
    `}); ` +
    `if (!db.objectStoreNames.contains(${JSON.stringify(args.storeName)})) { ` +
    `  db.close(); ` +
    `  throw new Error("${tool}: object store \\"" + ${JSON.stringify(args.storeName)} + "\\" does not exist in db \\"" + ${JSON.stringify(args.dbName)} + "\\" — store creation requires an upgrade transaction; create the store from app code first"); ` +
    `} ` +
    `var tx = db.transaction(${JSON.stringify(args.storeName)}, "readwrite"); ` +
    `var store = tx.objectStore(${JSON.stringify(args.storeName)}); ` +
    `await new Promise(function (resolve, reject) { ` +
    `  var req; ` +
    `  if (store.keyPath !== null) { req = store.put(value); } ` +
    `  else { req = store.put(value, key); } ` +
    `  req.onsuccess = function () { resolve(undefined); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `}); ` +
    `await new Promise(function (resolve, reject) { ` +
    `  tx.oncomplete = function () { resolve(undefined); }; ` +
    `  tx.onerror = function () { reject(tx.error); }; ` +
    `  tx.onabort = function () { reject(tx.error || new Error("${tool}: transaction aborted")); }; ` +
    `}); ` +
    `db.close(); ` +
    `return { ok: true, dbName: ${JSON.stringify(args.dbName)}, storeName: ${JSON.stringify(args.storeName)}, key: key, origin: location.origin }; })()`;
  return await page.evaluate(expr);
}

/** Delete the value at a key. Idempotent — returns the same shape
 *  whether or not a record existed. */
export async function idbDelete(
  page: Page,
  args: { dbName: string; storeName: string; key: unknown },
  tool: string,
): Promise<{ ok: true; dbName: string; storeName: string; key: unknown; origin: string }> {
  if (!args.dbName) throw new Error(`${tool}: \`dbName\` is required`);
  if (!args.storeName) throw new Error(`${tool}: \`storeName\` is required`);
  if (args.key === undefined || args.key === null) throw new Error(`${tool}: \`key\` is required`);
  idbOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var key = ${JSON.stringify(args.key)}; ` +
    `var db = await new Promise(function (resolve, reject) { ` +
    `  var req = ${IDB_API}.open(${JSON.stringify(args.dbName)}); ` +
    `  req.onsuccess = function () { resolve(req.result); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `  req.onblocked = function () { reject(new Error("${tool}: open blocked")); }; ` +
    `}); ` +
    `if (!db.objectStoreNames.contains(${JSON.stringify(args.storeName)})) { ` +
    `  db.close(); ` +
    `  throw new Error("${tool}: object store \\"" + ${JSON.stringify(args.storeName)} + "\\" does not exist in db \\"" + ${JSON.stringify(args.dbName)} + "\\""); ` +
    `} ` +
    `var tx = db.transaction(${JSON.stringify(args.storeName)}, "readwrite"); ` +
    `var store = tx.objectStore(${JSON.stringify(args.storeName)}); ` +
    `await new Promise(function (resolve, reject) { ` +
    `  var req = store.delete(key); ` +
    `  req.onsuccess = function () { resolve(undefined); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `}); ` +
    `await new Promise(function (resolve, reject) { ` +
    `  tx.oncomplete = function () { resolve(undefined); }; ` +
    `  tx.onerror = function () { reject(tx.error); }; ` +
    `  tx.onabort = function () { reject(tx.error || new Error("${tool}: transaction aborted")); }; ` +
    `}); ` +
    `db.close(); ` +
    `return { ok: true, dbName: ${JSON.stringify(args.dbName)}, storeName: ${JSON.stringify(args.storeName)}, key: key, origin: location.origin }; })()`;
  return await page.evaluate(expr);
}

/** Clear every record from an object store (the store itself remains). */
export async function idbClear(
  page: Page,
  args: { dbName: string; storeName: string },
  tool: string,
): Promise<{ ok: true; dbName: string; storeName: string; origin: string }> {
  if (!args.dbName) throw new Error(`${tool}: \`dbName\` is required`);
  if (!args.storeName) throw new Error(`${tool}: \`storeName\` is required`);
  idbOriginGuard(page, tool);
  const expr =
    `(async () => { ` +
    `var db = await new Promise(function (resolve, reject) { ` +
    `  var req = ${IDB_API}.open(${JSON.stringify(args.dbName)}); ` +
    `  req.onsuccess = function () { resolve(req.result); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `  req.onblocked = function () { reject(new Error("${tool}: open blocked")); }; ` +
    `}); ` +
    `if (!db.objectStoreNames.contains(${JSON.stringify(args.storeName)})) { ` +
    `  db.close(); ` +
    `  throw new Error("${tool}: object store \\"" + ${JSON.stringify(args.storeName)} + "\\" does not exist in db \\"" + ${JSON.stringify(args.dbName)} + "\\""); ` +
    `} ` +
    `var tx = db.transaction(${JSON.stringify(args.storeName)}, "readwrite"); ` +
    `var store = tx.objectStore(${JSON.stringify(args.storeName)}); ` +
    `await new Promise(function (resolve, reject) { ` +
    `  var req = store.clear(); ` +
    `  req.onsuccess = function () { resolve(undefined); }; ` +
    `  req.onerror = function () { reject(req.error); }; ` +
    `}); ` +
    `await new Promise(function (resolve, reject) { ` +
    `  tx.oncomplete = function () { resolve(undefined); }; ` +
    `  tx.onerror = function () { reject(tx.error); }; ` +
    `  tx.onabort = function () { reject(tx.error || new Error("${tool}: transaction aborted")); }; ` +
    `}); ` +
    `db.close(); ` +
    `return { ok: true, dbName: ${JSON.stringify(args.dbName)}, storeName: ${JSON.stringify(args.storeName)}, origin: location.origin }; })()`;
  return await page.evaluate(expr);
}
