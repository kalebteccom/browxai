// Incognito launch (Phase 2.5). A fresh Chromium process + an *ephemeral*
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
  const browser = await chromium.launch({
    headless: !!opts.headless,
    // No lowered-security flags — same posture as managed.
  });
  const context = await browser.newContext({ ...(opts.device ?? {}) });
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
