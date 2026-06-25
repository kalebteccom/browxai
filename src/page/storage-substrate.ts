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
// (this port) → implementation → Playwright BrowserContext/Page | safaridriver.
// This file is now a barrel: the port + result types live in
// `storage-substrate-types.ts`, and the two engine-specific implementations live in
// their own sibling files —
//   - PlaywrightStorageSubstrate (chromium / firefox / webkit / android) →
//     `storage-substrate-playwright.ts`: wraps the existing `cookiesList` /
//     `cookiesSet` over a Playwright BrowserContext and the existing `webStorage*` /
//     `idb*` / `caches*` helpers over a Playwright Page — byte-identical to the
//     pre-seam path, so the four engines' keystones stay green unchanged. The native
//     `urls` cross-domain filter is honoured.
//   - SafariStorageSubstrate (safari) → `storage-substrate-safari.ts`: wraps the
//     WebDriver Classic cookie endpoints (`getCookies` / `addCookie`; no Playwright
//     BrowserContext) and the WebDriver `execute/sync` endpoint for web-storage
//     (page-side JS, which safaridriver CAN run); IndexedDB and the Cache API refuse
//     cleanly because their promise-based scripts cannot survive synchronous
//     `execute/sync`.
// Everything is re-exported here so callers (substrate-bundle.ts,
// substrate-bundle-safari.ts) import the whole storage-substrate surface from
// `./storage-substrate.js` unchanged.

export { PlaywrightStorageSubstrate } from "./storage-substrate-playwright.js";
export { SafariStorageSubstrate } from "./storage-substrate-safari.js";

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
