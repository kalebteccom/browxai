// The StorageSubstrate interface — the engine-agnostic seam beneath the storage
// tools (cookies + localStorage/sessionStorage + IndexedDB + Cache API CRUD). It is
// the storage side of the engine-agnostic port layer: a tool handler asks a substrate
// to read or write the cookie jar, web-storage, an IndexedDB store, or the Cache API and gets back a
// universal result; an engine-specific implementation does the work. The handler
// never names Playwright, safaridriver, or an engine — it calls
// `storageFor(e).cookiesList(req)` / `storageFor(e).webStorageGet(kind, req)` /
// `storageFor(e).idbGet(args, tool)` / `storageFor(e).cachesList(args, tool)`, the
// same shape as `actionsFor(e).click(args)` / `captureFor(e).screenshot(req)`.
//
// Dependency direction (architecture doctrine §1): tool handler → StorageSubstrate
// (this interface) → implementation → Playwright BrowserContext/Page | safaridriver.
// Two impls today:
//   - PlaywrightStorageSubstrate (chromium / firefox / webkit / android): wraps the
//     existing `cookiesList` / `cookiesSet` over a Playwright BrowserContext and the
//     existing `webStorage*` / `idb*` helpers over a Playwright Page — byte-identical
//     to the pre-seam path, so the four engines' keystones stay green unchanged. The
//     native `urls` cross-domain filter is honoured.
//   - SafariStorageSubstrate (safari): wraps the WebDriver Classic cookie endpoints
//     (`getCookies` / `addCookie`; no Playwright BrowserContext) and the WebDriver
//     `execute/sync` endpoint for web-storage (page-side JS, which safaridriver CAN
//     run — the same `return (…)` expression wrapping the ScriptSubstrate uses). For
//     cookies, safaridriver scopes the jar to the current document, so the `urls`
//     filter is inert (the WebDriver protocol has no cross-domain cookie filter) and
//     `cookies_set` derives the domain from `url` exactly as the pre-seam Safari
//     branch did. For web-storage the origin guard reads `currentUrl()` — the Classic
//     substitute for the Playwright `page.url()` the helper guards on. The gating
//     lives here, not as an `if (e.session.safari?.())` branch in the handler.

import type { BrowserContext, Page } from "playwright-core";
import type { SafariSessionHandle } from "../engine/index.js";
import type { CookieInput, WebStorageKind } from "../session/storage.js";
import {
  cookiesList,
  cookiesSet,
  webStorageGet,
  webStorageSet,
  webStorageList,
  webStorageDelete,
  webStorageClear,
} from "../session/storage.js";
import {
  idbListDatabases,
  idbListStores,
  idbGet,
  idbPut,
  idbDelete,
  idbClear,
} from "../session/idb-storage.js";
import {
  cachesListStorages,
  cachesList,
  cachesGet,
  cachesPut,
  cachesDelete,
  cachesClear,
  cachesDeleteStorage,
} from "../session/cache-storage.js";
import type {
  ListedCookie,
  CookiesListRequest,
  WebStorageEntry,
  IdbDatabasesResult,
  IdbStoresResult,
  IdbGetResult,
  IdbWriteResult,
  IdbClearResult,
  CachesListStoragesResult,
  CachesListResult,
  CachesGetResult,
  CachesPutResult,
  CachesDeleteResult,
  CachesClearResult,
  CachesDeleteStorageResult,
  StorageSubstrate,
} from "./storage-substrate-types.js";

// The StorageSubstrate port + result types live in `storage-substrate-types.ts`;
// re-exported here so callers import the whole storage-substrate surface from
// `./storage-substrate.js` unchanged.
export type {
  ListedCookie,
  SafariListedCookie,
  CookiesListRequest,
  WebStorageEntry,
  IdbDatabasesResult,
  IdbStoresResult,
  IdbGetResult,
  IdbWriteResult,
  IdbClearResult,
  CachesListStoragesResult,
  CachesListResult,
  CachesGetResult,
  CachesPutResult,
  CachesDeleteResult,
  CachesClearResult,
  CachesDeleteStorageResult,
  StorageSubstrate,
} from "./storage-substrate-types.js";

/** Playwright engines — delegates cookie ops to the existing `cookiesList` /
 *  `cookiesSet` over the session's BrowserContext (the `context` thunk captures the
 *  session entry, the same per-call access the handlers did before this seam), and
 *  the web-storage ops to the existing `webStorage*` helpers over the session's Page
 *  (the `page` thunk, likewise). No behaviour change. */
export class PlaywrightStorageSubstrate implements StorageSubstrate {
  readonly engine: string;
  constructor(
    private readonly context: () => BrowserContext,
    private readonly page: () => Page,
    engine = "chromium",
  ) {
    this.engine = engine;
  }

  async cookiesList(req: CookiesListRequest): Promise<ListedCookie[]> {
    return cookiesList(this.context(), { urls: req.urls });
  }

  async cookiesSet(req: CookieInput): Promise<{ ok: boolean; name: string }> {
    const r = await cookiesSet(this.context(), req);
    return { ok: r.ok, name: req.name };
  }

  webStorageGet(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ value: string | null; origin: string }> {
    return webStorageGet(this.page(), kind, args, tool);
  }

  webStorageList(
    kind: WebStorageKind,
    tool: string,
  ): Promise<{ entries: WebStorageEntry[]; origin: string }> {
    return webStorageList(this.page(), kind, tool);
  }

  webStorageSet(
    kind: WebStorageKind,
    args: { key: string; value: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    return webStorageSet(this.page(), kind, args, tool);
  }

  webStorageDelete(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    return webStorageDelete(this.page(), kind, args, tool);
  }

  webStorageClear(kind: WebStorageKind, tool: string): Promise<{ ok: true; origin: string }> {
    return webStorageClear(this.page(), kind, tool);
  }

  idbListDatabases(tool: string): Promise<IdbDatabasesResult> {
    return idbListDatabases(this.page(), tool);
  }

  idbListStores(args: { dbName: string }, tool: string): Promise<IdbStoresResult> {
    return idbListStores(this.page(), args, tool);
  }

  idbGet(
    args: { dbName: string; storeName: string; key: unknown },
    tool: string,
  ): Promise<IdbGetResult> {
    return idbGet(this.page(), args, tool);
  }

  idbPut(
    args: { dbName: string; storeName: string; key: unknown; value: unknown },
    tool: string,
  ): Promise<IdbWriteResult> {
    return idbPut(this.page(), args, tool);
  }

  idbDelete(
    args: { dbName: string; storeName: string; key: unknown },
    tool: string,
  ): Promise<IdbWriteResult> {
    return idbDelete(this.page(), args, tool);
  }

  idbClear(args: { dbName: string; storeName: string }, tool: string): Promise<IdbClearResult> {
    return idbClear(this.page(), args, tool);
  }

  cachesListStorages(tool: string): Promise<CachesListStoragesResult> {
    return cachesListStorages(this.page(), tool);
  }

  cachesList(
    args: { cacheName: string; urlPattern?: string },
    tool: string,
  ): Promise<CachesListResult> {
    return cachesList(this.page(), args, tool);
  }

  cachesGet(args: { cacheName: string; url: string }, tool: string): Promise<CachesGetResult> {
    return cachesGet(this.page(), args, tool);
  }

  cachesPut(
    args: {
      cacheName: string;
      url: string;
      response: {
        status?: number;
        headers?: Record<string, string>;
        body?: string;
        contentBase64?: string;
      };
    },
    tool: string,
  ): Promise<CachesPutResult> {
    return cachesPut(this.page(), args, tool);
  }

  cachesDelete(
    args: { cacheName: string; url: string },
    tool: string,
  ): Promise<CachesDeleteResult> {
    return cachesDelete(this.page(), args, tool);
  }

  cachesClear(args: { cacheName: string }, tool: string): Promise<CachesClearResult> {
    return cachesClear(this.page(), args, tool);
  }

  cachesDeleteStorage(
    args: { cacheName: string },
    tool: string,
  ): Promise<CachesDeleteStorageResult> {
    return cachesDeleteStorage(this.page(), args, tool);
  }
}

/** Web-storage is origin-scoped and page-bound — the page MUST be at the target
 *  origin first. On Safari the Classic substitute for `page.url()` is
 *  `currentUrl()`; this guard reframes about:blank / unreachable into the same
 *  navigation hint the Playwright helper throws, so the refusal reads identically
 *  on every engine. */
async function safariWebStorageGuard(
  handle: SafariSessionHandle,
  kind: WebStorageKind,
  tool: string,
): Promise<void> {
  let url: string;
  try {
    url = await handle.webDriver.currentUrl(handle.sessionId);
  } catch {
    url = "";
  }
  if (!url || url === "about:blank") {
    throw new Error(
      `${tool}: ${kind} is origin-scoped and the page is at "${url || "(unknown)"}". ` +
        `Navigate the session to the target origin first.`,
    );
  }
}

/** Safari — the WebDriver-Classic storage path. Cookies ride the Classic cookie
 *  endpoints; web-storage rides `execute/sync`, which runs page-context JS just like
 *  Playwright's `page.evaluate` (the ScriptSubstrate proves the seam). safaridriver
 *  returns the cookie jar for the current document; the Playwright `urls`
 *  cross-domain filter is not available over WebDriver, so it is inert here.
 *  `cookiesSet` scopes to the current document's domain — derived from `url` when
 *  given (else the explicit `domain`); the session must already be navigated to that
 *  domain. The web-storage methods run the SAME page-side IIFE the Playwright helper
 *  evaluates, wrapped in `return (…)` (an expression, not a statement body) the way
 *  `execute/sync` expects — the validation + origin guard mirror the helper so the
 *  error envelopes match. Web-storage is page-side JS, so safaridriver runs it the
 *  same way: on the no-Playwright-Page Safari engine this is a NEW working
 *  capability (the handler previously had no Safari path and threw), surfaced
 *  through the same port so the handler stays engine-blind. IndexedDB and the
 *  Cache API are the exception: both APIs are promise-based, so the page-side script
 *  is an ASYNC IIFE that must be awaited — but safaridriver's `execute/sync` returns
 *  the moment the body returns and never observes the settled promise, and there is
 *  no async-script client on this handle. So every idb and caches method REFUSES
 *  cleanly in the adapter — rejecting with a structured Error the handler's
 *  `errText` renders (the pre-seam handlers threw at `page()`, so a reject keeps
 *  that contract) — rather than running a script whose result would always be a
 *  pending promise. */
export class SafariStorageSubstrate implements StorageSubstrate {
  readonly engine = "safari";
  constructor(private readonly handle: SafariSessionHandle) {}

  async cookiesList(_req: CookiesListRequest): Promise<ListedCookie[]> {
    return this.handle.webDriver.getCookies(this.handle.sessionId);
  }

  async cookiesSet(req: CookieInput): Promise<{ ok: boolean; name: string }> {
    let derivedDomain = req.domain;
    if (!derivedDomain && req.url) {
      try {
        derivedDomain = new URL(req.url).hostname;
      } catch {
        derivedDomain = undefined;
      }
    }
    await this.handle.webDriver.addCookie(this.handle.sessionId, {
      name: req.name,
      value: req.value,
      path: req.path ?? "/",
      ...(derivedDomain ? { domain: derivedDomain } : {}),
      ...(typeof req.expires === "number" ? { expiry: Math.floor(req.expires) } : {}),
      ...(req.httpOnly !== undefined ? { httpOnly: req.httpOnly } : {}),
      ...(req.secure !== undefined ? { secure: req.secure } : {}),
      ...(req.sameSite ? { sameSite: req.sameSite } : {}),
    });
    return { ok: true, name: req.name };
  }

  async webStorageGet(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ value: string | null; origin: string }> {
    if (!args.key) throw new Error(`${tool}: \`key\` is required`);
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; ` +
      `return { value: s.getItem(${JSON.stringify(args.key)}), origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { value: string | null; origin: string };
  }

  async webStorageList(
    kind: WebStorageKind,
    tool: string,
  ): Promise<{ entries: WebStorageEntry[]; origin: string }> {
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; var out = []; ` +
      `for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k === null) continue; ` +
      `out.push({ key: k, value: s.getItem(k) || "" }); } ` +
      `return { entries: out, origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { entries: WebStorageEntry[]; origin: string };
  }

  async webStorageSet(
    kind: WebStorageKind,
    args: { key: string; value: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    if (!args.key) throw new Error(`${tool}: \`key\` is required`);
    if (typeof args.value !== "string") throw new Error(`${tool}: \`value\` (string) is required`);
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; ` +
      `s.setItem(${JSON.stringify(args.key)}, ${JSON.stringify(args.value)}); ` +
      `return { ok: true, origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { ok: true; origin: string };
  }

  async webStorageDelete(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    if (!args.key) throw new Error(`${tool}: \`key\` is required`);
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; s.removeItem(${JSON.stringify(args.key)}); ` +
      `return { ok: true, origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { ok: true; origin: string };
  }

  async webStorageClear(kind: WebStorageKind, tool: string): Promise<{ ok: true; origin: string }> {
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; s.clear(); ` +
      `return { ok: true, origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { ok: true; origin: string };
  }

  idbListDatabases(tool: string): Promise<IdbDatabasesResult> {
    return Promise.reject(this.idbRefuse(tool));
  }

  idbListStores(_args: { dbName: string }, tool: string): Promise<IdbStoresResult> {
    return Promise.reject(this.idbRefuse(tool));
  }

  idbGet(
    _args: { dbName: string; storeName: string; key: unknown },
    tool: string,
  ): Promise<IdbGetResult> {
    return Promise.reject(this.idbRefuse(tool));
  }

  idbPut(
    _args: { dbName: string; storeName: string; key: unknown; value: unknown },
    tool: string,
  ): Promise<IdbWriteResult> {
    return Promise.reject(this.idbRefuse(tool));
  }

  idbDelete(
    _args: { dbName: string; storeName: string; key: unknown },
    tool: string,
  ): Promise<IdbWriteResult> {
    return Promise.reject(this.idbRefuse(tool));
  }

  idbClear(_args: { dbName: string; storeName: string }, tool: string): Promise<IdbClearResult> {
    return Promise.reject(this.idbRefuse(tool));
  }

  cachesListStorages(tool: string): Promise<CachesListStoragesResult> {
    return Promise.reject(this.cachesRefuse(tool));
  }

  cachesList(
    _args: { cacheName: string; urlPattern?: string },
    tool: string,
  ): Promise<CachesListResult> {
    return Promise.reject(this.cachesRefuse(tool));
  }

  cachesGet(_args: { cacheName: string; url: string }, tool: string): Promise<CachesGetResult> {
    return Promise.reject(this.cachesRefuse(tool));
  }

  cachesPut(
    _args: {
      cacheName: string;
      url: string;
      response: {
        status?: number;
        headers?: Record<string, string>;
        body?: string;
        contentBase64?: string;
      };
    },
    tool: string,
  ): Promise<CachesPutResult> {
    return Promise.reject(this.cachesRefuse(tool));
  }

  cachesDelete(
    _args: { cacheName: string; url: string },
    tool: string,
  ): Promise<CachesDeleteResult> {
    return Promise.reject(this.cachesRefuse(tool));
  }

  cachesClear(_args: { cacheName: string }, tool: string): Promise<CachesClearResult> {
    return Promise.reject(this.cachesRefuse(tool));
  }

  cachesDeleteStorage(
    _args: { cacheName: string },
    tool: string,
  ): Promise<CachesDeleteStorageResult> {
    return Promise.reject(this.cachesRefuse(tool));
  }

  // IndexedDB's API is promise-based, so its page-side script is an async IIFE that
  // must be awaited — but safaridriver's `execute/sync` returns the moment the body
  // returns, never observing the settled promise, and this handle has no
  // async-script client. Rather than run a script whose result is always a pending
  // promise, every idb method refuses cleanly here by rejecting with this Error
  // (the handler's `errText` renders it — the pre-seam handlers threw at `page()`,
  // so a reject preserves that contract), keeping the engine check out of the handler.
  private idbRefuse(tool: string): Error {
    return new Error(
      `\`${tool}\`: IndexedDB is not available on the Safari engine — its promise-based API ` +
        `needs an async page-script path that safaridriver's synchronous execute/sync cannot provide. ` +
        `Use a chromium, firefox, or webkit session for IndexedDB.`,
    );
  }

  // The Cache API is promise-based exactly like IndexedDB — its page-side script is
  // an async IIFE that safaridriver's synchronous execute/sync cannot await, and this
  // handle has no async-script client. Same clean in-adapter refusal, keeping the
  // engine check out of the handler.
  private cachesRefuse(tool: string): Error {
    return new Error(
      `\`${tool}\`: the Cache API is not available on the Safari engine — its promise-based API ` +
        `needs an async page-script path that safaridriver's synchronous execute/sync cannot provide. ` +
        `Use a chromium, firefox, or webkit session for the Cache API.`,
    );
  }
}
