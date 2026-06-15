// StorageSubstrate port + result types — the engine-agnostic vocabulary the
// storage tools speak (cookies + web-storage + IndexedDB + Cache API). Split out
// of storage-substrate.ts so neither the interface nor its two implementations
// push that file over the size budget. Re-exported through
// `./storage-substrate.js` so callers import unchanged.

import type { CookieInput, StorageStateBlob, WebStorageKind } from "../session/storage.js";
import type { CacheEntryBody } from "../session/cache-storage.js";

/** A cookie as returned by a `cookiesList`. The Playwright path returns the full
 *  Playwright cookie object; the Safari path returns the WebDriver cookie shape.
 *  Both carry at least `name` + `value`, which is all the handler renders. */
export type ListedCookie = StorageStateBlob["cookies"][number] | SafariListedCookie;

/** The WebDriver Classic cookie shape safaridriver returns from `GET /cookie`. */
export interface SafariListedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expiry?: number;
  sameSite?: "Lax" | "Strict" | "None";
}

/** Normalised cookie-list request — the handler's already-validated args, engine-
 *  blind. `urls` is the Playwright native cross-domain filter; it is honoured by the
 *  Playwright path and inert on Safari (WebDriver scopes the jar to the current
 *  document, the same as the pre-seam Safari branch). */
export interface CookiesListRequest {
  urls?: string[];
}

/** A single web-storage entry — the shape `*_list` renders per key. */
export interface WebStorageEntry {
  key: string;
  value: string;
}

/** The IDB result shapes — the universal envelopes the idb handlers render. They
 *  mirror the `idb*` helper return types verbatim so the Playwright path is a
 *  pass-through and the four engines' keystones stay byte-identical. */
export interface IdbDatabasesResult {
  databases: Array<{ name: string; version: number }>;
  origin: string;
  supported: boolean;
}
export interface IdbStoresResult {
  stores: string[];
  dbName: string;
  version: number;
  origin: string;
}
export type IdbGetResult =
  | { found: false; dbName: string; storeName: string; key: unknown; origin: string }
  | {
      found: true;
      dbName: string;
      storeName: string;
      key: unknown;
      value: unknown;
      origin: string;
    };
export interface IdbWriteResult {
  ok: true;
  dbName: string;
  storeName: string;
  key: unknown;
  origin: string;
}
export interface IdbClearResult {
  ok: true;
  dbName: string;
  storeName: string;
  origin: string;
}

/** The Cache API result shapes — the universal envelopes the caches handlers
 *  render. They mirror the `caches*` helper return types verbatim so the
 *  Playwright path is a pass-through and the four engines' keystones stay
 *  byte-identical. `CachesGetResult` reuses the helper's `CacheEntryBody` so the
 *  text/binary split is shared, not re-declared. */
export interface CachesListStoragesResult {
  names: string[];
  origin: string;
}
export interface CachesListResult {
  entries: Array<{ url: string; method: string }>;
  origin: string;
  cacheName: string;
}
export type CachesGetResult =
  | { found: false; cacheName: string; url: string; origin: string }
  | (CacheEntryBody & { found: true; cacheName: string; url: string; origin: string });
export interface CachesPutResult {
  ok: true;
  cacheName: string;
  url: string;
  origin: string;
}
export interface CachesDeleteResult {
  ok: true;
  existed: boolean;
  cacheName: string;
  url: string;
  origin: string;
}
export interface CachesClearResult {
  ok: true;
  cleared: number;
  cacheName: string;
  origin: string;
}
export interface CachesDeleteStorageResult {
  ok: true;
  existed: boolean;
  cacheName: string;
  origin: string;
}

/** The storage capability port. One instance wraps one session's engine handle;
 *  the methods carry no engine type, so the handlers above this seam are
 *  engine-blind. Mirrors the ActionSubstrate / CaptureSubstrate shape. The
 *  web-storage methods take `kind` (localStorage | sessionStorage) — the JS
 *  surface is identical, only the storage object differs — plus the handler's
 *  `tool` name, so the validation/guard error messages read the same as the
 *  pre-seam helper path on every engine. */
export interface StorageSubstrate {
  readonly engine: string;
  cookiesList(req: CookiesListRequest): Promise<ListedCookie[]>;
  cookiesSet(req: CookieInput): Promise<{ ok: boolean; name: string }>;
  webStorageGet(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ value: string | null; origin: string }>;
  webStorageList(
    kind: WebStorageKind,
    tool: string,
  ): Promise<{ entries: WebStorageEntry[]; origin: string }>;
  webStorageSet(
    kind: WebStorageKind,
    args: { key: string; value: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }>;
  webStorageDelete(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }>;
  webStorageClear(kind: WebStorageKind, tool: string): Promise<{ ok: true; origin: string }>;
  idbListDatabases(tool: string): Promise<IdbDatabasesResult>;
  idbListStores(args: { dbName: string }, tool: string): Promise<IdbStoresResult>;
  idbGet(
    args: { dbName: string; storeName: string; key: unknown },
    tool: string,
  ): Promise<IdbGetResult>;
  idbPut(
    args: { dbName: string; storeName: string; key: unknown; value: unknown },
    tool: string,
  ): Promise<IdbWriteResult>;
  idbDelete(
    args: { dbName: string; storeName: string; key: unknown },
    tool: string,
  ): Promise<IdbWriteResult>;
  idbClear(args: { dbName: string; storeName: string }, tool: string): Promise<IdbClearResult>;
  cachesListStorages(tool: string): Promise<CachesListStoragesResult>;
  cachesList(
    args: { cacheName: string; urlPattern?: string },
    tool: string,
  ): Promise<CachesListResult>;
  cachesGet(args: { cacheName: string; url: string }, tool: string): Promise<CachesGetResult>;
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
  ): Promise<CachesPutResult>;
  cachesDelete(args: { cacheName: string; url: string }, tool: string): Promise<CachesDeleteResult>;
  cachesClear(args: { cacheName: string }, tool: string): Promise<CachesClearResult>;
  cachesDeleteStorage(
    args: { cacheName: string },
    tool: string,
  ): Promise<CachesDeleteStorageResult>;
}
