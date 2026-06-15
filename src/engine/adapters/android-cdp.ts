// AndroidCdpAdapter — the FOURTH BrowserEngine adapter. The
// surviving full-fidelity real-profile BYOB lane: real Chrome-on-Android attached
// over adb + CDP. The KEY property is that Android Chrome speaks FULL CDP, so this
// adapter:
//   - declares `deep: true` (ANDROID_CAPABILITIES) — every tool works, including
//     the CDP-deep ones (perf / coverage / heap / cpu / clock / CDP input);
//   - mints an eager CDP session on attach, just like the Chromium adapter;
//   - reuses the EXISTING CdpSnapshotSubstrate / CdpNetworkSubstrate verbatim
//     (the substrate selectors key on CDP presence, so Android falls into the
//     chromium-substrate path automatically — NO new substrate code).
//
// This is the smallest, lowest-risk adapter precisely because it adds no new
// substrate. The only genuinely new code is the adb plumbing (./adb.ts) — device
// discovery, socket forward, /json/version → wsUrl, port management, cleanup.
//
// ATTACH is the real path: discover the Chrome DevTools socket on a connected
// device (`adb forward tcp:<port> localabstract:chrome_devtools_remote`), GET
// http://127.0.0.1:<port>/json/version → webSocketDebuggerUrl, then
// `chromium.connectOverCDP(wsUrl)`. This attaches to the user's REAL Chrome-on-
// Android — the BYOB win. The forwarded socket is loopback (adb forwards to
// 127.0.0.1), so byob.ts's loopback / not-owned policy applies verbatim.
//
// connectOverCDP vs `playwright._android`: we PREFER connectOverCDP. Both reach
// the same CDP. `_android` is a separate experimental device API
// (`playwright._android.devices()` → `AndroidDevice`) that owns its own adb
// orchestration and returns a device-shaped object, NOT a `Browser`/`CDPSession`
// pair the rest of browxai is built on. connectOverCDP returns the exact
// `Browser` + `newCDPSession` handles the Chromium adapter already wires
// (attachOverCdp in playwright-chromium.ts), so the substrate selectors, the
// network tap, the a11y substrate, and teardown all work UNCHANGED. We keep the
// adb orchestration explicit (./adb.ts) rather than hand it to `_android`, which
// reuses the most existing code and keeps the seam at the same boundary as the
// desktop BYOB path. (Measured against the installed Playwright 1.60:
// `chromium.connectOverCDP` is a function; `_android` is an experimental device
// API, not a `connectOverCDP` substitute.)
//
// LAUNCH is not a thing on Android the same way: managed/ephemeral launch means
// "spawn a browser process we own", which on a phone the user controls makes no
// sense — the user opens Chrome on their device. So launch returns a structured
// `android-launch-not-supported`; Android is attach-only.

import type { Browser, CDPSession, Page } from "playwright-core";
import { resolveBrowserType } from "../select.js";
import { capabilitiesFor } from "../capabilities.js";
import type { EngineCapabilities, EngineKind } from "../types.js";
import {
  defaultAdbRunner,
  defaultFetcher,
  pickFreePort,
  devicesArgs,
  forwardArgs,
  forwardRemoveArgs,
  parseDevices,
  selectDevice,
  versionUrl,
  extractWsUrl,
  type AdbRunner,
  type Fetcher,
} from "./adb.js";

/** The handles an Android attach surfaces — the same shape as the Chromium
 *  adapter's (a `Browser` + an eager `CDPSession`), plus the bookkeeping the
 *  session layer needs to tear the adb forward down on close. */
export interface AndroidAttachHandles {
  browser: Browser;
  page: Page;
  cdp: CDPSession;
  /** The loopback port the device socket was forwarded to. */
  localPort: number;
  /** The device serial the forward was scoped to (for `forward --remove`). */
  serial: string;
  /** Tears down the adb forward (`adb forward --remove tcp:<port>`). Best-effort;
   *  resolves even if the device was unplugged (the forward dies with it). */
  removeForward(): Promise<void>;
}

/** Injectable dependencies — the IO seam. Defaults shell out to real adb + a real
 *  HTTP GET; the unit tests pass mocks so the orchestration is tested device-free. */
export interface AndroidAdapterDeps {
  runAdb?: AdbRunner;
  fetchJson?: Fetcher;
  pickPort?: () => Promise<number>;
}

export class AndroidCdpAdapter {
  readonly engine: EngineKind = "android";
  readonly capabilities: EngineCapabilities;
  private readonly runAdb: AdbRunner;
  private readonly fetchJson: Fetcher;
  private readonly pickPort: () => Promise<number>;

  constructor(deps: AndroidAdapterDeps = {}) {
    // android always has a declaration (see capabilities.ts).
    this.capabilities = capabilitiesFor("android")!;
    this.runAdb = deps.runAdb ?? defaultAdbRunner;
    this.fetchJson = deps.fetchJson ?? defaultFetcher;
    this.pickPort = deps.pickPort ?? pickFreePort;
  }

  /** Discover a ready device. Lists devices via adb, parses, and selects (the
   *  requested serial if given, else the single ready one — structured errors
   *  otherwise). Surfaces `adb-missing` / `no-device` without a device crash. */
  async discoverDevice(serial?: string): Promise<string> {
    const stdout = await this.runAdb(devicesArgs());
    const device = selectDevice(parseDevices(stdout), serial);
    return device.serial;
  }

  /** The real BYOB path: discover device → forward the Chrome DevTools socket to
   *  a free loopback port → GET /json/version → webSocketDebuggerUrl →
   *  `chromium.connectOverCDP(wsUrl)`. Returns the `Browser` + eager `CDPSession`
   *  the session layer wires its bookkeeping onto, exactly like the Chromium
   *  attach, plus the forward-teardown handle. On any failure after the forward
   *  is established, the forward is removed before the error propagates (no leaked
   *  adb forwards). */
  async attach(opts: { serial?: string } = {}): Promise<AndroidAttachHandles> {
    const serial = await this.discoverDevice(opts.serial);
    const localPort = await this.pickPort();
    await this.runAdb(forwardArgs(localPort, serial));

    const removeForward = async (): Promise<void> => {
      await this.runAdb(forwardRemoveArgs(localPort, serial)).catch(() => undefined);
    };

    try {
      const versionBody = await this.fetchJson(versionUrl(localPort));
      const wsUrl = extractWsUrl(versionBody);
      // `android` resolves to the chromium BrowserType — connectOverCDP returns
      // the exact Browser the desktop BYOB path uses (attachOverCdp), so the
      // eager CDP session, the substrates, and teardown all work unchanged.
      const browserType = resolveBrowserType(this.engine);
      const browser = await browserType.connectOverCDP(wsUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      const cdp = await context.newCDPSession(page);
      return { browser, page, cdp, localPort, serial, removeForward };
    } catch (err) {
      await removeForward();
      throw err;
    }
  }

  /** Managed / ephemeral LAUNCH is not supported on Android. A phone's Chrome is
   *  the user's to open; browxai cannot spawn a browser process it owns on the
   *  device. Per the doctrine's no-silent-no-op rule this rejects with a
   *  structured, RFC-naming error rather than pretending. Promise-returning (not
   *  `async`) so the eslint require-await rule is honest — there is no awaited
   *  work, it is a structured refusal. */
  launch(): Promise<never> {
    return Promise.reject(
      new Error(
        "android-launch-not-supported: the android engine is ATTACH-ONLY. managed / ephemeral " +
          "launch means spawning a browser process browxai owns, which is not a thing on a phone " +
          "the user controls — the user opens Chrome on their device, and browxai attaches over " +
          'adb + CDP. Open the session with mode:"attached" (BROWX_ATTACH_CDP ' +
          "is loopback-enforced; the adb forward is loopback by construction).",
      ),
    );
  }
}
