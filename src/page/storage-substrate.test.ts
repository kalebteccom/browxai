import { describe, it, expect } from "vitest";
import {
  PlaywrightStorageSubstrate,
  SafariStorageSubstrate,
  type StorageSubstrate,
} from "./storage-substrate.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { BrowserContext, Page } from "playwright-core";

// The StorageSubstrate port routing/gating. The Playwright impl delegates to the
// existing `cookiesList` / `cookiesSet` / `webStorage*` / `idb*` / `caches*` helpers
// (cookies over a BrowserContext, web-storage + IndexedDB + Cache API over a Page —
// all covered by the per-engine keystones); these cover the Safari adapter's
// WebDriver cookie path, the in-adapter domain derivation, the WebDriver
// `execute/sync` web-storage path that replaced the per-handler
// `if (e.session.safari?.())` branches, and the in-adapter IndexedDB + Cache API
// refusals (both async APIs have no synchronous WebDriver path) (RFC 0003).

function safariHandle(opts?: { url?: string; scriptResult?: unknown }): {
  handle: SafariSessionHandle;
  added: Array<Record<string, unknown>>;
  scripts: string[];
} {
  const added: Array<Record<string, unknown>> = [];
  const scripts: string[] = [];
  const handle = {
    sessionId: "S",
    webDriver: {
      getCookies: async (sessionId: string) => {
        expect(sessionId).toBe("S");
        return [{ name: "sid", value: "abc", domain: "example.com" }];
      },
      addCookie: async (sessionId: string, cookie: Record<string, unknown>) => {
        expect(sessionId).toBe("S");
        added.push(cookie);
      },
      currentUrl: async (sessionId: string) => {
        expect(sessionId).toBe("S");
        return opts?.url ?? "https://example.com/";
      },
      executeScript: async (sessionId: string, script: string) => {
        expect(sessionId).toBe("S");
        scripts.push(script);
        return opts?.scriptResult;
      },
    },
  } as unknown as SafariSessionHandle;
  return { handle, added, scripts };
}

describe("SafariStorageSubstrate", () => {
  it("tags the safari engine", () => {
    const { handle } = safariHandle();
    expect(new SafariStorageSubstrate(handle).engine).toBe("safari");
  });

  it("reads the cookie jar from the WebDriver client (urls filter is inert)", async () => {
    const { handle } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    // `urls` is honoured by Playwright but not by WebDriver — the Safari adapter
    // ignores it and returns the current document's jar, as the pre-seam branch did.
    const jar = await sub.cookiesList({ urls: ["https://other.test/"] });
    expect(jar).toEqual([{ name: "sid", value: "abc", domain: "example.com" }]);
  });

  it("derives the cookie domain from `url` on set (WebDriver scopes to a domain)", async () => {
    const { handle, added } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    const r = await sub.cookiesSet({ name: "k", value: "v", url: "https://shop.example.com/cart" });
    expect(r).toEqual({ ok: true, name: "k" });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: "k",
      value: "v",
      domain: "shop.example.com",
      path: "/",
    });
  });

  it("prefers an explicit `domain` over the url-derived one and maps expires→expiry", async () => {
    const { handle, added } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    await sub.cookiesSet({
      name: "k",
      value: "v",
      url: "https://shop.example.com/",
      domain: "example.com",
      path: "/app",
      expires: 1_700_000_000.7,
      secure: true,
      sameSite: "Lax",
    });
    expect(added[0]).toMatchObject({
      domain: "example.com",
      path: "/app",
      expiry: 1_700_000_000,
      secure: true,
      sameSite: "Lax",
    });
  });

  it("omits the domain when neither `domain` nor a valid `url` is given", async () => {
    const { handle, added } = safariHandle();
    const sub: StorageSubstrate = new SafariStorageSubstrate(handle);
    await sub.cookiesSet({ name: "k", value: "v", url: "::not a url::" });
    expect(added).toHaveLength(1);
    const cookie = added[0]!;
    expect(cookie.domain).toBeUndefined();
    expect(cookie.path).toBe("/");
  });

  it("reads web-storage via execute/sync, wrapping the IIFE in `return (…)`", async () => {
    const { handle, scripts } = safariHandle({
      scriptResult: { value: "v", origin: "https://example.com" },
    });
    const sub = new SafariStorageSubstrate(handle);
    const r = await sub.webStorageGet("localStorage", { key: "k" }, "localstorage_get");
    expect(r).toEqual({ value: "v", origin: "https://example.com" });
    // The page-side body is the same IIFE the Playwright helper evaluates, named on
    // the requested storage object and wrapped in `return (…)` for execute/sync.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("window.localStorage");
    expect(scripts[0]).toContain(`getItem("k")`);
    expect(scripts[0]!.startsWith("return (")).toBe(true);
  });

  it("names sessionStorage on the storage object for the session-scoped kind", async () => {
    const { handle, scripts } = safariHandle({ scriptResult: { entries: [], origin: "" } });
    const sub = new SafariStorageSubstrate(handle);
    await sub.webStorageList("sessionStorage", "sessionstorage_list");
    expect(scripts[0]).toContain("window.sessionStorage");
  });

  it("sets web-storage and JSON-encodes the key + value into the script", async () => {
    const { handle, scripts } = safariHandle({ scriptResult: { ok: true, origin: "o" } });
    const sub = new SafariStorageSubstrate(handle);
    const r = await sub.webStorageSet(
      "localStorage",
      { key: "k", value: 'a"b' },
      "localstorage_set",
    );
    expect(r).toEqual({ ok: true, origin: "o" });
    // The value is JSON-encoded so a quote in the value can't break out of the call.
    expect(scripts[0]).toContain(`setItem("k", "a\\"b")`);
  });

  it("deletes and clears web-storage via execute/sync", async () => {
    const { handle, scripts } = safariHandle({ scriptResult: { ok: true, origin: "o" } });
    const sub = new SafariStorageSubstrate(handle);
    await sub.webStorageDelete("localStorage", { key: "k" }, "localstorage_delete");
    await sub.webStorageClear("localStorage", "localstorage_clear");
    expect(scripts[0]).toContain(`removeItem("k")`);
    expect(scripts[1]).toContain("s.clear()");
  });

  it("rejects a blank web-storage key WITHOUT touching the page (matches the helper)", async () => {
    const { handle, scripts } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    await expect(
      sub.webStorageGet("localStorage", { key: "" }, "localstorage_get"),
    ).rejects.toThrow(/`key` is required/);
    await expect(
      sub.webStorageSet("localStorage", { key: "", value: "v" }, "localstorage_set"),
    ).rejects.toThrow(/`key` is required/);
    expect(scripts).toEqual([]);
  });

  it("rejects a non-string web-storage value", async () => {
    const { handle } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    await expect(
      sub.webStorageSet("localStorage", { key: "k", value: 42 as unknown as string }, "x"),
    ).rejects.toThrow(/`value` \(string\) is required/);
  });

  it("refuses web-storage on about:blank with the same navigation hint as the helper", async () => {
    const { handle, scripts } = safariHandle({ url: "about:blank" });
    const sub = new SafariStorageSubstrate(handle);
    await expect(sub.webStorageList("localStorage", "localstorage_list")).rejects.toThrow(
      /origin-scoped[\s\S]*Navigate the session to the target origin/,
    );
    // The guard short-circuits before any execute/sync — no page-side write attempt.
    expect(scripts).toEqual([]);
  });

  it("treats an unreachable currentUrl as the (unknown) navigation refusal", async () => {
    const { handle } = safariHandle();
    // Make currentUrl throw — the guard catches it and reframes as the nav refusal.
    (handle.webDriver as unknown as { currentUrl: () => Promise<string> }).currentUrl = () => {
      throw new Error("session gone");
    };
    const sub = new SafariStorageSubstrate(handle);
    await expect(sub.webStorageClear("localStorage", "localstorage_clear")).rejects.toThrow(
      /origin-scoped and the page is at "\(unknown\)"/,
    );
  });

  it("refuses every idb method cleanly WITHOUT touching the page (async API, sync driver)", async () => {
    // IndexedDB's promise-based API needs an async page-script path that
    // safaridriver's synchronous execute/sync cannot provide, so each idb method
    // refuses in the adapter rather than running a script whose result is a pending
    // promise. The refusal names the tool + points at a Playwright engine, and no
    // cookie/execute/sync call is attempted.
    const { handle, scripts, added } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    await expect(sub.idbListDatabases("idb_list_databases")).rejects.toThrow(
      /`idb_list_databases`: IndexedDB is not available on the Safari engine[\s\S]*chromium, firefox, or webkit/,
    );
    await expect(sub.idbListStores({ dbName: "d" }, "idb_list_stores")).rejects.toThrow(
      /`idb_list_stores`: IndexedDB is not available on the Safari engine/,
    );
    await expect(sub.idbGet({ dbName: "d", storeName: "s", key: "k" }, "idb_get")).rejects.toThrow(
      /IndexedDB is not available on the Safari engine/,
    );
    await expect(
      sub.idbPut({ dbName: "d", storeName: "s", key: "k", value: 1 }, "idb_put"),
    ).rejects.toThrow(/IndexedDB is not available on the Safari engine/);
    await expect(
      sub.idbDelete({ dbName: "d", storeName: "s", key: "k" }, "idb_delete"),
    ).rejects.toThrow(/IndexedDB is not available on the Safari engine/);
    await expect(sub.idbClear({ dbName: "d", storeName: "s" }, "idb_clear")).rejects.toThrow(
      /IndexedDB is not available on the Safari engine/,
    );
    expect(scripts).toEqual([]);
    expect(added).toEqual([]);
  });

  it("refuses every caches method cleanly WITHOUT touching the page (async API, sync driver)", async () => {
    // The Cache API is promise-based exactly like IndexedDB, so its page-side script
    // is an async IIFE safaridriver's synchronous execute/sync cannot await; each
    // caches method refuses in the adapter rather than running a script whose result
    // is a pending promise. The refusal names the tool + points at a Playwright
    // engine, and no execute/sync call is attempted.
    const { handle, scripts, added } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    await expect(sub.cachesListStorages("caches_list_storages")).rejects.toThrow(
      /`caches_list_storages`: the Cache API is not available on the Safari engine[\s\S]*chromium, firefox, or webkit/,
    );
    await expect(sub.cachesList({ cacheName: "c" }, "caches_list")).rejects.toThrow(
      /`caches_list`: the Cache API is not available on the Safari engine/,
    );
    await expect(sub.cachesGet({ cacheName: "c", url: "u" }, "caches_get")).rejects.toThrow(
      /the Cache API is not available on the Safari engine/,
    );
    await expect(
      sub.cachesPut({ cacheName: "c", url: "u", response: { body: "b" } }, "caches_put"),
    ).rejects.toThrow(/the Cache API is not available on the Safari engine/);
    await expect(sub.cachesDelete({ cacheName: "c", url: "u" }, "caches_delete")).rejects.toThrow(
      /the Cache API is not available on the Safari engine/,
    );
    await expect(sub.cachesClear({ cacheName: "c" }, "caches_clear")).rejects.toThrow(
      /the Cache API is not available on the Safari engine/,
    );
    await expect(
      sub.cachesDeleteStorage({ cacheName: "c" }, "caches_delete_storage"),
    ).rejects.toThrow(/the Cache API is not available on the Safari engine/);
    expect(scripts).toEqual([]);
    expect(added).toEqual([]);
  });
});

describe("PlaywrightStorageSubstrate", () => {
  function ctxStub(opts?: { url?: string; evalResult?: unknown }): {
    context: () => BrowserContext;
    page: () => Page;
    added: Array<Record<string, unknown>>;
    listedUrls: Array<string[] | undefined>;
    evaluated: string[];
  } {
    const added: Array<Record<string, unknown>> = [];
    const listedUrls: Array<string[] | undefined> = [];
    const evaluated: string[] = [];
    const context = (() => ({
      cookies: async (urls?: string[]) => {
        listedUrls.push(urls);
        return [{ name: "sid", value: "abc", domain: "example.com", path: "/" }];
      },
      addCookies: async (cookies: Array<Record<string, unknown>>) => {
        added.push(...cookies);
      },
    })) as unknown as () => BrowserContext;
    const page = (() => ({
      url: () => opts?.url ?? "https://example.com/",
      evaluate: async (expr: string) => {
        evaluated.push(expr);
        return opts?.evalResult;
      },
    })) as unknown as () => Page;
    return { context, page, added, listedUrls, evaluated };
  }

  it("tags the engine it was built for", () => {
    const { context, page } = ctxStub();
    expect(new PlaywrightStorageSubstrate(context, page, "firefox").engine).toBe("firefox");
  });

  it("passes the `urls` filter through to the BrowserContext (native cross-domain filter)", async () => {
    const { context, page, listedUrls } = ctxStub();
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    const jar = await sub.cookiesList({ urls: ["https://example.com/"] });
    expect(jar).toHaveLength(1);
    expect(listedUrls).toEqual([["https://example.com/"]]);
  });

  it("lists the whole jar (urls undefined) when no filter is given", async () => {
    const { context, page, listedUrls } = ctxStub();
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    await sub.cookiesList({});
    expect(listedUrls).toEqual([undefined]);
  });

  it("delegates set to addCookies and echoes back the cookie name", async () => {
    const { context, page, added } = ctxStub();
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    const r = await sub.cookiesSet({ name: "k", value: "v", url: "https://example.com/" });
    expect(r).toEqual({ ok: true, name: "k" });
    expect(added).toEqual([{ name: "k", value: "v", url: "https://example.com/" }]);
  });

  it("delegates web-storage reads to the helper, evaluating the IIFE on the Page", async () => {
    const { context, page, evaluated } = ctxStub({
      evalResult: { value: "v", origin: "https://example.com" },
    });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    const r = await sub.webStorageGet("localStorage", { key: "k" }, "localstorage_get");
    expect(r).toEqual({ value: "v", origin: "https://example.com" });
    // The Playwright path runs the bare IIFE (no `return` wrapper — page.evaluate
    // takes an expression), the byte-identical pre-seam helper behaviour.
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]).toContain("window.localStorage");
    expect(evaluated[0]!.startsWith("(() =>")).toBe(true);
  });

  it("delegates web-storage writes through the helper to page.evaluate", async () => {
    const { context, page, evaluated } = ctxStub({ evalResult: { ok: true, origin: "o" } });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    await sub.webStorageSet("sessionStorage", { key: "k", value: "v" }, "sessionstorage_set");
    expect(evaluated[0]).toContain("window.sessionStorage");
    expect(evaluated[0]).toContain(`setItem("k", "v")`);
  });

  it("surfaces the helper's origin guard on about:blank (no evaluate attempted)", async () => {
    const { context, page, evaluated } = ctxStub({ url: "about:blank" });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    await expect(sub.webStorageList("localStorage", "localstorage_list")).rejects.toThrow(
      /origin-scoped/,
    );
    expect(evaluated).toEqual([]);
  });

  it("delegates idb reads to the helper, evaluating the async IIFE on the Page", async () => {
    const { context, page, evaluated } = ctxStub({
      evalResult: { databases: [{ name: "d", version: 1 }], origin: "o", supported: true },
    });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    const r = await sub.idbListDatabases("idb_list_databases");
    expect(r).toEqual({ databases: [{ name: "d", version: 1 }], origin: "o", supported: true });
    // The Playwright path runs the byte-identical pre-seam helper: an async IIFE
    // driving the W3C IndexedDB API through page.evaluate (no `return` wrapper).
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]).toContain("indexedDB");
    expect(evaluated[0]!.startsWith("(async () =>")).toBe(true);
  });

  it("delegates idb writes through the helper to page.evaluate", async () => {
    const { context, page, evaluated } = ctxStub({
      evalResult: { ok: true, dbName: "d", storeName: "s", key: "k", origin: "o" },
    });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    const r = await sub.idbPut({ dbName: "d", storeName: "s", key: "k", value: 1 }, "idb_put");
    expect(r).toEqual({ ok: true, dbName: "d", storeName: "s", key: "k", origin: "o" });
    expect(evaluated[0]).toContain("readwrite");
  });

  it("surfaces the idb origin guard on about:blank (no evaluate attempted)", async () => {
    const { context, page, evaluated } = ctxStub({ url: "about:blank" });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    await expect(sub.idbListStores({ dbName: "d" }, "idb_list_stores")).rejects.toThrow(
      /IndexedDB is origin-scoped/,
    );
    expect(evaluated).toEqual([]);
  });

  it("delegates caches reads to the helper, evaluating the async IIFE on the Page", async () => {
    const { context, page, evaluated } = ctxStub({
      evalResult: { names: ["v1"], origin: "https://example.com" },
    });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    const r = await sub.cachesListStorages("caches_list_storages");
    expect(r).toEqual({ names: ["v1"], origin: "https://example.com" });
    // The Playwright path runs the byte-identical pre-seam helper: an async IIFE
    // driving the W3C Cache API through page.evaluate (no `return` wrapper).
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]).toContain("caches");
    expect(evaluated[0]!.startsWith("(async () =>")).toBe(true);
  });

  it("delegates caches writes through the helper to page.evaluate", async () => {
    const { context, page, evaluated } = ctxStub({
      evalResult: { ok: true, cacheName: "c", url: "u", origin: "o" },
    });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    const r = await sub.cachesPut(
      { cacheName: "c", url: "u", response: { body: "b" } },
      "caches_put",
    );
    expect(r).toEqual({ ok: true, cacheName: "c", url: "u", origin: "o" });
    expect(evaluated[0]).toContain(".open(");
  });

  it("surfaces the caches origin guard on about:blank (no evaluate attempted)", async () => {
    const { context, page, evaluated } = ctxStub({ url: "about:blank" });
    const sub = new PlaywrightStorageSubstrate(context, page, "chromium");
    await expect(sub.cachesList({ cacheName: "c" }, "caches_list")).rejects.toThrow(
      /Cache API is origin-scoped/,
    );
    expect(evaluated).toEqual([]);
  });
});
