// Unit tests for Cache API CRUD — sibling of storage.test.ts.
//
// Strategy: fake Page whose `evaluate()` runs the expression strings inside
// a `Function` constructor against an in-memory cache + a minimal `caches`
// stub + a minimal `Response` ctor. Avoids launching Chromium for the unit
// pass — the headless keystone covers the real-API path separately.

import { describe, it, expect } from "vitest";
import {
  cachesListStorages,
  cachesList,
  cachesGet,
  cachesPut,
  cachesDelete,
  cachesClear,
  cachesDeleteStorage,
} from "./cache-storage.js";

// ---- in-page stub --------------------------------------------------------

interface StubEntry {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

function buildCachesStub() {
  // origin -> cacheName -> url -> entry
  const store = new Map<string, Map<string, StubEntry>>();

  function makeResponse(entry: StubEntry): Record<string, unknown> {
    const headers = {
      get: (k: string) => entry.headers[k.toLowerCase()] ?? null,
      forEach: (cb: (v: string, k: string) => void) => {
        for (const [k, v] of Object.entries(entry.headers)) cb(v, k);
      },
    };
    return {
      status: entry.status,
      headers,
      async text() {
        return Buffer.from(entry.body).toString("utf-8");
      },
      async arrayBuffer() {
        const ab = new ArrayBuffer(entry.body.length);
        new Uint8Array(ab).set(entry.body);
        return ab;
      },
    };
  }

  function getCache(name: string): Map<string, StubEntry> {
    let c = store.get(name);
    if (!c) {
      c = new Map();
      store.set(name, c);
    }
    return c;
  }

  return {
    store,
    api: {
      async keys() {
        return [...store.keys()];
      },
      async open(name: string) {
        const cache = getCache(name);
        return {
          async keys() {
            return [...cache.keys()].map((u) => ({ url: u, method: "GET" }));
          },
          async match(url: string | { url: string }) {
            const k = typeof url === "string" ? url : url.url;
            const e = cache.get(k);
            return e ? makeResponse(e) : undefined;
          },
          async put(url: string | { url: string }, res: { _spec: StubEntry }) {
            const k = typeof url === "string" ? url : url.url;
            cache.set(k, res._spec);
          },
          async delete(url: string | { url: string }) {
            const k = typeof url === "string" ? url : url.url;
            return cache.delete(k);
          },
        };
      },
      async delete(name: string) {
        return store.delete(name);
      },
    },
  };
}

interface FakePageHandle {
  page: { url: () => string; evaluate: (expr: string) => Promise<unknown> };
  setUrl: (u: string) => void;
  stub: ReturnType<typeof buildCachesStub>;
}

function fakePage(initialUrl: string): FakePageHandle {
  let url = initialUrl;
  const stub = buildCachesStub();

  // The helpers build async-IIFE expressions like `(async () => { ... })()`
  // referencing `caches`, `btoa`, `atob`, `Response`, and `location`. We
  // evaluate them in a Function scope with those bindings supplied.
  async function evaluate(expr: string): Promise<unknown> {
    const location = { origin: (() => { try { return new URL(url).origin; } catch { return "null"; } })() };

    function Response(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      let bytes: Uint8Array;
      if (typeof body === "string") bytes = new TextEncoder().encode(body);
      else if (body instanceof Uint8Array) bytes = body;
      else bytes = new Uint8Array(0);
      const headers = init?.headers ?? {};
      // Lower-case header keys (mirror real Headers semantics).
      const lc: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
      return { _spec: { status: init?.status ?? 200, headers: lc, body: bytes } };
    }

    function btoa(bin: string): string {
      return Buffer.from(bin, "binary").toString("base64");
    }
    function atob(b64: string): string {
      return Buffer.from(b64, "base64").toString("binary");
    }

    const fn = new Function(
      "caches", "Response", "btoa", "atob", "location",
      `return ${expr}`,
    );
    return await fn(stub.api, Response, btoa, atob, location);
  }

  return {
    page: { url: () => url, evaluate },
    setUrl: (u: string) => { url = u; },
    stub,
  };
}

// ---- tests ---------------------------------------------------------------

describe("Cache API CRUD", () => {
  describe("origin guard", () => {
    it("rejects when navigated to about:blank", async () => {
      const { page } = fakePage("about:blank");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(cachesListStorages(page as any, "caches_list_storages"))
        .rejects.toThrow(/Navigate the session/);
    });
    it("rejects when url is unknown", async () => {
      const { page } = fakePage("");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(cachesList(page as any, { cacheName: "x" }, "caches_list"))
        .rejects.toThrow(/Navigate the session/);
    });
  });

  describe("cachesListStorages", () => {
    it("lists every cache name visible to the origin", async () => {
      const { page, stub } = fakePage("https://example.com/");
      stub.api.open("v1");
      stub.api.open("v2");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await cachesListStorages(page as any, "caches_list_storages");
      expect(r.names.sort()).toEqual(["v1", "v2"]);
      expect(r.origin).toBe("https://example.com");
    });
  });

  describe("cachesPut + cachesGet", () => {
    it("round-trips a text body with default 200 status", async () => {
      const { page } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, {
        cacheName: "v1",
        url: "https://example.com/a.json",
        response: { body: '{"k":1}', headers: { "Content-Type": "application/json" } },
      }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const got = await cachesGet(page as any, {
        cacheName: "v1", url: "https://example.com/a.json",
      }, "caches_get");
      expect(got.found).toBe(true);
      if (got.found && got.kind === "text") {
        expect(got.text).toBe('{"k":1}');
        expect(got.status).toBe(200);
        expect(got.contentType).toBe("application/json");
      } else {
        throw new Error("expected text body");
      }
    });

    it("round-trips a binary body as base64 + byteLength", async () => {
      const { page } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, {
        cacheName: "v1",
        url: "https://example.com/img.png",
        response: {
          contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
          headers: { "Content-Type": "image/png" },
          status: 201,
        },
      }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const got = await cachesGet(page as any, {
        cacheName: "v1", url: "https://example.com/img.png",
      }, "caches_get");
      expect(got.found).toBe(true);
      if (got.found && got.kind === "binary") {
        expect(got.byteLength).toBe(4);
        expect(Buffer.from(got.contentBase64, "base64").toString("hex")).toBe("89504e47");
        expect(got.status).toBe(201);
      } else {
        throw new Error("expected binary body");
      }
    });

    it("returns found:false for a missing entry", async () => {
      const { page } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const got = await cachesGet(page as any, {
        cacheName: "v1", url: "https://example.com/missing",
      }, "caches_get");
      expect(got.found).toBe(false);
    });

    it("rejects body + contentBase64 together", async () => {
      const { page } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(cachesPut(page as any, {
        cacheName: "v1",
        url: "https://example.com/x",
        response: { body: "a", contentBase64: "YQ==" },
      }, "caches_put")).rejects.toThrow(/exactly one of/);
    });
  });

  describe("cachesList", () => {
    it("returns all entries with no pattern", async () => {
      const { page } = fakePage("https://example.com/");
      const u = (p: string) => `https://example.com/${p}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, { cacheName: "v1", url: u("a"), response: { body: "1" } }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, { cacheName: "v1", url: u("b"), response: { body: "2" } }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await cachesList(page as any, { cacheName: "v1" }, "caches_list");
      expect(r.entries).toHaveLength(2);
      expect(r.entries.map((e) => e.url).sort()).toEqual([u("a"), u("b")]);
    });
    it("filters by url substring", async () => {
      const { page } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, { cacheName: "v1", url: "https://example.com/api/a", response: { body: "1" } }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, { cacheName: "v1", url: "https://example.com/static/b", response: { body: "2" } }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await cachesList(page as any, { cacheName: "v1", urlPattern: "/api/" }, "caches_list");
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]!.url).toContain("/api/");
    });
  });

  describe("cachesDelete + cachesClear + cachesDeleteStorage", () => {
    it("delete reports existed:true on hit, false on miss", async () => {
      const { page } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, { cacheName: "v1", url: "u", response: { body: "x" } }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const first = await cachesDelete(page as any, { cacheName: "v1", url: "u" }, "caches_delete");
      expect(first.existed).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const second = await cachesDelete(page as any, { cacheName: "v1", url: "u" }, "caches_delete");
      expect(second.existed).toBe(false);
    });
    it("clear wipes all entries but keeps the cache storage", async () => {
      const { page, stub } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, { cacheName: "v1", url: "u1", response: { body: "1" } }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await cachesPut(page as any, { cacheName: "v1", url: "u2", response: { body: "2" } }, "caches_put");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await cachesClear(page as any, { cacheName: "v1" }, "caches_clear");
      expect(r.cleared).toBe(2);
      expect(stub.store.has("v1")).toBe(true);
      expect(stub.store.get("v1")!.size).toBe(0);
    });
    it("delete_storage drops the whole cache; idempotent", async () => {
      const { page, stub } = fakePage("https://example.com/");
      stub.api.open("v1");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const first = await cachesDeleteStorage(page as any, { cacheName: "v1" }, "caches_delete_storage");
      expect(first.existed).toBe(true);
      expect(stub.store.has("v1")).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const second = await cachesDeleteStorage(page as any, { cacheName: "v1" }, "caches_delete_storage");
      expect(second.existed).toBe(false);
    });
  });

  describe("input validation", () => {
    it("rejects missing cacheName", async () => {
      const { page } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(cachesList(page as any, { cacheName: "" }, "caches_list"))
        .rejects.toThrow(/cacheName/);
    });
    it("rejects missing url on get", async () => {
      const { page } = fakePage("https://example.com/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(cachesGet(page as any, { cacheName: "v1", url: "" }, "caches_get"))
        .rejects.toThrow(/url/);
    });
  });
});
