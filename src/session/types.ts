// BrowserSession is the lifecycle abstraction the rest of the server uses.
// Two implementations: managed.ts (we launch the browser, we own its lifecycle)
// and byob.ts (we attach to an externally-launched Chrome via CDP; not-owned —
// no close, no storage reset on shutdown).

import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import type { EngineKind, SafariSessionHandle } from "../engine/index.js";

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
  /** Enable video recording at context creation via Playwright's native
   *  `recordVideo` context option. Honoured by managed + incognito (we own
   *  the context); ignored on BYOB/attached (not-owned). The .webm is
   *  finalized by Playwright when the context closes — the registry's
   *  teardown calls `page.video().saveAs(targetPath)` for a deterministic
   *  output filename. The `dir` is workspace-rooted by construction
   *  (resolved upstream — Playwright auto-names the file inside). */
  recordVideo?: {
    dir: string;
    size?: { width: number; height: number };
  };
  /** Absolute filesystem paths to unpacked Chromium extension directories
   *  (each containing `manifest.json`). Honoured by **persistent (managed)**
   *  launches in **headed** mode only — chromium's `--load-extension` +
   *  `--disable-extensions-except` flags are emitted from this list. Empty /
   *  unset → no extension flags. Path safety (workspace-rooted) is enforced
   *  at the tool layer (`extensions_install`); this option is the trusted
   *  internal pipe. Refused on incognito / attached at the tool layer. */
  extensionPaths?: readonly string[];
  /** Which browser engine to launch. Defaults to `"chromium"` everywhere — the
   *  default makes every launch byte-identical to the pre-seam behavior.
   *  chromium, firefox, webkit, and android are all implemented (each via its
   *  adapter); a future-declared engine without an adapter throws
   *  `engine-not-yet-supported` at the launch path (see src/engine/). `android`
   *  is attach-only (real Chrome-on-Android over adb + CDP) — managed/ephemeral
   *  launch refuses with `android-launch-not-supported`. */
  browserType?: EngineKind;
}

export interface BrowserSession {
  readonly mode: SessionMode;
  readonly ownsBrowser: boolean;
  /** The engine backing this session. Always `"chromium"` today. */
  readonly engine: EngineKind;
  page(): Page;
  /** Raw CDP handle. Optional: present + fully functional on chromium (the only
   *  engine wired today), absent on engines without a CDP escape hatch. This is
   *  the one mandatory interface member that used to hard-gate multi-engine.
   *  Consumers that need the handle route through `requireCdp()` (src/engine/),
   *  which asserts presence with a structured, engine-naming error. */
  cdp?(): CDPSession;
  /** The Safari-native handle — present ONLY on the `safari` engine, the first
   *  engine with no Playwright `Page`. On a Safari session,
   *  `page()` THROWS (`safari-no-playwright-page`); consumers that can run on
   *  Safari (snapshot/find/navigate/screenshot/cookies via this handle's
   *  WebDriver Classic + BiDi clients) route through `safari()` instead, and the
   *  capability gate refuses the rest up front. Absent on every other engine. */
  safari?(): SafariSessionHandle;
  close(): Promise<void>;
}

export interface SessionInternals {
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
}
