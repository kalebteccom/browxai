# Browser-Automation Ecosystem & Engine-Strategy Landscape — June 2026

**Prepared for:** browxai (Playwright/CDP-based MCP browser bridge, ~200 curated tools) — evaluating Firefox / Safari / mobile coverage paths.
**Research date:** 2026-06-13. All claims dated where the source allows. Confidence flags: [HIGH] primary source, [MED] secondary/vendor blog, [LOW] SEO-grade or unverified.

---

## 0. Executive framing

The ecosystem in mid-2026 has settled into a **two-protocol world**:

- **CDP** remains the *depth* protocol — Chromium-only (plus Electron, Android Chrome/WebView), with the agentic-browser crowd (browser-use et al.) actually moving *down* the stack to raw CDP for performance.
- **WebDriver BiDi** is the *breadth* protocol — GA in Firefox (since Fx129/Puppeteer 23, Aug 2024), shipping in Chrome behind the `chromium-bidi` mapper, **experimental in upstream WebKit (GTK/WPE since 2.47.4, Feb 2025)**, default in WebdriverIO v9, expanding every Selenium 4.x release, supported on BrowserStack Automate, and — the headline change for browxai — now exposed by **Playwright as `moz-firefox*` channels that drive STOCK Firefox**, surfaced through Playwright MCP in June 2026.

Real Safari (desktop + iOS) remains the one engine with **no CDP and no BiDi**: it speaks only W3C WebDriver classic via `safaridriver`, plus Apple's private WebKit Remote Inspector protocol (usbmux / iOS 17+ RemoteXPC tunnels). Appium 3 is the heaviest but most complete wrapper for that lane; its own BiDi surface is events-only, not a command protocol.

---

## 1. Playwright protocol strategy (as of v1.60, May 2026)

### 1.1 Current protocol stack

| Engine | Bundled build | Protocol | Stock-browser option |
|---|---|---|---|
| Chromium 148 (v1.60) | Playwright Chromium build | CDP | Yes — `channel: 'chrome' / 'msedge' / *-beta/dev/canary'`, and `connectOverCDP()` to any running Chromium [HIGH] |
| Firefox 150.0.2 (v1.60) | **Patched** build ("Juggler" remote protocol) | Juggler (custom) | Historically NO — "Playwright doesn't work with the branded version of Firefox since it relies on patches" (playwright.dev/docs/browsers) [HIGH]. NEW: `moz-firefox*` BiDi channels drive stock Firefox (experimental) [HIGH] |
| WebKit 26.4 (v1.60) | **Custom** WebKit build | Custom WebKit protocol (layered on WebKit remote inspector) | NO — "Playwright doesn't work with the branded version of Safari since it relies on patches" [HIGH] |

Sources: https://playwright.dev/docs/browsers ; https://playwright.dev/docs/release-notes (v1.60, released 2026-05-11 per https://currents.dev/posts/pw-1.60.0 [MED]).

### 1.2 The BiDi channels — current names and state

- Internal implementation lives in `packages/playwright-core/src/server/bidi/` (`bidiChromium.ts`, `bidiFirefox.ts`); the BidiChromium BrowserType registers protocol id `'bidi'`. [HIGH] (https://fossies.org/linux/playwright/packages/playwright-core/src/server/bidi/bidiChromium.ts)
- **Current channel names (June 2026): `moz-firefox`, `moz-firefox-beta`, `moz-firefox-nightly`** — `Firefox.launch` branches on `channel.startsWith('moz-')` to route through WebDriver BiDi. These succeeded the earlier `_bidiFirefox`/`_bidiChromium` experiment names. [HIGH]
- **Playwright MCP exposed them via `--browser moz-firefox`** in microsoft/playwright#41126, **merged 2026-06-08**, released in playwright-mcp v0.0.76 (release notes: "support moz-firefox BiDi channels", plus `remoteEndpoint` ConnectOptions / `remoteHeaders`). [HIGH] (https://github.com/microsoft/playwright/pull/41126 ; https://github.com/microsoft/playwright-mcp/releases)
- The BiDi test harness (`tests/bidi/README.md`) runs `npm run biditest -- --project='moz-firefox-*'` and points `BIDI_FFPATH` at a **stock Firefox downloaded via `@puppeteer/browsers`** — i.e., Playwright-over-BiDi targets *unpatched, vanilla Firefox*. `BIDI_CRPATH` exists for Chromium-over-BiDi testing. [HIGH] (https://github.com/microsoft/playwright/blob/main/tests/bidi/README.md)

### 1.3 What works / what's missing

- Tracking issue microsoft/playwright#32577 ("Current limitations blocking Playwright's WebDriver BiDi adoption", opened 2024-09-12) lists pass rates at filing: **Chromium 2,368/3,877 (61%), Firefox 1,469/3,877 (38%)** — substantially improved since, but the issue remains open as of June 2026. [HIGH] (https://github.com/microsoft/playwright/issues/32577)
- Spec/implementation gaps Playwright cites: per-context proxy/cert config, viewport-before-load for popups, content quads for transformed-element clicks, node↔frame handle conversion, navigation-commit events, request/response body access, resourceType, download body retrieval, locale/timezone/UA emulation (since largely landed in Firefox — see below), extra headers, per-context init scripts, offline mode, JS-disable, CSP bypass, screencast. [HIGH]
- Mozilla side: meta-bug 1917540 "[meta] Support WebDriver BiDi in Playwright" — **26 dependent bugs resolved, 11 open** as of late May 2026 (recent activity "16 days ago" at fetch on 2026-06-13); remaining clusters: emulation meta-tasks (geolocation/timezone/locale/screen/touch), **screen casting start/stop**, origin checks for shared references, CI integration for Playwright runs. [HIGH] (https://bugzilla.mozilla.org/show_bug.cgi?id=1917540)
- MozillaWiki status page: Milestones 1–19 complete (Sep 2021 → Mar 2026); **Milestone 20 "in development"**: streaming support, WebSocket events, element scrolling, download tracking, screen-recording commands, CSP-disable command — explicitly framed as the Playwright-enablement milestone. [HIGH] (https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi)
- Playwright maintainer stance (yury-s, w3c/webdriver-bidi#769): consolidating blockers, "open to arranging" external contributors to accelerate — i.e., BiDi is a real but **not-yet-default** path; the official line remains that the switch will happen "automatically in a future version once the protocol is mature enough to support all of Playwright's features." [HIGH]

**Verdict:** Yes — BiDi is becoming Playwright's *vanilla-browser* path, starting with stock Firefox (`moz-firefox*`). It is experimental, not channel-default; the bundled patched-Firefox (Juggler) and custom-WebKit builds remain the supported mainline through at least 2026. No `moz-`-equivalent exists for WebKit/Safari.

### 1.4 playwright-webkit vs real Safari — differences that matter

- Playwright's WebKit is built from near-tip WebKit `main` (can be *ahead* of shipping Safari; v1.60 bundles "WebKit 26.4"); real Safari ships on Apple's release train. [HIGH]
- Missing vs real Safari: Safari app layer (ITP UI/heuristics as shipped, AutoFill, extensions, Apple Pay, Lockdown Mode, content blockers), Apple's GPU/media pipeline on macOS hardware (Linux/Windows WebKit ports use different graphics/media stacks), real-device performance/memory behavior, OS-level policies. BrowserStack/LambdaTest both market "Playwright on REAL iOS Safari" device offerings (BrowserStack announcement; LambdaTest 2025-07-09) precisely because of this gap. [MED] (https://www.browserstack.com/guide/playwright-safari ; https://www.browserstack.com/guide/playwright-ios-automation)
- Practical consensus: WebKit build catches most engine/standards regressions; it does not catch Safari-version-specific, device-specific, or Apple-integration bugs. [MED]

---

## 2. Puppeteer (v25.1.0, released 2026-05-26)

- **Firefox via BiDi is GA since v23.0.0 (Aug 2024)** — announced alongside Firefox 129; "WebDriver BiDi production-ready in Firefox, Chrome and Puppeteer" (Chrome dev blog, 2024-08-07). Default protocol for Firefox from v24. Downloads **stock Firefox stable** (no patched build). [HIGH] (https://developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi ; https://pptr.dev/webdriver-bidi)
- **CDP-for-Firefox removed**: deprecated in Fx129, removal landed via puppeteer/puppeteer#13427 ("refactor!: remove support for Firefox over CDP"). Firefox cannot be driven over CDP by Puppeteer anymore; Selenium likewise removed Firefox-CDP (selenium.dev blog, 2025). [HIGH] (https://github.com/puppeteer/puppeteer/pull/13427 ; https://www.selenium.dev/blog/2025/remove-cdp-firefox/ ; https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/)
- **Chrome default remains CDP**; BiDi is opt-in via `protocol: 'webDriverBiDi'`. [HIGH]
- **BiDi feature set (per pptr.dev/webdriver-bidi, v25.x):** works — navigation, script eval, locators (except ARIA selector), input, dialogs, screenshots, PDF, permissions, timezone emulation, request interception. **Missing over BiDi** — CPU throttling, media/vision-deficiency emulation, extensions APIs, accessibility tree scanning, JS/CSS coverage, tracing, service-worker controls, drag-and-drop, offline mode, detailed response-content handling; unsupported features throw `UnsupportedOperation`. [HIGH]
- Net: Puppeteer is the **most mature stock-Firefox-over-BiDi client** in the ecosystem, and its documented BiDi gap list is the best public map of "what BiDi still can't do vs CDP."

---

## 3. Selenium 4.x (4.40, 2026) and WebdriverIO v9

### Selenium
- **Latest GA: Selenium 4.40 (2026)**; 4.36–4.40 release notes show steady BiDi expansion: new events/modules across Java/Python/.NET/Ruby (`downloadEnd`, navigation, cookies, network collectors, WebExtensions module, `setScreenOrientationOverride`, `setNetworkConditions`, emulation improvements). Enable via `webSocketUrl: true` capability. [HIGH] (https://www.selenium.dev/blog/2026/selenium-4-40-released/ ; https://www.selenium.dev/documentation/webdriver/bidi/)
- Official docs still describe BiDi availability as "limited fashion", with **CDP explicitly positioned as a temporary bridge** "until WebDriver BiDi has been implemented." [HIGH]
- **Selenium 5: NOT GA as of June 2026.** Third-party blogs describe teams "selectively piloting Selenium 5 previews" while production stays on 4.x — treat any "Selenium 5 has fully embraced BiDi" claim as forward-looking marketing. [LOW→MED] (https://www.credosystemz.com/blog/future-of-selenium-2026/ ; https://www.ideas2it.com/blogs/selenium-evolution-of-qa)
- Production reports: BiDi used mainly for console/network event capture and basic interception; classic WebDriver remains the action path. Cloud-grid availability (BrowserStack `seleniumBidi`) is the practical gate. [MED]

### WebdriverIO
- **v9 (released 2024-08-15) made BiDi the DEFAULT session protocol**; opt-out via `wdio:enforceWebDriverClassic`. Real-time network interception, console events, DOM mutation hooks without polling. Caveat reported in production: features silently unavailable when the remote/cloud endpoint lacks BiDi. [HIGH] (https://webdriver.io/blog/2024/08/15/webdriverio-v9-release/ ; https://webdriver.io/docs/automationProtocols/)
- WebdriverIO is currently the **largest production BiDi deployment surface** (default-on for two years).

---

## 4. APPIUM — deep lane

### 4.1 Appium 3 architecture (GA; latest 3.2.2 as of March 2026)

- Appium 3 is a **modest upgrade over Appium 2** (vs the 1→2 rewrite): same decoupled driver/plugin model; Node `^20.19.0 || ^22.12.0 || >=24`; npm ≥10; Express 5 internally; **JSONWP fully removed** (W3C-only endpoints); ~70+ deprecated endpoints deleted; mandatory scope prefixes on `--allow-insecure` (e.g. `uiautomator2:adb_shell`); `GET /appium/sessions` behind `session_discovery` feature flag. Quarterly releases (Jan/Apr/Jul/Oct). [HIGH] (https://appium.io/docs/en/3.1/guides/migrating-2-to-3/ ; https://www.testmuai.com/latest-version/appium-latest-version/ [MED])
- **Driver roster (officially maintained):** UiAutomator2 (Android native+hybrid, wraps a device-side UIA2 server + chromedriver for webviews), XCUITest (iOS/iPadOS/tvOS via WebDriverAgent), Espresso (Android, actively maintained — v8.4.1 released 2026-05-12), Mac2 (macOS XCTest), Windows (WinAppDriver), plus browser drivers: **Safari** (wraps `safaridriver`), **Gecko** (wraps `geckodriver`), **Chromium** (wraps `chromedriver`; v2.x is Appium-3-only). [HIGH] (https://appium.io/docs/en/3.1/ecosystem/drivers/ ; https://github.com/appium/appium-espresso-driver ; https://github.com/appium/appium-chromium-driver)

### 4.2 Appium's WebDriver BiDi support — what it actually is

- Appium server implements the **BiDi transport (WebSocket) with three session-level commands: `session.status`, `session.subscribe`, `session.unsubscribe`** — i.e., Appium BiDi is an **event-subscription channel, not a browser-command protocol**. Everything else in the BiDi spec → "not implemented" errors. [HIGH] (https://appium.io/docs/en/3.2/reference/api/bidi/)
- **XCUITest driver** (partial BiDi since v7.26.0): `log.entryAdded` streams (syslog, crashlog on iOS/tvOS 18+ real devices via `appium-ios-remotexpc`, safariConsole, safariNetwork, performance, server), proprietary `appium:xcuitest.contextUpdate` (NATIVE/WEB context-change events), `appium:xcuitest.networkMonitor` (iOS 18+ structured flow data). [HIGH] (https://appium.github.io/appium-xcuitest-driver/latest/reference/bidi/)
- **UiAutomator2 driver**: `log.entryAdded` (logcat syslog + server logs) and `appium:uiautomator2.contextUpdate` only. [HIGH] (https://github.com/appium/appium-uiautomator2-driver/blob/master/docs/bidi.md)
- **No driver proxies full browser BiDi today.** Appium does NOT forward `browsingContext.*` / `script.*` / `network.*` BiDi commands to chromedriver or safaridriver. Web-context automation still flows over classic W3C + driver-internal CDP/Inspector bridges.

### 4.3 Hybrid app / webview automation

- **Android (UiAutomator2/Espresso):** context switch to `WEBVIEW_*` spins up **chromedriver under Appium** against the WebView's DevTools socket (`localabstract:webview_devtools_remote_<pid>`); version matching handled via `chromedriverPort`/chromedrivers mapping/auto-download. Mature, battle-tested. [HIGH] (https://github.com/appium/appium-uiautomator2-driver)
- **iOS (XCUITest):** webviews are driven via **appium-remote-debugger speaking Apple's private WebKit Remote Inspector protocol** — over usbmuxd for older devices, and **over CoreDevice/RemoteXPC IPv6 tunnels for iOS 17+** (the lockdown → CoreDeviceProxy → TUN/TAP → RemoteXPC path). Appium is replacing its Python/usbmux plumbing with **`appium-ios-remotexpc`** (+ `appium-ios-tuntap`), a Node library for lockdown, pairing records, syslog, and tunnel creation (`npm run tunnel-creation`, requires sudo); issue appium-xcuitest-driver#2771 tracks making it the first-class iOS/tvOS client. [HIGH] (https://github.com/appium/appium-ios-remotexpc ; https://github.com/appium/appium-xcuitest-driver/issues/2771)
- **Known pain (June 2026):** iOS 18.x real-device webview detection regressions — `getContexts()` returning only NATIVE on 18.1/18.3 while Safari.app's Web Inspector still sees the page (appium/appium#21043, open); `webView.isInspectable = true` required since iOS 16.4; Web Inspector + Remote Automation toggles required on-device. [HIGH] (https://github.com/appium/appium/issues/21043)

### 4.4 REAL mobile browser automation

**Chrome-on-Android (BYOB on mobile: YES, via CDP):**
- Stock Chrome exposes DevTools at `localabstract:chrome_devtools_remote`; `adb forward` gives any CDP client a full-fidelity connection — this is exactly how **Playwright's experimental `_android` API** works (polls `/proc/net/unix` for CDP sockets, drives Chrome-for-Android and WebViews over adb; "raw USB not supported, ADB required; not all tests run against device"). [HIGH] (https://playwright.dev/docs/api/class-android ; https://deepwiki.com/microsoft/playwright/8.4-electron-android-and-webview2 [MED])
- chromedriver also drives Android Chrome (`androidPackage` cap) and fixed Android session bugs as late as 110.x; **BiDi-on-Android via chromedriver (`webSocketUrl: true`) is plausible (the chromium-bidi mapper rides inside chromedriver) but is not an officially documented mobile configuration** — BiDi's mobile-emulation work is aimed at desktop-emulating-mobile, not device Chrome. [MED] (https://sites.google.com/chromium.org/driver/downloads)
- Implication for browxai: **Android Chrome/WebView is reachable with your EXISTING CDP core** — the marginal cost is adb plumbing, not a new protocol.

**Safari-on-iOS (no CDP, no BiDi — two real paths):**
1. **`safaridriver` (Apple, built into macOS):** creates W3C-classic sessions against desktop Safari, **paired real iOS devices, or simulators** (iOS 13+; enable Settings → Safari → Advanced → Remote Automation; `safaridriver --enable` once; macOS host mandatory; screen unlocked). Real Safari, Apple-supported, but: classic protocol only (no events/interception), one session per device, no BiDi roadmap signal from Apple as of June 2026. [HIGH] (https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/ ; https://developer.apple.com/documentation/safari-developer-tools/ios-enabling-webdriver ; https://www.selenium.dev/documentation/webdriver/browsers/safari/)
2. **Appium:** either `appium-safari-driver` (thin wrapper over the same safaridriver binary — adds nothing protocol-wise) or **XCUITest driver driving Safari as an app** with webview automation via the Remote Inspector protocol (richer: JS eval, console/network logs via BiDi events, native UI control) at the cost of WebDriverAgent signing + iOS 17+ tunnels. [HIGH] (https://github.com/appium/appium-safari-driver)
- **pymobiledevice3** (doronz88): pure-Python lockdown/RemoteXPC stack; `InspectorSession` gives direct WebKit Inspector Protocol access (Runtime/Console domains, JS eval) to Safari/WebViews; iOS ≥17 requires its tunnel transport (`start-tunnel`, sudo, trusted pairing). Power-tool for a custom bridge; private protocol, version-fragile. `ios-webkit-debug-proxy` (CDP-translation shim) still exists but lags. [HIGH] (https://github.com/doronz88/pymobiledevice3 ; https://deepwiki.com/doronz88/pymobiledevice3/8.2-inspector-session-and-javascript-evaluation [MED])

### 4.5 Appium as a bridge for DESKTOP browsers — is it sane?

**No.** The appium-gecko/safari/chromium drivers are acknowledged thin wrappers over geckodriver/safaridriver/chromedriver speaking W3C classic; routing browxai's 200 tools through Appium adds a Node server hop, session-management ceremony, and Appium's events-only BiDi — while removing direct CDP/BiDi fidelity you already have. Appium's value is exclusively **native mobile + hybrid + real-device Safari/iOS**, where it owns plumbing nobody else maintains (WDA, RemoteXPC tunnels, chromedriver orchestration). [HIGH-confidence assessment]

### 4.6 Licensing / operational weight

- Apache-2.0 across Appium server, drivers, appium-ios-remotexpc; pymobiledevice3 is GPL-3.0 (**copyleft — relevant if browxai links it**; MIT-ish alternatives: go-ios (MIT), appium-ios-remotexpc (Apache-2.0)). [HIGH]
- Ops: Node ≥20.19 server; per-platform drivers; iOS lane needs macOS hosts, Xcode, Apple Developer signing for WebDriverAgent on real devices, sudo-privileged tunnel daemon for iOS 17+, device toggles (Web Inspector / Remote Automation / isInspectable); Android lane needs adb + auto-managed chromedrivers. Sauce Labs/BrowserStack document Appium-3 compatibility matrices — cloud offload is the standard mitigation. [HIGH]

---

## 5. Other engines & paths worth tracking

| Path | State (June 2026) | Signal for browxai |
|---|---|---|
| **WebKitGTK / WPE WebKit** | `WebKitWebDriver` (classic) shipped for years; **WebDriver BiDi enabled as EXPERIMENTAL in 2.47.4 (GTK 2025-02-05, WPE 2025-02-10)**, Igalia running BiDi WPT on wpt.fyi; WebKitGTK 2.52 due March 2026 [HIGH] (https://www.webkitgtk.org/2025/02/05/webkitgtk2.47.4-released.html ; https://wpewebkit.org/release/wpewebkit-2.47.4.html) | **The only WebKit-engine BiDi implementation in existence.** If BiDi ever reaches Safari, it lands through this upstream code. A Linux WebKitGTK+BiDi lane is a cheap "WebKit-over-BiDi" testbed today; Epiphany = the stock GTK browser you'd drive. |
| **Servo** | WebDriver (classic) server actively built out through 2025 ("This month in Servo" 2025-07-17: WebDriver usable enough for a blog demo; conformance-test project ongoing); Servo 0.1.0 published to crates.io 2026-04-13 [HIGH] (https://servo.org/blog/2025/07/17/this-month-in-servo/ ; https://servo.org/blog/2026/04/13/servo-0.1.0-release/) | Watch-only. Classic subset, no BiDi yet. |
| **Ladybird** | First Alpha targeted "Summer 2026" (Linux/macOS); passes ~90% of web-platform tests per Dec 2025 reports; ships an internal WebDriver implementation used for WPT [MED — WebDriver detail from project docs, not re-verified this cycle] (https://ladybird.org/ ; https://en.wikipedia.org/wiki/Ladybird_(web_browser)) | Watch-only; pre-alpha. |
| **Android WebView** | Covered by both Playwright `_android` (CDP socket discovery) and Appium hybrid mode (chromedriver). [HIGH] | Reachable with existing CDP core. |
| **Electron** | First-class CDP target; Playwright `_electron` (experimental) and Puppeteer attach over CDP; browser-use-style raw-CDP clients work unmodified. [HIGH] (https://deepwiki.com/microsoft/playwright/8.4-electron-android-and-webview2 [MED]) | Free coverage for browxai's CDP core. |
| **Safari Web Extension fallback** | Safari extensions ship inside notarized Mac/iOS apps; **native messaging works out-of-the-box system-wide** (no registry/manifest dance — a real Safari advantage); BUT no `chrome.debugger` equivalent, so extension automation = content-script DOM level only. Agent products on macOS today either skip Safari (Claude-in-Chrome, Comet, Atlas, Opera Neon are all Chromium), use OS-level accessibility/screen control (Fazm-style macOS agents), or ship WebKit wrappers (SigmaOS). Apple's own June 2026 move: AI tab organization + **AI-generated extensions** in Safari 26.x (MacRumors 2026-06-08) — Apple is building assistant features *into* Safari rather than opening automation APIs. [MED] (https://lapcatsoftware.com/articles/2026/1/1.html ; https://www.macrumors.com/2026/06/08/safari-tab-organization-and-ai-generated-extensions/ ; https://fazm.ai/blog/macos-ai-agent) | An extension+native-messaging bridge is the only "live user Safari" hook, but it caps you at DOM/JS tools (~⅓ of a 200-tool surface); no network interception, no CDP-class introspection. |
| **Cloud device farms** | **BrowserStack Automate supports Selenium BiDi** (`seleniumBidi` cap; Chrome-blog-promoted: developer.chrome.com/blog/webdriver-bidi-support-in-browserstack); BrowserStack + LambdaTest both launched **Playwright on REAL iOS Safari devices** (LambdaTest PR 2025-07-09; BrowserStack "first platform" claim) — implemented vendor-side, signalling commercial demand for real-Safari automation that the OSS stack can't satisfy; Sauce Labs/LambdaTest are BiDi WG members with partial support. [MED-HIGH] (https://www.browserstack.com/docs/automate/selenium/bidi-event-driven-testing ; https://www.browserstack.com/release-notes/en/selenium-bidi-is-now-supported-on-automate) | BiDi is now grid-deployable; real-iOS-Safari-as-a-service exists if browxai wants coverage without owning device plumbing. |
| **Raw-CDP agentic stacks** | browser-use left Playwright for raw CDP (`cdp-use`, post 2025-08-20): cited the extra Node websocket hop, state drift, latency across thousands of calls; explicitly Chromium-only, cross-browser not addressed. [HIGH] (https://browser-use.com/posts/playwright-to-cdp) | The agent ecosystem is consolidating on CDP-for-depth; nobody in that cohort has a Firefox/Safari story — cross-engine support is a differentiator browxai can own via BiDi. |

**W3C spec status:** WebDriver BiDi remains a **Working Draft on the Recommendation track**, developed living-standard-style (w3.org/TR/webdriver-bidi/); module proposals (e.g., WebExtensions, emulation) keep landing. No CR as of June 2026. [HIGH]

---

## 6. Strategic synthesis for browxai

### 6.1 Which path minimizes per-engine code for a ~200-tool MCP bridge?

**Tier the tool surface by protocol capability, not by browser:**

| Tier | ~Tool share | Protocol | Engines covered |
|---|---|---|---|
| T1 "universal" (navigate, click, fill, snapshot, screenshot, JS eval, cookies, console, basic network read) | ~40% | BiDi (or classic fallback) | Chromium, stock Firefox, WebKitGTK (exp.), future Safari-if-ever |
| T2 "rich" (interception/route, storage suites, emulation, HAR, downloads, workers, ws_intercept) | ~35% | BiDi-where-landed, else CDP | Chromium full; Firefox partial-and-growing (Selenium 4.36–4.40 cadence shows the curve) |
| T3 "deep" (heap snapshots, coverage, perf insights, layout-thrash trace, extensions mgmt, sw fetch interception, canvas/CDP-only domains) | ~25% | CDP only | Chromium/Electron/Android-Chrome only — **accept this; even Puppeteer throws `UnsupportedOperation` here** |

Concrete moves, cheapest first:
1. **Firefox now:** add a BiDi adapter behind the existing session layer. Two viable implementations: (a) ride **Playwright `moz-firefox` channels** (zero new protocol code, inherits Playwright's experimental gaps), or (b) speak **BiDi directly / via Puppeteer-style client** for the T1/T2 set (more control, stock Firefox, GA-grade in the browser). Mozilla's Milestone-20 items (screencast, CSP-disable, streaming) are exactly browxai-relevant — track bug 1917540.
2. **Android now:** adb + CDP socket discovery (Playwright `_android` pattern) — reuses the CDP core verbatim for Chrome-on-Android and WebViews.
3. **Safari engine-coverage now:** keep playwright-webkit as the "WebKit correctness" lane; optionally add WebKitGTK+BiDi on Linux CI as a forward-looking BiDi/WebKit testbed.
4. **REAL Safari (desktop + iOS):** a *curated subset* (30–50 T1 tools) over **safaridriver** (classic W3C) is the only Apple-supported route; Appium XCUITest only if hybrid/native context or console/network log streams are required. Do not attempt 200-tool parity on Safari — the protocol ceiling is real.
5. **Do NOT route desktop browsers through Appium**; do not build on the private WebKit Inspector protocol for product features (iOS 18 webview-detection breakage is the cautionary tale, and pymobiledevice3's GPL-3.0 is a licensing snag for embedding).

### 6.2 Where the industry is heading, 2026–2028

- **BiDi = the cross-engine convergence layer.** Firefox: done and CDP-free. Chrome: dual-stack, mapper-based BiDi shipping, Google co-authoring the spec. WebKit: experimental in GTK/WPE (Igalia) — the open question is *when/whether Apple ships it in Safari/safaridriver*; no public commitment as of June 2026, but the upstream code now exists, which it didn't in 2024.
- **CDP = the Chromium depth/perf layer indefinitely.** The agentic-browser wave (browser-use's raw-CDP pivot, Chromium-based AI browsers) is doubling down on CDP; Google has shown no intent to retire it for Chrome.
- **Clients converge on dual-protocol:** Puppeteer (CDP default + BiDi GA), Selenium 4.x (classic + BiDi, CDP labeled temporary), WebdriverIO (BiDi default), Playwright (custom protocols + experimental BiDi channels, direction-of-travel clear via `moz-firefox` and the MCP exposure dated 2026-06-08). Expect Playwright to flip stock-Firefox-BiDi from experimental to supported within the 2026–2027 window once Mozilla's Milestone 20 closes; expect patched-Firefox/Juggler to be deprecated after, and the custom WebKit build to persist longest (no Safari BiDi to replace it).
- **Mobile stays bifurcated:** Android converges on CDP/BiDi-over-adb (BYOB works); iOS stays Apple-gated (safaridriver classic + private Inspector protocol + RemoteXPC tunnels), with cloud farms commercializing the gap. Appium remains the native/hybrid standard — its BiDi story is telemetry, not control.
- **Bet summary for browxai:** architect as **protocol-pluggable with capability tiers** — CDP for depth (Chromium/Electron/Android), BiDi for breadth (Firefox today, WebKit-family tomorrow), thin classic-WebDriver adapter for real Safari/iOS verification. That is the minimum-code, maximum-future-proof shape; it also matches exactly where Playwright, Puppeteer, Selenium, and the cloud grids are all independently converging.

---

## Appendix: primary sources

| Topic | URL | Date |
|---|---|---|
| Playwright BiDi blockers | https://github.com/microsoft/playwright/issues/32577 | opened 2024-09-12, open |
| Playwright→BiDi roadblocks (W3C) | https://github.com/w3c/webdriver-bidi/issues/769 | 2024-09-12 |
| moz-firefox channels in MCP | https://github.com/microsoft/playwright/pull/41126 | merged 2026-06-08 |
| Playwright BiDi test harness | https://github.com/microsoft/playwright/blob/main/tests/bidi/README.md | current |
| Playwright browsers policy | https://playwright.dev/docs/browsers | current |
| Playwright release notes (1.60) | https://playwright.dev/docs/release-notes | 2026-05 |
| Playwright Android | https://playwright.dev/docs/api/class-android | current |
| Mozilla BiDi milestones | https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi | M19 done 2026-03; M20 WIP |
| Mozilla Playwright meta-bug | https://bugzilla.mozilla.org/show_bug.cgi?id=1917540 | active 2026-05 |
| Puppeteer BiDi support | https://pptr.dev/webdriver-bidi | v25.x |
| BiDi production-ready announcement | https://developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi | 2024-08-07 |
| Puppeteer drops Firefox-CDP | https://github.com/puppeteer/puppeteer/pull/13427 | 2025 |
| Firefox CDP deprecation | https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/ | 2024 |
| Selenium drops Firefox-CDP | https://www.selenium.dev/blog/2025/remove-cdp-firefox/ | 2025 |
| Selenium 4.40 | https://www.selenium.dev/blog/2026/selenium-4-40-released/ | 2026 |
| Selenium BiDi docs | https://www.selenium.dev/documentation/webdriver/bidi/ | current |
| WebdriverIO v9 | https://webdriver.io/blog/2024/08/15/webdriverio-v9-release/ | 2024-08-15 |
| Appium 2→3 migration | https://appium.io/docs/en/3.1/guides/migrating-2-to-3/ | current |
| Appium BiDi reference | https://appium.io/docs/en/3.2/reference/api/bidi/ | current |
| XCUITest BiDi | https://appium.github.io/appium-xcuitest-driver/latest/reference/bidi/ | current (≥7.26.0) |
| UiAutomator2 BiDi | https://github.com/appium/appium-uiautomator2-driver/blob/master/docs/bidi.md | current |
| appium-ios-remotexpc | https://github.com/appium/appium-ios-remotexpc | active 2026 |
| remotexpc first-class issue | https://github.com/appium/appium-xcuitest-driver/issues/2771 | open |
| iOS 18 webview detection bug | https://github.com/appium/appium/issues/21043 | open |
| WebDriver in Safari/iOS 13 | https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/ | 2019, still the model |
| Apple WebDriver docs | https://developer.apple.com/documentation/safari-developer-tools/webdriver | current |
| appium-safari-driver | https://github.com/appium/appium-safari-driver | current |
| pymobiledevice3 | https://github.com/doronz88/pymobiledevice3 | active |
| WebKitGTK 2.47.4 (BiDi exp.) | https://www.webkitgtk.org/2025/02/05/webkitgtk2.47.4-released.html | 2025-02-05 |
| WPE 2.47.4 (BiDi exp.) | https://wpewebkit.org/release/wpewebkit-2.47.4.html | 2025-02-10 |
| Servo WebDriver | https://servo.org/blog/2025/07/17/this-month-in-servo/ | 2025-07-17 |
| Servo 0.1.0 | https://servo.org/blog/2026/04/13/servo-0.1.0-release/ | 2026-04-13 |
| Ladybird | https://ladybird.org/ | Alpha target summer 2026 |
| browser-use raw CDP | https://browser-use.com/posts/playwright-to-cdp | 2025-08-20 |
| BrowserStack BiDi | https://www.browserstack.com/docs/automate/selenium/bidi-event-driven-testing | current |
| BrowserStack BiDi (Chrome blog) | https://developer.chrome.com/blog/webdriver-bidi-support-in-browserstack | 2024 |
| Safari AI extensions (Apple) | https://www.macrumors.com/2026/06/08/safari-tab-organization-and-ai-generated-extensions/ | 2026-06-08 |
| Safari ext. native messaging | https://lapcatsoftware.com/articles/2026/1/1.html | 2026-01-01 |
| W3C BiDi spec | https://www.w3.org/TR/webdriver-bidi/ | Working Draft |
