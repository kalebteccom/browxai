// BrowserSession is the lifecycle abstraction the rest of the server uses.
// Two implementations: managed.ts (we launch the browser, we own its lifecycle)
// and byob.ts (we attach to an externally-launched Chrome via CDP; not-owned —
// no close, no storage reset on shutdown). See docs/phase-1-design.md §5.

import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

export type SessionMode = "managed" | "byob";

/** W-H6: resolved device/viewport emulation options applied at context
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
  /** W-H6: device/viewport emulation, applied at context creation. */
  device?: DeviceConfig;
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
