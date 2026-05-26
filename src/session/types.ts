// BrowserSession is the lifecycle abstraction the rest of the server uses.
// Two implementations: managed.ts (we launch the browser, we own its lifecycle)
// and byob.ts (we attach to an externally-launched Chrome via CDP; not-owned —
// no close, no storage reset on shutdown).

import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

export type SessionMode = "managed" | "byob";

/** resolved device/viewport emulation options applied at context
 *  creation. A subset of Playwright's context options — enough for
 *  responsive / touch / DPR testing without re-exposing the whole API. */
export interface DeviceConfig {
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

export interface SessionOptions {
  headless?: boolean;
  /** BYOB only: `http://127.0.0.1:9222` etc. Loopback enforced. */
  attachCdp?: string;
  /** Workspace-rooted profile dir (managed only). */
  profileDir?: string;
  /** device/viewport emulation, applied at context creation. */
  device?: DeviceConfig;
  /** launch with `--disable-web-security --disable-site-isolation-trials`
   *  (SOP/CORS OFF browser-wide). managed/incognito only; loud-warned. */
  disableWebSecurity?: boolean;
  /** Seed the new context's storage state at creation. Honoured by
   *  **incognito** mode (where `browser.newContext({storageState})` is the
   *  native primitive). For **persistent** (managed) mode the context's
   *  state is on disk in the profile dir — the storageState is applied
   *  post-create via `context.setStorageState`, which CLEARS the profile's
   *  existing cookies / localStorage first. For BYOB/attached the value is
   *  ignored (not-owned: we don't mutate the consumer's Chrome). */
  storageState?: import("./storage.js").StorageStateBlob;
  /** Enable HAR recording at context creation via Playwright's native
   *  `recordHar` context option. Honoured by managed + incognito (we own the
   *  context); ignored on BYOB/attached (not-owned). The HAR is finalized by
   *  Playwright when the context closes. The path is workspace-rooted by
   *  construction (resolved upstream). */
  recordHar?: {
    path: string;
    mode?: "full" | "minimal";
    content?: "embed" | "attach" | "omit";
    urlFilter?: string | RegExp;
  };
}

export interface BrowserSession {
  readonly mode: SessionMode;
  readonly ownsBrowser: boolean;
  page(): Page;
  cdp(): CDPSession;
  close(): Promise<void>;
}

export interface SessionInternals {
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
}
