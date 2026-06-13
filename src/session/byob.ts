// BYOB / CDP-attach session — .
// Off by default; the canonical entrypoint must opt in via BROWX_ATTACH_CDP=<loopback>.
// Loopback-only (127.0.0.1 / localhost / ::1) — refuses non-loopback hosts.
// Not-owned semantics: on close we detach the CDP session, but never close the
// browser or reset its storage — that's the consumer's Chrome, not ours.

import type { CDPSession } from "playwright-core";
import { log } from "../util/logging.js";
import {
  AndroidCdpAdapter,
  PlaywrightChromiumAdapter,
  PlaywrightFirefoxAdapter,
  PlaywrightWebKitAdapter,
  type EngineKind,
} from "../engine/index.js";
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

// The attached page may pre-paint with zero metrics; ensure a usable viewport so
// the visible-rect bbox path (page/bbox.ts) doesn't intersect against
// `innerWidth=0 innerHeight=0` and produce `null + clipped: true` for every
// visible element. Read the *layout* viewport via CDP (authoritative regardless
// of `window.inner*`), cross-check the window dims, and install a 1280x800
// default only if BOTH read as zero. Shared by the desktop-CDP attach and the
// Android-over-adb attach — both ride a real CDPSession. Best-effort; a failure
// is non-fatal (bbox falls back to the un-clipped client rect).
async function ensureViewport(cdp: CDPSession): Promise<void> {
  try {
    const layout = (await cdp.send("Page.getLayoutMetrics").catch(() => null)) as {
      layoutViewport?: { clientWidth: number; clientHeight: number };
    } | null;
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
      log.info("session.byob: attached page has zero viewport; setting 1280x800 default", {
        layout: { lw, lh },
        window: v,
      });
      await cdp
        .send("Emulation.setDeviceMetricsOverride", {
          width: 1280,
          height: 800,
          deviceScaleFactor: 0,
          mobile: false,
        })
        .catch(() => undefined);
    } else {
      log.info("session.byob: attached page viewport ok", { layout: { lw, lh }, window: v });
    }
  } catch {
    /* not fatal — the bbox path falls back to un-clipped client rect when both probes fail */
  }
}

const ANDROID_ATTACH_WARNING = [
  "================================================================",
  "  browxai is attaching to your REAL Chrome-on-Android over adb + CDP.",
  "  This is the full-fidelity BYOB lane (RFC 0002 D3/D8): the device's",
  "  Chrome is treated as NOT-OWNED — on shutdown browxai detaches and",
  "  removes the adb forward, but never closes the browser or resets its",
  "  storage. The phone holds your real profile: every cookie, password,",
  "  and authed tab is in scope of any page the agent visits.",
  "  Managed mode (the default) avoids all of the above. See docs/threat-model.md.",
  "================================================================",
].join("\n");

/** Android BYOB — discover real Chrome-on-Android over adb + CDP and attach.
 *  Distinct from the desktop URL-attach path: the endpoint is DISCOVERED
 *  (adb forward → /json/version → wsUrl), not configured. The forwarded socket is
 *  loopback by construction (adb forwards to 127.0.0.1), so the same not-owned
 *  policy applies; close additionally removes the adb forward. Full CDP, so the
 *  session carries `cdp()` and the substrates pick the CDP path automatically. */
async function openAndroidByobSession(opts: SessionOptions): Promise<BrowserSession> {
  log.warn(ANDROID_ATTACH_WARNING);
  const adapter = new AndroidCdpAdapter();
  const serial = process.env.BROWX_ANDROID_SERIAL?.trim() || undefined;
  const { page, cdp, localPort, serial: usedSerial, removeForward } = await adapter.attach({
    serial,
  });
  log.info("session.byob: attached to Chrome-on-Android", {
    serial: usedSerial,
    localPort,
    engine: "android",
  });
  await ensureViewport(cdp);

  let closed = false;
  return {
    mode: "byob",
    ownsBrowser: false,
    engine: "android",
    page: () => page,
    // Android Chrome speaks full CDP — the eager session is always present.
    cdp: () => cdp,
    close: async () => {
      if (closed) return;
      closed = true;
      log.info("session.byob: detaching Chrome-on-Android (device stays open — not-owned)");
      await cdp.detach().catch(() => undefined);
      await removeForward();
      // Do NOT call browser.close() — not-owned (it's the user's phone Chrome).
    },
  };
}

export async function openByobSession(
  opts: SessionOptions & { attachCdp?: string },
): Promise<BrowserSession> {
  const engine: EngineKind = opts.browserType ?? "chromium";
  // Android attach is endpoint-DISCOVERED (adb), not URL-configured — it does not
  // take BROWX_ATTACH_CDP. Route it before the loopback-URL assertion below.
  if (engine === "android") {
    return openAndroidByobSession(opts);
  }
  if (!opts.attachCdp) {
    throw new Error(
      "session.byob: the CDP-attach lane requires BROWX_ATTACH_CDP (a loopback CDP endpoint). " +
        'For the android engine use browserType:"android" (endpoint discovered over adb). ' +
        "See docs/rfcs/0002-multi-engine-bidi.md.",
    );
  }
  const url = assertLoopback(opts.attachCdp);
  // The loopback / not-owned policy above + below is protocol-neutral and reused
  // verbatim; only the transport hop (CDP-attach) is engine-specific. The
  // Firefox attach model is a glass-box LAUNCH over BiDi, not CDP-attach (RFC
  // D3) — and Playwright has no `connectOverBiDi` for a user's running Firefox.
  // Surface the structured `firefox-attach-not-supported` error (no silent
  // fail) before the CDP-attach body, which is Chromium-only by nature.
  if (engine === "firefox") {
    await new PlaywrightFirefoxAdapter().attach(url.toString());
  }
  if (engine === "webkit") {
    // WebKit has no CDP/BiDi attach client (Safari has not shipped BiDi as of
    // June 2026, and safaridriver hard-isolates automation — attach-to-live is
    // impossible by design, RFC D7). Surface the structured
    // `webkit-attach-not-supported` error before the CDP-attach body, which is
    // Chromium-only by nature.
    await new PlaywrightWebKitAdapter().attach(url.toString());
  }
  log.warn(ATTACH_WARNING);
  log.info("session.byob: attaching", { endpoint: url.toString(), owner: "external", engine });

  const adapter = new PlaywrightChromiumAdapter();
  const { page, cdp } = await adapter.attachOverCdp(url.toString());

  await ensureViewport(cdp);

  let closed = false;
  return {
    mode: "byob",
    ownsBrowser: false,
    engine,
    page: () => page,
    // chromium always mints a CDP session; `cdp` is non-undefined here.
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
