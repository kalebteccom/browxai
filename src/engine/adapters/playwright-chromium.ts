// PlaywrightChromiumAdapter — the first BrowserEngine adapter. This is where
// today's Chromium/CDP behavior lives now: it WRAPS the exact Playwright calls
// the three session factories used inline before the seam existed
// (`chromium.launchPersistentContext`, `chromium.launch` + `newContext`,
// `chromium.connectOverCDP`), and mints the eager `CDPSession` Chromium needs.
// It does not reimplement anything — the launch options, flags, and ordering
// are byte-identical to the pre-seam factories.
//
// The browser-type is resolved through `resolveBrowserType("chromium")` so the
// selection seam is exercised by the only engine wired in P0; firefox/webkit
// route through the same resolver and hit `EngineNotYetSupportedError`.

import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  CDPSession,
  LaunchOptions,
  Page,
} from "playwright-core";
import { resolveBrowserType } from "../select.js";
import { capabilitiesFor } from "../capabilities.js";
import type { EngineCapabilities, EngineKind } from "../types.js";

/** Chromium always mints an eager CDP session, so its launch handles carry a
 *  required `cdp` — tighter than the port's optional-`cdp` `EngineLaunchHandles`
 *  so callers don't need a non-null assertion on the Chromium path. */
export interface ChromiumLaunchHandles {
  browser?: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
}

/** Options for a persistent (managed) launch — the subset the managed factory
 *  passes to `launchPersistentContext` today. */
export interface PersistentLaunchSpec {
  profileDir: string;
  options: Parameters<ReturnType<typeof resolveBrowserType>["launchPersistentContext"]>[1];
}

/** Options for an ephemeral (incognito) launch — a `launch` + `newContext`
 *  pair, exactly as the incognito factory builds it today. */
export interface EphemeralLaunchSpec {
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}

/** The Chromium engine adapter. One instance per launch; it owns the engine
 *  selection + the eager CDP session, and surfaces the handles the session
 *  layer wires its bookkeeping onto. */
export class PlaywrightChromiumAdapter {
  readonly engine: EngineKind = "chromium";
  readonly capabilities: EngineCapabilities;

  constructor() {
    // chromium always has a declaration (see capabilities.ts).
    this.capabilities = capabilitiesFor("chromium")!;
  }

  /** Persistent-profile launch — wraps `launchPersistentContext` + the eager
   *  `newCDPSession`. Mirrors openManagedSession's pre-seam body verbatim. */
  async launchPersistent(spec: PersistentLaunchSpec): Promise<ChromiumLaunchHandles> {
    const browserType = resolveBrowserType(this.engine);
    const context = await browserType.launchPersistentContext(spec.profileDir, spec.options);
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    return { context, page, cdp };
  }

  /** Ephemeral launch — wraps `launch` + `newContext` + the eager
   *  `newCDPSession`. Mirrors openIncognitoSession's pre-seam body verbatim. */
  async launchEphemeral(spec: EphemeralLaunchSpec): Promise<ChromiumLaunchHandles> {
    const browserType = resolveBrowserType(this.engine);
    const browser = await browserType.launch(spec.launchOptions);
    const context = await browser.newContext(spec.contextOptions);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    return { browser, context, page, cdp };
  }

  /** BYOB attach over CDP — wraps `connectOverCDP` + the eager `newCDPSession`.
   *  The loopback / not-owned policy stays in byob.ts (protocol-neutral per the
   *  coupling audit); only this transport hop is engine-specific. Mirrors
   *  openByobSession's pre-seam connect body verbatim. */
  async attachOverCdp(endpoint: string): Promise<ChromiumLaunchHandles> {
    const browserType = resolveBrowserType(this.engine);
    const browser = await browserType.connectOverCDP(endpoint);
    const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    return { browser, context, page, cdp };
  }
}
