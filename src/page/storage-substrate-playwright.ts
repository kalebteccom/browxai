// PlaywrightStorageSubstrate — the StorageSubstrate implementation for the
// Playwright engines (chromium / firefox / webkit / android). It wraps the
// existing `cookiesList` / `cookiesSet` over a Playwright BrowserContext and the
// existing `webStorage*` / `idb*` / `caches*` helpers over a Playwright Page —
// byte-identical to the pre-seam path, so the four engines' keystones stay green
// unchanged. The native `urls` cross-domain cookie filter is honoured.
//
// Dependency direction (architecture doctrine §1): tool handler → StorageSubstrate
// (the port in `storage-substrate-types.ts`) → this implementation → Playwright
// BrowserContext/Page. The port + result types live in the leaf
// `storage-substrate-types.ts`, which both impls import; this file never imports
// back from the `storage-substrate.js` barrel that re-exports it.

import type { BrowserContext, Page } from "playwright-core";
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

  async webStorageGet(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ value: string | null; origin: string }> {
    return webStorageGet(this.page(), kind, args, tool);
  }

  async webStorageList(
    kind: WebStorageKind,
    tool: string,
  ): Promise<{ entries: WebStorageEntry[]; origin: string }> {
    return webStorageList(this.page(), kind, tool);
  }

  async webStorageSet(
    kind: WebStorageKind,
    args: { key: string; value: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    return webStorageSet(this.page(), kind, args, tool);
  }

  async webStorageDelete(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    return webStorageDelete(this.page(), kind, args, tool);
  }

  async webStorageClear(kind: WebStorageKind, tool: string): Promise<{ ok: true; origin: string }> {
    return webStorageClear(this.page(), kind, tool);
  }

  async idbListDatabases(tool: string): Promise<IdbDatabasesResult> {
    return idbListDatabases(this.page(), tool);
  }

  async idbListStores(args: { dbName: string }, tool: string): Promise<IdbStoresResult> {
    return idbListStores(this.page(), args, tool);
  }

  async idbGet(
    args: { dbName: string; storeName: string; key: unknown },
    tool: string,
  ): Promise<IdbGetResult> {
    return idbGet(this.page(), args, tool);
  }

  async idbPut(
    args: { dbName: string; storeName: string; key: unknown; value: unknown },
    tool: string,
  ): Promise<IdbWriteResult> {
    return idbPut(this.page(), args, tool);
  }

  async idbDelete(
    args: { dbName: string; storeName: string; key: unknown },
    tool: string,
  ): Promise<IdbWriteResult> {
    return idbDelete(this.page(), args, tool);
  }

  async idbClear(
    args: { dbName: string; storeName: string },
    tool: string,
  ): Promise<IdbClearResult> {
    return idbClear(this.page(), args, tool);
  }

  async cachesListStorages(tool: string): Promise<CachesListStoragesResult> {
    return cachesListStorages(this.page(), tool);
  }

  async cachesList(
    args: { cacheName: string; urlPattern?: string },
    tool: string,
  ): Promise<CachesListResult> {
    return cachesList(this.page(), args, tool);
  }

  async cachesGet(
    args: { cacheName: string; url: string },
    tool: string,
  ): Promise<CachesGetResult> {
    return cachesGet(this.page(), args, tool);
  }

  async cachesPut(
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

  async cachesDelete(
    args: { cacheName: string; url: string },
    tool: string,
  ): Promise<CachesDeleteResult> {
    return cachesDelete(this.page(), args, tool);
  }

  async cachesClear(args: { cacheName: string }, tool: string): Promise<CachesClearResult> {
    return cachesClear(this.page(), args, tool);
  }

  async cachesDeleteStorage(
    args: { cacheName: string },
    tool: string,
  ): Promise<CachesDeleteStorageResult> {
    return cachesDeleteStorage(this.page(), args, tool);
  }
}
