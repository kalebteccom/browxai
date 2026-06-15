// PlaywrightFirefoxAdapter — the second BrowserEngine adapter, the proof the
// port generalizes to a second engine. It mirrors PlaywrightChromiumAdapter's
// three launch shapes over `resolveBrowserType("firefox")` (Playwright's bundled
// Juggler Firefox, the default supported lane) — but it mints NO eager CDP
// session: `newCDPSession` throws on Firefox (measured), and Firefox declares
// `deep: false`, so the raw-CDP escape hatch is absent. Sessions on this engine
// run the cross-browser surface; the ~19 CDP-hard tools structured-refuse via
// the engine gate (src/engine/tool-gate.ts).
//
// Dependency direction (architecture doctrine): port → adapter → Playwright.
// The adapter delegates directly to Playwright on the per-action path exactly
// like the chromium one — no added allocation on the hot path.
//
// Two-track design: the default lane is Juggler (full Playwright API — routes,
// video, HAR — so the ~139 class-A tools are real). The experimental stock-
// Firefox `moz-firefox` BiDi channel rides behind `BROWX_FIREFOX_CHANNEL`
// (see firefoxChannelFromEnv); it is NOT gated by the keystone. Measured against
// the installed Playwright: the channel IS recognised (it launches a real BiDi
// session against stock Firefox) but the session immediately hits a Mozilla-side
// BiDi gap (`network.addDataCollector: unknown command`) — the M20 streaming /
// network gaps the research predicted. So the flag is wired and the channel
// resolves; stock-Firefox-BiDi is just not usable for browxai's surface yet.
// Flip the default to this lane when Mozilla M20 closes.

import type { BrowserContextOptions, LaunchOptions } from "playwright-core";
import { resolveBrowserType } from "../select.js";
import { capabilitiesFor } from "../capabilities.js";
import type { EngineCapabilities, EngineKind, EngineLaunchHandles } from "../types.js";

/** Persistent (managed) launch spec — the subset the managed factory passes to
 *  `launchPersistentContext`. Same shape as the chromium adapter's so the
 *  session factories thread one spec regardless of engine. */
export interface FirefoxPersistentLaunchSpec {
  profileDir: string;
  options: Parameters<ReturnType<typeof resolveBrowserType>["launchPersistentContext"]>[1];
}

/** Ephemeral (incognito) launch spec — a `launch` + `newContext` pair. */
export interface FirefoxEphemeralLaunchSpec {
  launchOptions: LaunchOptions;
  contextOptions: BrowserContextOptions;
}

/** The experimental stock-Firefox BiDi channel name (Playwright `channel`).
 *  Selected via `BROWX_FIREFOX_CHANNEL=moz-firefox`. */
export const MOZ_FIREFOX_CHANNEL = "moz-firefox";

/** Resolve the optional `BROWX_FIREFOX_CHANNEL` flag. Returns the channel string
 *  to pass to Playwright's `launch`/`launchPersistentContext`, or undefined for
 *  the default Juggler lane. Only `moz-firefox` is recognised; any other value
 *  is rejected loudly (no silent fallback). */
export function firefoxChannelFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.BROWX_FIREFOX_CHANNEL?.trim();
  if (!raw) return undefined;
  if (raw !== MOZ_FIREFOX_CHANNEL) {
    throw new Error(
      `BROWX_FIREFOX_CHANNEL: unknown value "${raw}". The only supported value is ` +
        `"${MOZ_FIREFOX_CHANNEL}" (the experimental stock-Firefox WebDriver-BiDi channel). ` +
        "Unset it for the default bundled-Juggler lane.",
    );
  }
  return MOZ_FIREFOX_CHANNEL;
}

/** The Firefox engine adapter. One instance per launch; it owns engine
 *  selection and surfaces the handles the session layer wires its bookkeeping
 *  onto. Unlike the chromium adapter it carries no `cdp` on its handles —
 *  Firefox has no CDP escape hatch. */
export class PlaywrightFirefoxAdapter {
  readonly engine: EngineKind = "firefox";
  readonly capabilities: EngineCapabilities;
  private readonly channel: string | undefined;

  constructor(opts: { channel?: string } = {}) {
    // firefox always has a declaration (see capabilities.ts).
    this.capabilities = capabilitiesFor("firefox")!;
    this.channel = opts.channel;
  }

  /** Persistent-profile launch — wraps `launchPersistentContext`. No eager CDP
   *  session (Firefox has none). Mirrors the chromium adapter's shape. */
  async launchPersistent(spec: FirefoxPersistentLaunchSpec): Promise<EngineLaunchHandles> {
    const browserType = resolveBrowserType(this.engine);
    const options = this.withChannel(spec.options);
    const context = await browserType.launchPersistentContext(spec.profileDir, options);
    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page };
  }

  /** Ephemeral launch — wraps `launch` + `newContext`. No eager CDP session. */
  async launchEphemeral(spec: FirefoxEphemeralLaunchSpec): Promise<EngineLaunchHandles> {
    const browserType = resolveBrowserType(this.engine);
    const browser = await browserType.launch(this.withChannel(spec.launchOptions));
    const context = await browser.newContext(spec.contextOptions);
    const page = await context.newPage();
    return { browser, context, page };
  }

  /** BYOB attach. The Firefox attach model is a glass-box LAUNCH of
   *  the user's real profile with `--remote-debugging-port`, NOT a CDP-attach —
   *  and Playwright has no public `connectOverBiDi` for a user's running
   *  Firefox. Until a BiDi attach client exists this rejects with a structured,
   *  explanatory error rather than silently failing (the doctrine's
   *  no-silent-no-op rule). The `BROWX_ATTACH_BIDI` name is reserved for it.
   *  Promise-returning (not `async`) so the eslint require-await rule is honest:
   *  there is no awaited work — it is a structured refusal. */
  attach(_endpoint: string): Promise<EngineLaunchHandles> {
    return Promise.reject(
      new Error(
        "firefox-attach-not-supported: browxai cannot attach to a running Firefox over CDP. " +
          "Firefox removed CDP in v141; the forward path is WebDriver BiDi, and Playwright has no " +
          "public `connectOverBiDi` for a user's running Firefox yet (the `BROWX_ATTACH_BIDI` name " +
          "is reserved for it). The Firefox BYOB model is a glass-box LAUNCH of the " +
          "real profile with `--remote-debugging-port`, subject to the profile lock. Use a managed " +
          "Firefox session (the default), or a chromium session for CDP-attach BYOB.",
      ),
    );
  }

  /** Splice the optional `moz-firefox` BiDi channel into a launch options bag.
   *  No-op for the default Juggler lane. */
  private withChannel<T extends { channel?: string } | undefined>(options: T): T {
    if (!this.channel) return options;
    return { ...(options ?? {}), channel: this.channel } as T;
  }
}
