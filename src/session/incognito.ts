// Incognito launch. A fresh Chromium process + an *ephemeral*
// BrowserContext: no profile dir, nothing persisted to disk, everything
// (cookies, storage, cache) discarded on close. Same safe-by-default flags as
// managed (no `--disable-web-security`, sandbox on). Use for one-off agentic
// driving where you explicitly do NOT want a profile trace.
//
// The no-trace consumer-repo contract is unaffected — there was never any
// consumer-cwd write; incognito additionally leaves no Chrome profile behind.

import { chromium } from "playwright-core";
import { log } from "../util/logging.js";
import type { BrowserSession, SessionOptions } from "./types.js";

export async function openIncognitoSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  log.info("session.incognito: launching ephemeral browser", { headless: !!opts.headless });
  // opt-in web-security-off (off by default; loud per-launch warning).
  const insecureArgs: string[] = [];
  if (opts.disableWebSecurity) {
    insecureArgs.push("--disable-web-security", "--disable-site-isolation-trials");
    log.warn(
      "⚠  session.incognito: disableWebSecurity is ON — launching with --disable-web-security. " +
        "SOP/CORS is OFF for the whole browser session. Use only against test/dev targets.",
    );
  }
  const browser = await chromium.launch({
    headless: !!opts.headless,
    // No lowered-security flags unless the gated flag is explicitly on.
    ...(insecureArgs.length ? { args: insecureArgs } : {}),
  });
  const context = await browser.newContext({
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
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  let closed = false;
  return {
    mode: "managed", // BrowserSession.mode is the coarse owned/not-owned axis;
    // the fine-grained "incognito" label lives on SessionEntry.mode. We own it.
    ownsBrowser: true,
    page: () => page,
    cdp: () => cdp,
    close: async () => {
      if (closed) return;
      closed = true;
      log.info("session.incognito: closing (ephemeral context + browser discarded)");
      await cdp.detach().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
