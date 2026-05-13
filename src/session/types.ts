// BrowserSession is the lifecycle abstraction the rest of the server uses.
// Two implementations: managed.ts (we launch the browser, we own its lifecycle)
// and byob.ts (we attach to an externally-launched Chrome via CDP; not-owned —
// no close, no storage reset on shutdown). See docs/phase-1-design.md §5.

import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";

export type SessionMode = "managed" | "byob";

export interface SessionOptions {
  headless?: boolean;
  /** BYOB only: `http://127.0.0.1:9222` etc. Loopback enforced. */
  attachCdp?: string;
  /** Workspace-rooted profile dir (managed only). */
  profileDir?: string;
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
