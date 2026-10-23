// Unit tests for Cache API CRUD — sibling of storage.test.ts.
//
// Strategy: fake Page whose `evaluate()` runs the expression strings inside
// a `Function` constructor against an in-memory cache + a minimal `caches`
// stub + a minimal `Response` ctor. Avoids launching Chromium for the unit
// pass — the headless keystone covers the real-API path separately.

import { describe, it, expect } from "vitest";
import { cachesList, cachesGet, cachesPut } from "./cache-storage.js";

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
    const location = {
      origin: (() => {
        try {
          return new URL(url).origin;
        } catch {
          return "null";
        }
      })(),
    };

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

    // Test scaffolding: page.evaluate() in production sends a string of source to
    // the page context; here we mirror that by compiling it with the bindings the
    // helper expressions reference. Genuine eval-shaped behaviour by design.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("caches", "Response", "btoa", "atob", "location", `return ${expr}`);
    return await fn(stub.api, Response, btoa, atob, location);
  }

  return {
    page: { url: () => url, evaluate },
    setUrl: (u: string) => {
      url = u;
    },
    stub,
  };
}

// ---- tests ---------------------------------------------------------------

describe("Cache API CRUD", () => {
  describe("cachesPut + cachesGet", () => {
    it("returns found:false for a missing entry", async () => {
      const { page } = fakePage("https://example.com/");

      const got = await cachesGet(
        page as any,
        {
          cacheName: "v1",
          url: "https://example.com/missing",
        },
        "caches_get",
      );
      expect(got.found).toBe(false);
    });

    it("rejects body + contentBase64 together", async () => {
      const { page } = fakePage("https://example.com/");

      await expect(
        cachesPut(
          page as any,
          {
            cacheName: "v1",
            url: "https://example.com/x",
            response: { body: "a", contentBase64: "YQ==" },
          },
          "caches_put",
        ),
      ).rejects.toThrow(/exactly one of/);
    });
  });

  describe("input validation", () => {
    it("rejects missing cacheName", async () => {
      const { page } = fakePage("https://example.com/");

      await expect(cachesList(page as any, { cacheName: "" }, "caches_list")).rejects.toThrow(
        /cacheName/,
      );
    });
    it("rejects missing url on get", async () => {
      const { page } = fakePage("https://example.com/");

      await expect(
        cachesGet(page as any, { cacheName: "v1", url: "" }, "caches_get"),
      ).rejects.toThrow(/url/);
    });
  });
});
