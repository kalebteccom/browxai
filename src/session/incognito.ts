// Incognito launch. A fresh Chromium process + an *ephemeral*
// BrowserContext: no profile dir, nothing persisted to disk, everything
// (cookies, storage, cache) discarded on close. Same safe-by-default flags as
// managed (no `--disable-web-security`, sandbox on). Use for one-off agentic
// driving where you explicitly do NOT want a profile trace.
//
// The no-trace consumer-repo contract is unaffected — there was never any
// consumer-cwd write; incognito additionally leaves no Chrome profile behind.

import { log } from "../util/logging.js";
import {
  AndroidCdpAdapter,
  PlaywrightChromiumAdapter,
  PlaywrightFirefoxAdapter,
  PlaywrightWebKitAdapter,
  firefoxChannelFromEnv,
  type EngineKind,
} from "../engine/index.js";
import type { BrowserSession, SessionOptions } from "./types.js";

export async function openIncognitoSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const engine: EngineKind = opts.browserType ?? "chromium";
  // android is ATTACH-ONLY — ephemeral launch (spawning a browser we own) is not
  // a thing on the user's phone. Surface the structured refusal.
  if (engine === "android") {
    await new AndroidCdpAdapter().launch();
  }
  // safari runs ISOLATED automation windows via the default managed session
  // (safaridriver already isolates each session — no cookies/storage from a real
  // profile). Incognito (a separate in-browser context) is a Playwright concept
  // safaridriver has no equivalent for, so refuse rather than silently launch a
  // managed window the caller didn't ask for.
  if (engine === "safari") {
    throw new Error(
      "safari-incognito-not-supported: the safari engine runs isolated automation windows via the " +
        "default managed session (safaridriver isolates each session by construction). Incognito (a " +
        "separate browser context) is a Playwright concept safaridriver has no equivalent for. Open a " +
        "managed session instead.",
    );
  }
  log.info("session.incognito: launching ephemeral browser", {
    headless: !!opts.headless,
    engine,
  });
  // opt-in web-security-off (off by default; loud per-launch warning). The
  // --disable-* flag form is Chromium-only; on the firefox engine we warn
  // rather than silently apply a flag Firefox doesn't accept.
  const insecureArgs: string[] = [];
  if (opts.disableWebSecurity) {
    if (engine !== "chromium") {
      log.warn(
        `⚠  session.incognito: disableWebSecurity is not wired on the ${engine} engine — ` +
          "the --disable-web-security flag form is Chromium-only. Launching with SOP/CORS ON.",
      );
    } else {
      insecureArgs.push("--disable-web-security", "--disable-site-isolation-trials");
      log.warn(
        "⚠  session.incognito: disableWebSecurity is ON — launching with --disable-web-security. " +
          "SOP/CORS is OFF for the whole browser session. Use only against test/dev targets.",
      );
    }
  }
  const contextOptions = {
    ...(opts.device ?? {}),
    // Accept downloads at the context level so the per-session
    // `DownloadsRegistry` (off-by-default) can intercept them on demand.
    // The registry discards artefacts when capture is off — `acceptDownloads`
    // being true is purely the prerequisite for Playwright to emit the
    // `download` event that the registry's listener hangs off.
    acceptDownloads: true,
    // Seed the ephemeral context with a storage state if one was supplied
    // (the Playwright-native primitive for "open a fresh browser already
    // logged in as X"). No-op when unset.
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
    // HAR recording at context creation (native Playwright primitive).
    // Finalized on context.close(). No-op when unset.
    ...(opts.recordHar ? { recordHar: opts.recordHar } : {}),
    // Video recording at context creation (native Playwright primitive).
    // Finalized on context.close(). The dir is workspace-rooted by
    // construction; the registry's teardown calls
    // `page.video().saveAs(targetPath)` for a deterministic filename.
    ...(opts.recordVideo ? { recordVideo: opts.recordVideo } : {}),
  };

  let browser;
  let context;
  let page;
  let cdp;
  if (engine === "firefox") {
    const adapter = new PlaywrightFirefoxAdapter({ channel: firefoxChannelFromEnv() });
    ({ browser, context, page } = await adapter.launchEphemeral({
      launchOptions: { headless: !!opts.headless },
      contextOptions,
    }));
  } else if (engine === "webkit") {
    // WebKit ephemeral launch + context — no CDP, no Chromium `--` args.
    const adapter = new PlaywrightWebKitAdapter();
    ({ browser, context, page } = await adapter.launchEphemeral({
      launchOptions: { headless: !!opts.headless },
      contextOptions,
    }));
  } else {
    const adapter = new PlaywrightChromiumAdapter();
    ({ browser, context, page, cdp } = await adapter.launchEphemeral({
      launchOptions: {
        headless: !!opts.headless,
        // No lowered-security flags unless the gated flag is explicitly on.
        ...(insecureArgs.length ? { args: insecureArgs } : {}),
      },
      contextOptions,
    }));
  }

  const cdpHandle = cdp;
  let closed = false;
  return {
    mode: "managed", // BrowserSession.mode is the coarse owned/not-owned axis;
    // the fine-grained "incognito" label lives on SessionEntry.mode. We own it.
    ownsBrowser: true,
    engine,
    page: () => page,
    // chromium mints a CDP session; firefox has none (`cdp` stays absent).
    ...(cdpHandle ? { cdp: () => cdpHandle } : {}),
    close: async () => {
      if (closed) return;
      closed = true;
      log.info("session.incognito: closing (ephemeral context + browser discarded)");
      if (cdpHandle) await cdpHandle.detach().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    },
  };
}
