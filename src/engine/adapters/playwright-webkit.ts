// PlaywrightWebKitAdapter — the THIRD BrowserEngine adapter (RFC 0002 D7, P2c).
// It mirrors PlaywrightFirefoxAdapter's three launch shapes over
// `resolveBrowserType("webkit")` (Playwright's bundled WebKit build — the
// WebKit-ENGINE correctness lane, NOT Safari; D7 is explicit that a real-Safari
// surface is a separate, tiered companion product, never a browxai engine
// adapter). Like the Firefox adapter it mints NO eager CDP session — WebKit has
// no CDP at all (measured: `newCDPSession` throws "CDP session is only available
// in Chromium"), and `WEBKIT_CAPABILITIES` declares `deep: false`, so the raw-CDP
// escape hatch is absent and the ~26 CDP-deep tools structured-refuse via the
// CAPABILITY-based engine gate (src/engine/tool-gate.ts) with NO per-engine edit
// — the gate keys on `deep:false`, not an engine name, so a new engine that drops
// `deep` auto-gates. That is the open/closed-correct design the doctrine asks for.
//
// Dependency direction (architecture doctrine): port → adapter → Playwright. The
// adapter delegates directly to Playwright on the per-action path exactly like
// the chromium + firefox ones — no added allocation on the hot path.
//
// Substrates: both already engine-agnostic. WebKit (CDP-absent) selects the
// page-side `PlaywrightSnapshotSubstrate` walker (`snapshotSubstrateFor` keys on
// CDP capability, not engine name), so `snapshot`/`find`/`navigate`/`click`/
// `fill`/`text_search`/`extract`/`set_of_marks`/`plan` work on WebKit with no
// substrate code change. The network slice rides P2b's Playwright-event tap when
// it lands (same as Firefox); until then WebKit's network slice is empty.
//
// Persistent mode: measured against the installed Playwright, WebKit DOES support
// `launchPersistentContext` (unlike the RFC D7 "persistent-mode-on-WebKit is a
// known loss" caveat, which is about real-Safari, not the WebKit engine build) —
// so the managed path is real. Should a future Playwright/WebKit build drop it,
// the launch throws and the session factory surfaces it; the reserved structured
// reason name is `webkit-persistent-not-supported`.

import type { BrowserContextOptions, LaunchOptions } from "playwright-core";
import { resolveBrowserType } from "../select.js";
import { capabilitiesFor } from "../capabilities.js";
import type { EngineCapabilities, EngineKind, EngineLaunchHandles } from "../types.js";

/** Persistent (managed) launch spec — the subset the managed factory passes to
 *  `launchPersistentContext`. Same shape as the chromium/firefox adapters' so the
 *  session factories thread one spec regardless of engine. */
export interface WebKitPersistentLaunchSpec {
  profileDir: string;
  options: Parameters<ReturnType<typeof resolveBrowserType>["launchPersistentContext"]>[1];
}

/** Ephemeral (incognito) launch spec — a `launch` + `newContext` pair. */
export interface WebKitEphemeralLaunchSpec {
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}

/** The WebKit engine adapter. One instance per launch; it owns engine selection
 *  and surfaces the handles the session layer wires its bookkeeping onto. Like
 *  the firefox adapter it carries no `cdp` on its handles — WebKit has no CDP
 *  escape hatch (measured: `newCDPSession` throws off Chromium). */
export class PlaywrightWebKitAdapter {
  readonly engine: EngineKind = "webkit";
  readonly capabilities: EngineCapabilities;

  constructor() {
    // webkit always has a declaration (see capabilities.ts).
    this.capabilities = capabilitiesFor("webkit")!;
  }

  /** Persistent-profile launch — wraps `launchPersistentContext`. No eager CDP
   *  session (WebKit has none). Mirrors the firefox adapter's shape. If a future
   *  WebKit build lacks persistent-context support, `launchPersistentContext`
   *  throws and the failure surfaces through the session factory (RFC D7 reserves
   *  the `webkit-persistent-not-supported` reason for a structured refusal). */
  async launchPersistent(spec: WebKitPersistentLaunchSpec): Promise<EngineLaunchHandles> {
    const browserType = resolveBrowserType(this.engine);
    const context = await browserType.launchPersistentContext(spec.profileDir, spec.options);
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page };
  }

  /** Ephemeral launch — wraps `launch` + `newContext`. No eager CDP session. */
  async launchEphemeral(spec: WebKitEphemeralLaunchSpec): Promise<EngineLaunchHandles> {
    const browserType = resolveBrowserType(this.engine);
    const browser = await browserType.launch(spec.launchOptions);
    const context = await browser.newContext(spec.contextOptions);
    const page = await context.newPage();
    return { browser, context, page };
  }

  /** BYOB attach. WebKit has no CDP attach client and no BiDi attach client
   *  either (Safari has not shipped BiDi as of June 2026 — RFC D7), and the
   *  WebKit engine build exposes no remote-debugging attach surface browxai can
   *  drive. Per the doctrine's no-silent-no-op rule this rejects with a
   *  structured, RFC-naming error rather than failing quietly. Promise-returning
   *  (not `async`) so the eslint require-await rule is honest: there is no awaited
   *  work — it is a structured refusal. */
  attach(_endpoint: string): Promise<EngineLaunchHandles> {
    return Promise.reject(
      new Error(
        "webkit-attach-not-supported: browxai cannot attach to a running WebKit/Safari over CDP " +
          "or BiDi. WebKit has no CDP escape hatch, and Safari has not shipped WebDriver BiDi as " +
          "of June 2026 (safaridriver is WebDriver-Classic-only and hard-isolates automation into " +
          "a clean ephemeral window — attach-to-the-live-session is impossible by design). Per RFC " +
          "0002 D7 the WebKit engine lane is correctness-only (managed sessions); real-Safari BYOB " +
          "is a separate, tiered companion surface (AppleScript / Web-Extension), not a browxai " +
          "engine adapter. Use a managed WebKit session, or a chromium session for CDP-attach BYOB. " +
          "See docs/rfcs/0002-multi-engine-bidi.md.",
      ),
    );
  }
}
