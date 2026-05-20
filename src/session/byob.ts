// BYOB / CDP-attach session — .
// Off by default; the canonical entrypoint must opt in via BROWX_ATTACH_CDP=<loopback>.
// Loopback-only (127.0.0.1 / localhost / ::1) — refuses non-loopback hosts.
// Not-owned semantics: on close we detach the CDP session, but never close the
// browser or reset its storage — that's the consumer's Chrome, not ours.

import { chromium } from "playwright-core";
import { log } from "../util/logging.js";
import type { BrowserSession, SessionOptions } from "./types.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLoopback(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`BROWX_ATTACH_CDP: invalid URL "${endpoint}"`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `BROWX_ATTACH_CDP: refusing non-loopback host "${url.hostname}". ` +
        `Only 127.0.0.1, localhost, ::1 are allowed (CDP port is unauthenticated).`,
    );
  }
  return url;
}

const ATTACH_WARNING = [
  "================================================================",
  "  browxai is attaching to an EXTERNAL Chrome over CDP (BYOB).",
  "  This Chrome is treated as NOT-OWNED: on shutdown browxai detaches",
  "  but does NOT close the browser or reset its storage.",
  "",
  "  Sharp edges (you accepted these by setting BROWX_ATTACH_CDP):",
  "  - The browser may have --disable-web-security (SOP off).",
  "  - The browser holds your real profile: every cookie, password,",
  "    and authed tab is in scope of any page the agent visits.",
  "  - The CDP port is unauthenticated; any local process can attach.",
  "",
  "  Managed mode (the default) avoids all of the above. See docs/threat-model.md.",
  "================================================================",
].join("\n");

export async function openByobSession(opts: SessionOptions & { attachCdp: string }): Promise<BrowserSession> {
  const url = assertLoopback(opts.attachCdp);
  log.warn(ATTACH_WARNING);
  log.info("session.byob: attaching", { endpoint: url.toString(), owner: "external" });

  const browser = await chromium.connectOverCDP(url.toString());
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);

  // ensure the attached page reports a usable viewport so the
  // visible-rect bbox path (page/bbox.ts) doesn't intersect against `innerWidth=0
  // innerHeight=0` and produce `null + clipped: true` for every visible element.
  //
  // Strategy:
  //   1. Read the *layout* viewport via CDP `Page.getLayoutMetrics` — that's the
  //      authoritative size regardless of what `window.innerWidth/innerHeight`
  //      reports (the attached page may pre-paint with zero metrics).
  //   2. Cross-check against `Runtime.evaluate` reading window dims.
  //   3. If layout viewport is zero OR the window dims read as zero, install a
  //      1280x800 default via Emulation.setDeviceMetricsOverride.
  try {
    const layout = await cdp.send("Page.getLayoutMetrics").catch(() => null) as
      | { layoutViewport?: { clientWidth: number; clientHeight: number } }
      | null;
    const lw = layout?.layoutViewport?.clientWidth ?? 0;
    const lh = layout?.layoutViewport?.clientHeight ?? 0;
    const { result } = (await cdp.send("Runtime.evaluate", {
      expression: "({ w: window.innerWidth || 0, h: window.innerHeight || 0 })",
      returnByValue: true,
    })) as { result: { value?: { w: number; h: number } } };
    const v = result.value ?? { w: 0, h: 0 };
    const goodLayout = lw > 0 && lh > 0;
    const goodWindow = v.w > 0 && v.h > 0;
    if (!goodLayout && !goodWindow) {
      log.info("session.byob: attached page has zero viewport on both layout + window probes; setting 1280x800 default", { layout: { lw, lh }, window: v });
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 800,
        deviceScaleFactor: 0,
        mobile: false,
      }).catch(() => undefined);
    } else {
      log.info("session.byob: attached page viewport ok", { layout: { lw, lh }, window: v });
    }
  } catch {
    /* not fatal — the bbox path falls back to un-clipped client rect when both probes fail */
  }

  let closed = false;
  return {
    mode: "byob",
    ownsBrowser: false,
    page: () => page,
    cdp: () => cdp,
    close: async () => {
      if (closed) return;
      closed = true;
      log.info("session.byob: detaching (browser stays open — not-owned)");
      await cdp.detach().catch(() => undefined);
      // Do NOT call browser.close() / context.close() — not-owned.
    },
  };
}
