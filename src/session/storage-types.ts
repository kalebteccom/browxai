// Storage vocabulary — the plain-data half of `storage.ts`.
//
// Split out because the StorageSubstrate port
// (`src/page/storage-substrate-types.ts`) names `StorageStateBlob` /
// `CookieInput` / `WebStorageKind` in its method signatures, and `storage.ts`
// imports `BrowserContext` / `Page` for the helpers that do the work. A port
// module that reaches playwright-core — even transitively, even type-only — is
// not a port, which is what the `ports-name-no-vendor-type` dependency-cruiser
// rule enforces. Declarations here, helpers there; `storage.ts` re-exports
// every name so existing importers are unchanged.

/** Playwright's `storageState()` return shape (re-stated locally so callers
 *  don't need to depend on playwright-core directly). */
export interface StorageStateBlob {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

/** Cookie shape Playwright accepts in `addCookies`. */
export interface CookieInput {
  name: string;
  value: string;
  /** Either `url` OR (`domain` + `path`) is required. */
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Storage kind — exact same JS surface, different storage object. */
export type WebStorageKind = "localStorage" | "sessionStorage";
