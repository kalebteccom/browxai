// Unit tests for IndexedDB CRUD — sibling of storage.test.ts.
//
// Strategy: fake Page whose `evaluate()` runs the helper expressions inside
// a `Function` constructor against an in-memory IDB stub that mimics the
// W3C surface (open() resolves to a db object; transaction()/objectStore()
// /get()/put()/delete()/clear() use the request callback shape).

import { describe, it, expect } from "vitest";
import {
  idbListDatabases,
  idbListStores,
  idbGet,
  idbPut,
  idbDelete,
  idbClear,
} from "./idb-storage.js";

// ---- in-page IDB stub ----------------------------------------------------

interface StubStore {
  keyPath: string | null;
  records: Map<string, unknown>; // key serialised via JSON.stringify
}

interface StubDb {
  name: string;
  version: number;
  objectStoreNames: { contains: (n: string) => boolean; [Symbol.iterator]: () => Iterator<string> };
  storeNames: string[];
  stores: Map<string, StubStore>;
  close: () => void;
}

function makeIdbStub() {
  const dbs = new Map<string, StubDb>();

  function getOrCreate(name: string, configure?: (db: StubDb) => void): StubDb {
    let db = dbs.get(name);
    if (!db) {
      const stores = new Map<string, StubStore>();
      const storeNames: string[] = [];
      db = {
        name,
        version: 1,
        stores,
        storeNames,
        objectStoreNames: Object.assign(storeNames, {
          contains: (n: string) => stores.has(n),
        }) as never as StubDb["objectStoreNames"],
        close: () => undefined,
      };
      dbs.set(name, db);
      configure?.(db);
    }
    return db;
  }

  /** Mint a request whose `onsuccess` fires on the next microtask. */
  function syncRequest<T>(value: T) {
    const req = {
      result: value,
      error: null as unknown,
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
    };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }

  function errorRequest(err: Error) {
    const req = {
      result: undefined,
      error: err,
      onsuccess: null as null | (() => void),
      onerror: null as null | (() => void),
    };
    queueMicrotask(() => req.onerror?.());
    return req;
  }

  function makeTransaction(db: StubDb, storeName: string) {
    const store = db.stores.get(storeName)!;
    // The helper expression pattern is:
    //   var tx = db.transaction(...); var store = tx.objectStore(...);
    //   await new Promise(r => { var req = store.put(...); req.onsuccess = r; });
    //   await new Promise(r => { tx.oncomplete = r; });
    // i.e. operations finish BEFORE tx.oncomplete is attached. So we track
    // a "settled" flag set true once all queued ops have run, and fire
    // oncomplete as soon as both `settled === true` AND a handler is set.
    let opsPending = 0;
    let opsStarted = false;
    let completed = false;
    const tx = {
      error: null as unknown,
      _onc: null as null | (() => void),
      get oncomplete() {
        return this._onc;
      },
      set oncomplete(fn) {
        this._onc = fn;
        if (completed) queueMicrotask(() => fn?.());
      },
      onerror: null as null | (() => void),
      onabort: null as null | (() => void),
      _maybeSettle() {
        if (opsStarted && opsPending === 0) {
          completed = true;
          if (this._onc) queueMicrotask(() => this._onc?.());
        }
      },
      objectStore(_n: string) {
        return {
          keyPath: store.keyPath,
          get: (key: unknown) => {
            const k = JSON.stringify(key);
            const v = store.records.get(k);
            return syncRequest(v);
          },
          put: (value: unknown, key?: unknown) => {
            opsStarted = true;
            opsPending++;
            let k: string;
            if (store.keyPath && typeof value === "object" && value !== null) {
              k = JSON.stringify((value as Record<string, unknown>)[store.keyPath]);
            } else {
              k = JSON.stringify(key);
            }
            store.records.set(k, value);
            const req = syncRequest(undefined);
            const origSuccessSetter = Object.getOwnPropertyDescriptor(req, "onsuccess")?.set;
            void origSuccessSetter;
            // Wrap onsuccess so we can decrement the counter AFTER the
            // helper's promise resolver runs.
            let userSuccess: null | (() => void) = null;
            Object.defineProperty(req, "onsuccess", {
              get: () => userSuccess,
              set: (fn) => {
                userSuccess = fn;
              },
            });
            queueMicrotask(() => {
              userSuccess?.();
              opsPending--;
              tx._maybeSettle();
            });
            return req;
          },
          delete: (key: unknown) => {
            opsStarted = true;
            opsPending++;
            const k = JSON.stringify(key);
            store.records.delete(k);
            const req = {
              result: undefined as unknown,
              error: null as unknown,
              onsuccess: null as null | (() => void),
              onerror: null as null | (() => void),
            };
            queueMicrotask(() => {
              req.onsuccess?.();
              opsPending--;
              tx._maybeSettle();
            });
            return req;
          },
          clear: () => {
            opsStarted = true;
            opsPending++;
            store.records.clear();
            const req = {
              result: undefined as unknown,
              error: null as unknown,
              onsuccess: null as null | (() => void),
              onerror: null as null | (() => void),
            };
            queueMicrotask(() => {
              req.onsuccess?.();
              opsPending--;
              tx._maybeSettle();
            });
            return req;
          },
        };
      },
    };
    return tx;
  }

  const api = {
    async databases() {
      return [...dbs.values()].map((d) => ({ name: d.name, version: d.version }));
    },
    open(name: string) {
      const db = getOrCreate(name);
      return syncRequest(db);
    },
    // helper to seed
    _ensure(name: string, storeName: string, keyPath: string | null = null) {
      const db = getOrCreate(name);
      if (!db.stores.has(storeName)) {
        db.stores.set(storeName, { keyPath, records: new Map() });
        db.storeNames.push(storeName);
      }
      return db;
    },
    _makeTransaction: makeTransaction,
    _dbs: dbs,
  };
  return api;
}

interface FakePageHandle {
  page: { url: () => string; evaluate: (expr: string) => Promise<unknown> };
  idb: ReturnType<typeof makeIdbStub>;
}

function fakePage(initialUrl: string): FakePageHandle {
  const idb = makeIdbStub();

  async function evaluate(expr: string): Promise<unknown> {
    const location = {
      origin: (() => {
        try {
          return new URL(initialUrl).origin;
        } catch {
          return "null";
        }
      })(),
    };

    // Inject `db.transaction(name, mode)` on each opened db once needed.
    const indexedDB = {
      databases: () => idb.databases(),
      open: (name: string) => {
        const req = idb.open(name);
        // attach `.transaction` to the resolved db lazily
        const db = req.result as StubDb;
        Object.assign(db, {
          transaction: (storeName: string, _mode: string) => idb._makeTransaction(db, storeName),
        });
        return req;
      },
    };

    const fn = new Function("indexedDB", "location", `return ${expr}`);
    return await fn(indexedDB, location);
  }

  return { page: { url: () => initialUrl, evaluate }, idb };
}

// ---- tests ---------------------------------------------------------------

describe("IndexedDB CRUD", () => {
  describe("origin guard", () => {
    it("rejects when on about:blank", async () => {
      const { page } = fakePage("about:blank");

      await expect(idbListDatabases(page as any, "idb_list_databases")).rejects.toThrow(
        /Navigate the session/,
      );
    });
  });

  describe("idbListDatabases", () => {
    it("returns the databases known to the origin", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("appA", "kv");
      idb._ensure("appB", "kv");

      const r = await idbListDatabases(page as any, "idb_list_databases");
      expect(r.supported).toBe(true);
      expect(r.databases.map((d) => d.name).sort()).toEqual(["appA", "appB"]);
      expect(r.origin).toBe("https://example.com");
    });
  });

  describe("idbListStores", () => {
    it("lists the stores in a database", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("app", "kv");
      idb._ensure("app", "logs");

      const r = await idbListStores(page as any, { dbName: "app" }, "idb_list_stores");
      expect(r.stores.sort()).toEqual(["kv", "logs"]);
      expect(r.dbName).toBe("app");
    });
    it("rejects missing dbName", async () => {
      const { page } = fakePage("https://example.com/");

      await expect(idbListStores(page as any, { dbName: "" }, "idb_list_stores")).rejects.toThrow(
        /dbName/,
      );
    });
  });

  describe("idbGet + idbPut + idbDelete + idbClear", () => {
    it("put + get round-trips a string key + json value (out-of-line keyPath)", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("app", "kv", null);

      const putR = await idbPut(
        page as any,
        {
          dbName: "app",
          storeName: "kv",
          key: "u1",
          value: { name: "Ada" },
        },
        "idb_put",
      );
      expect(putR.ok).toBe(true);

      const getR = await idbGet(
        page as any,
        {
          dbName: "app",
          storeName: "kv",
          key: "u1",
        },
        "idb_get",
      );
      expect(getR.found).toBe(true);
      if (getR.found) expect(getR.value).toEqual({ name: "Ada" });
    });
    it("put + get round-trips a numeric key", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("app", "kv", null);

      await idbPut(page as any, { dbName: "app", storeName: "kv", key: 42, value: "x" }, "idb_put");

      const r = await idbGet(page as any, { dbName: "app", storeName: "kv", key: 42 }, "idb_get");
      expect(r.found).toBe(true);
      if (r.found) expect(r.value).toBe("x");
    });
    it("get returns found:false for missing key", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("app", "kv", null);

      const r = await idbGet(
        page as any,
        { dbName: "app", storeName: "kv", key: "ghost" },
        "idb_get",
      );
      expect(r.found).toBe(false);
    });
    it("delete then get returns found:false (idempotent)", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("app", "kv", null);

      await idbPut(page as any, { dbName: "app", storeName: "kv", key: "a", value: 1 }, "idb_put");

      await idbDelete(page as any, { dbName: "app", storeName: "kv", key: "a" }, "idb_delete");

      const r = await idbGet(page as any, { dbName: "app", storeName: "kv", key: "a" }, "idb_get");
      expect(r.found).toBe(false);
    });
    it("clear empties the store", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("app", "kv", null);

      await idbPut(page as any, { dbName: "app", storeName: "kv", key: "a", value: 1 }, "idb_put");

      await idbPut(page as any, { dbName: "app", storeName: "kv", key: "b", value: 2 }, "idb_put");

      const r = await idbClear(page as any, { dbName: "app", storeName: "kv" }, "idb_clear");
      expect(r.ok).toBe(true);
      const store = idb._dbs.get("app")!.stores.get("kv")!;
      expect(store.records.size).toBe(0);
    });
    it("put against a missing store rejects with the schema hint", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("app", "kv", null);

      await expect(
        idbPut(
          page as any,
          {
            dbName: "app",
            storeName: "missing",
            key: "k",
            value: 1,
          },
          "idb_put",
        ),
      ).rejects.toThrow(/does not exist|upgrade transaction/);
    });
    it("get against a missing store rejects clearly", async () => {
      const { page, idb } = fakePage("https://example.com/");
      idb._ensure("app", "kv", null);

      await expect(
        idbGet(
          page as any,
          {
            dbName: "app",
            storeName: "missing",
            key: "k",
          },
          "idb_get",
        ),
      ).rejects.toThrow(/does not exist/);
    });
  });

  describe("input validation", () => {
    it("rejects missing key shapes", async () => {
      const { page } = fakePage("https://example.com/");

      await expect(
        idbGet(page as any, { dbName: "a", storeName: "s", key: null as never }, "idb_get"),
      ).rejects.toThrow(/key/);

      await expect(
        idbPut(
          page as any,
          { dbName: "a", storeName: "s", key: "k", value: undefined as never },
          "idb_put",
        ),
      ).rejects.toThrow(/value/);
    });
  });
});
