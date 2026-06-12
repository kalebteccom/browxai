# WebDriver BiDi & Adjacent Browser-Automation Standards — State of the World, June 2026

Researched for **browxai** (Kalebtec's MCP-native browser bridge; Playwright/CDP-based today, BYOB-attach-first) with the goal of Firefox + Safari + maximal coverage on modern standards.
Research date: **2026-06-13**. Primary sources (W3C specs, vendor blogs/release notes, bug trackers) cited inline. Claims are dated wherever the source supports it.

---

## 1. Executive summary

- **WebDriver BiDi is now the only cross-engine bidirectional automation protocol with real momentum.** The spec is a W3C Working Draft, latest snapshot **1 June 2026** ([w3.org/TR/webdriver-bidi](https://www.w3.org/TR/webdriver-bidi/)), edited by **James Graham (Mozilla), Alex Rudenko (Google), Maksim Sadym (Google)**, in the Browser Testing and Tools WG chaired by **David Burns** (Invited Expert; employed by BrowserStack — [W3C group page](https://www.w3.org/testing/browser/), [LinkedIn](https://www.linkedin.com/in/theautomatedtester/)). Apple, Microsoft, Datadog and Bloomberg are WG participants ([participants](https://www.w3.org/groups/wg/browser-tools-testing/participants/)).
- **Firefox is all-in**: CDP was deprecated in Firefox 129 (Aug 2024) and **completely removed in Firefox 141 (released 22 July 2025)** ([fxdx.dev](https://fxdx.dev/cdp-retirement-in-firefox/), [MDN Fx141 notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141)). `--remote-debugging-port` now serves only a WebDriver BiDi WebSocket. Firefox is the friendliest engine for standards-based BYOB attach.
- **Chrome still runs BiDi as a translation layer over CDP** (the `chromium-bidi` JS "mapper" running in a hidden tab, launched by ChromeDriver/Puppeteer — [GoogleChromeLabs/chromium-bidi](https://github.com/GoogleChromeLabs/chromium-bidi)). CDP remains Chrome's native wire protocol and the default in Puppeteer ([pptr.dev/webdriver-bidi](https://pptr.dev/webdriver-bidi)). No native (C++) in-browser BiDi endpoint has shipped as of June 2026.
- **Safari/safaridriver has NOT shipped WebDriver BiDi as of Safari 27 beta (8 June 2026).** Nothing at WWDC25 or WWDC26. *But* the WebKit engine is actively gaining a port-agnostic BiDi implementation — driven largely by **Igalia** (shipping experimentally in WebKitGTK since 2.47.4, Feb 2025) with **Apple's BJ "Blaze" Burg owning the WebKit browsingContext meta-bug** ([bug 281943](https://bugs.webkit.org/show_bug.cgi?id=281943)). WebKit's official standards position on BiDi is **"support"** ([standards-positions#240](https://github.com/WebKit/standards-positions/issues/240)). Expect WebKitGTK/WPE first; safaridriver exposure is plausible but unannounced.
- **The CDP→BiDi capability gap is closing fast but real**: network response/request bodies landed in BiDi (data collectors, 2025); missing still: WebAuthn virtual authenticators, accessibility tree, coverage/profiling, screencast (in-flight: Firefox M20 targets screen-recording commands), virtual time/clock, deep device emulation. BiDi is *better* than CDP at: cross-browser preload scripts + sandboxes + channels, spec-defined input, user contexts, standardized auth/request interception phases, and a multi-connection session model.
- **BYOB reality check**: Chrome 136+ (May 2025) **blocks `--remote-debugging-port` on the default user profile** — attach now requires a separate `--user-data-dir` ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)). Firefox allows remote agent on any profile with loopback-only + allowlist gates. Safari categorically forbids attaching to the user's session: automation runs in isolated, clean-state windows behind a "glass pane."

---

## 2. WebDriver BiDi spec maturity — module by module

### 2.1 Process & people

| Item | Status (June 2026) | Source |
|---|---|---|
| Spec stage | W3C **Working Draft** (Rec track); snapshots 19 Feb / 22 May / **1 Jun 2026**; editor's draft updated continuously | [TR](https://www.w3.org/TR/webdriver-bidi/), [ED](https://w3c.github.io/webdriver-bidi/), [WD-20260219](https://www.w3.org/TR/2026/WD-webdriver-bidi-20260219) |
| Editors | James Graham (Mozilla), Alex Rudenko (Google), Maksim Sadym (Google) | [TR header](https://www.w3.org/TR/webdriver-bidi/) |
| WG | Browser Testing and Tools WG; chair **David Burns** (Invited Expert / BrowserStack); ~55 participants from 20 orgs incl. **Apple, Google, Microsoft, Mozilla, Datadog, Bloomberg**; charter runs to **8 July 2026** (re-charter due) | [w3.org/testing/browser](https://www.w3.org/testing/browser/), [participants](https://www.w3.org/groups/wg/browser-tools-testing/participants/), [charter](https://www.w3.org/2024/btt-wg-charter.html) |
| Vendor involvement | Google + Mozilla co-drive the spec; Apple participates in WG and contributes WebKit patches; BrowserStack contributes via the chair + hosted-grid support (since **1 Aug 2024**) | [Chrome blog: BiDi on BrowserStack](https://developer.chrome.com/blog/webdriver-bidi-support-in-browserstack) |
| Conformance source of truth | WPT dashboard for `webdriver/tests/bidi` | [wpt.fyi](https://wpt.fyi/results/webdriver/tests/bidi) |
| Stability policy | Protocol "can evolve (add/delete/modify items), but it will never lead to breaking changes" per Mozilla; spec self-describes as work-in-progress | [MozillaWiki](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi) |

### 2.2 Modules in the core spec (ED, 1 June 2026)

Core spec defines **10 modules**; MDN's reference documents **13** including externally-defined extension modules ([MDN modules](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules)).

| Module | Contents (June 2026) | Maturity assessment |
|---|---|---|
| **session** | new/end, status, subscribe/unsubscribe (per-context event filtering) | **Stable.** Foundation; implemented everywhere BiDi exists. Multi-connection semantics defined (see §2.4). |
| **browser** | client windows, **user contexts** (createUserContext etc.), download behavior | Stable core; user-context *configuration* (proxy, certs per context) still a gap flagged by Playwright ([pw#32577](https://github.com/microsoft/playwright/issues/32577)). |
| **browsingContext** | create/close/navigate/reload/activate, getTree, captureScreenshot, print, locateNodes, setViewport, traverseHistory, user-prompt handling, full navigation + download event set (incl. `navigationCommitted`, `historyUpdated` — added 2025 to satisfy Playwright) | **Stable and rich.** Navigation-commit detection was a 2024 gap, now specced. |
| **script** | evaluate/callFunction, **preload scripts** (`addPreloadScript`/`removePreloadScript`) with **sandboxes** and **channels** (browser→client messaging, the standard replacement for CDP `Runtime.addBinding`), realms model, remote object serialization | **Stable**; one of BiDi's headline wins. Per-context preload script targeting was a Playwright ask; spec'd via `contexts` param. |
| **network** | `addIntercept`/`removeIntercept` (beforeRequestSent / responseStarted / authRequired phases), `continueRequest`, `continueResponse`, `continueWithAuth`, `failRequest`, `provideResponse`, `setCacheBehavior`, **`setExtraHeaders`** (new), **data collectors**: `addDataCollector`/`getData`/`disownData`/`removeDataCollector` for **response bodies** (2025) and now **request bodies** (`dataType: "request"`, in-flux — [moz bug 1988955](https://bugzilla.mozilla.org/show_bug.cgi?id=1988955)) | **Mostly stable; actively expanding.** Body access — the #1 historic CDP-only gap — is now standardized; streaming of large bodies is being specced (Firefox M20: "specification updates around streaming support and WebSocket events" — [MozillaWiki](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi)). Full response-body *mutation* still goes through `provideResponse` (whole-response substitution), not streamed rewriting. |
| **input** | `performActions` (spec-shared semantics with Classic actions: pointer/key/wheel), `releaseActions`, `setFiles` (file upload) | **Stable.** Spec-defined input is a BiDi advantage over CDP's looser `Input.dispatch*`. Firefox spent M16–M20 moving to widget-level event dispatch for fidelity. |
| **storage** | getCookies/setCookie/deleteCookies, partition-aware (user contexts / storage partitions) | Stable core; cookie-partitioning corner cases still being refined. |
| **log** | `entryAdded` (console + JS errors) | **Stable**; the first thing every implementation ships (WebKit started here too). |
| **emulation** | `setGeolocationOverride`, `setLocaleOverride`, `setTimezoneOverride`, `setScreenOrientationOverride`, `setScreenSettingsOverride`, `setUserAgentOverride`, `setForcedColorsModeThemeOverride`, `setScriptingEnabled`, `setScrollbarTypeOverride`, `setTouchOverride`, `setNetworkConditions` | **Newest core module; in flux but moving very fast** (most commands added 2025–2026). Covers the bulk of "device emulation" use cases that were CDP-only in 2024. |
| **webExtension** | `install` / `uninstall` | Stable shape; implemented in Firefox and Chromium (mapper). |
| **permissions** *(extension module, defined in W3C Permissions spec)* | `permissions.setPermission` | Implemented in Chromium + Firefox; pattern-setter for extension modules ([w3c/permissions PR #425](https://lists.w3.org/Archives/Public/public-webapps-github/2023Nov/0473.html)). |
| **bluetooth** *(extension module, defined in Web Bluetooth spec)* | simulate adapter/devices, handle `requestDevice` prompt | Chromium-led (chromium-bidi implements); used by WPT. Firefox partial. ([WebBluetoothCG/web-bluetooth#616](https://github.com/WebBluetoothCG/web-bluetooth/issues/616)) |
| **userAgentClientHints** *(extension module)* | UA-CH overrides | New in 2026, Chromium-centric ([MDN modules](https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules)). |

### 2.3 Roadmap / in-flux items (mid-2026)

From Mozilla's public milestone plan (the best public proxy for the joint Google+Mozilla roadmap — [MozillaWiki](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi)):

- **M19 (done 29 Mar 2026):** "high-priority APIs required for experimental WebDriver BiDi support in **Playwright**", incl. CSP bypass and user-context configuration on `window.open`.
- **M20 (in progress, June 2026):** **screen-recording commands** (the BiDi answer to CDP screencast), CSP-disable, widget-level event support, spec work on **streaming network bodies and WebSocket inspection events**.
- Open architectural threads: multiple *sessions* per browser ([w3c/webdriver-bidi#103](https://github.com/w3c/webdriver-bidi/issues/103), open since 2021), BiDi-only session creation refinements ([#97](https://github.com/w3c/webdriver-bidi/issues/97)), and the Playwright gap list ([w3c/webdriver-bidi#769](https://github.com/w3c/webdriver-bidi/issues/769)).

### 2.4 Session & connection model (matters for browxai)

Per the ED (1 June 2026, [w3c.github.io/webdriver-bidi](https://w3c.github.io/webdriver-bidi/)):

- "A BiDi session has a **set of session WebSocket connections**" — i.e., **multiple simultaneous client connections to one BiDi session are spec-legal**; each connection belongs to at most one session.
- Two bootstrap paths: (a) **Classic + BiDi**: create a Classic session with capability `webSocketUrl: true`, get a `webSocketUrl` back, connect; (b) **BiDi-only**: the remote end "start[s] listening for a WebSocket connection given null" — i.e., a browser can expose a BiDi listener with no HTTP/Classic driver at all (this is exactly what Firefox `--remote-debugging-port` does).
- Still effectively **one session per browser instance** in implementations (issue #103 unresolved) — unlike CDP's many-clients-many-targets free-for-all.

---

## 3. Per-browser implementation matrix (June 2026)

### 3.1 Support matrix

| Capability | Chrome/Chromium ~M149 | Firefox (≥141; current ~152) | Safari 26.x / 27 beta | Edge (Chromium) | WebKitGTK/WPE | Brave/Arc/other Chromium |
|---|---|---|---|---|---|---|
| WebDriver Classic | ✅ (chromedriver) | ✅ (geckodriver+Marionette) | ✅ (safaridriver, built into macOS) | ✅ (msedgedriver) | ✅ (WebKitWebDriver) | ✅ via matching chromedriver |
| BiDi: how served | **chromium-bidi JS mapper over CDP**, launched by ChromeDriver (`webSocketUrl:true`) or Puppeteer; not a native browser endpoint | **Native Remote Agent** in the browser; BiDi-only endpoint via `--remote-debugging-port` or via geckodriver `webSocketUrl` | ❌ not exposed by safaridriver | Same chromium-bidi mapper (msedgedriver exposes "custom bidi mapper path") | **Experimental native** (libsoup WebSocket transport) since 2.47.4 (Feb 2025) | Mapper works in principle (CDP-compatible); zero first-party support statements |
| BiDi completeness | High; ~full WPT module coverage incl. bluetooth, permissions, UA-CH, BiDi+ extensions | High; "100% BiDi" WPT milestone Jul 2024, since expanded (emulation, data collectors, M19/M20) | n/a in Safari | Tracks Chrome | Partial: log + session + parts of browsingContext/emulation; 20+ browsingContext items open ([bug 281943](https://bugs.webkit.org/show_bug.cgi?id=281943)) | Untracked |
| CDP | ✅ native, default for Puppeteer/DevTools/Playwright | ❌ **removed in Fx 141 (22 Jul 2025)**; Fx 140 ESR grace until ~mid-2026 | ❌ never existed (WebKit has its own inspector protocol, not exposed for 3rd-party automation) | ✅ native | ❌ | ✅ native |
| Preload scripts (BiDi) | ✅ (mapper) | ✅ | ❌ | ✅ | ⚠️ in progress | n/a |
| Network interception (BiDi) | ✅ incl. auth | ✅ incl. auth + bodies (M17) | ❌ | ✅ | ⚠️ not yet | n/a |
| Attach to running browser (standards path) | CDP attach (`--remote-debugging-port` + **mandatory separate `--user-data-dir` since Chrome 136**); BiDi by running mapper over that CDP socket | **✅ best in class**: `--remote-debugging-port` on any profile serves BiDi WS (loopback-only) | **❌ impossible by design** (isolated automation windows only) | Same as Chrome (incl. 136 restriction) | WebKitWebDriver `--bidi` style flows (automation-launched) | Same as Chrome; Brave keeps CDP enabled; Arc undocumented |

Anchors: ChromeDriver 149.x is current June 2026 ([download mirror](https://www.free-codecs.com/download/chromedriver.htm)); geckodriver **0.37.x** current, "supported BiDi commands depend on the version of Firefox, not geckodriver" ([releases](https://github.com/mozilla/geckodriver/releases), [fxdx.dev geckodriver category](https://fxdx.dev/category/remote-protocols/geckodriver/)).

### 3.2 Chrome / Chromium — detail

- Architecture: "an implementation of the WebDriver BiDi protocol **with some extensions (BiDi+)** for Chromium, implemented as a **JavaScript layer translating between BiDi and CDP, running inside a Chrome tab**" ([chromium-bidi README](https://github.com/GoogleChromeLabs/chromium-bidi/blob/main/README.md)). ChromeDriver bundles/launches the mapper when a session requests `webSocketUrl:true`; Puppeteer drives the mapper directly. It "has since been adopted as the default WebDriver BiDi implementation in Chromium" ([perrotta.dev, Feb 2026](https://perrotta.dev/2026/02/webdriver-bidi-from-spec-to-implementation/)).
- **No native in-process BiDi endpoint has shipped**: the browser binary still only speaks CDP on the wire; "native progress" remains the mapper being bundled ever closer to the browser (Chrome for Testing, chromedriver). Watch the chromium-bidi repo milestones ([milestones](https://github.com/GoogleChromeLabs/chromium-bidi/milestones)).
- Production-ready declaration: Chrome team, **1 Aug 2024**: BiDi "finally becomes production-ready for developers, starting with BrowserStack" ([blog](https://developer.chrome.com/blog/webdriver-bidi-support-in-browserstack)).
- Puppeteer policy (current docs): "When launching Firefox… WebDriver BiDi… enabled by default. When launching Chrome, **CDP is still used by default** since not all CDP features are supported by WebDriver BiDi yet" ([pptr.dev/webdriver-bidi](https://pptr.dev/webdriver-bidi)).
- Typed protocol + extension tracking lives in [GoogleChromeLabs/webdriver-bidi-protocol](https://github.com/GoogleChromeLabs/webdriver-bidi-protocol).

### 3.3 Firefox — detail

- Native implementation in the **Remote Agent** (Rust/JS inside Firefox). Timeline: BiDi shipped to release channels in 2022 ([bug 1753997](https://bugzilla.mozilla.org/show_bug.cgi?id=1753997)); Puppeteer-for-Firefox-over-BiDi GA with **Fx 129 (Aug 2024)**; **CDP deprecated Fx 129, removed Fx 141 (22 Jul 2025)** along with the `remote.active-protocols` pref; "switch to Firefox 140 ESR" was the stated escape hatch, with support "typically for one year" — i.e., expiring **mid-2026** ([fxdx.dev CDP retirement](https://fxdx.dev/cdp-retirement-in-firefox/), [Selenium blog](https://www.selenium.dev/blog/2025/remove-cdp-firefox/)).
- `--remote-debugging-port` today = **BiDi-only WebSocket** on localhost:9222 (HTTPD), nothing CDP about it ([Firefox remote security docs](https://firefox-source-docs.mozilla.org/remote/Security.html)).
- geckodriver: pure proxy; BiDi surface tracks the Firefox version; `webSocketUrl` capability support since [bug 1693004](https://bugzilla.mozilla.org/show_bug.cgi?id=1693004); current 0.37.x cleans up BiDi WS port-forwarding on exit ([releases](https://github.com/mozilla/geckodriver/releases)).
- Milestones: M17 = network response bodies + locale/timezone/mobile emulation; M18 = touch + screen dimensions; **M19 (done 29 Mar 2026) = Playwright-unblocking APIs (CSP bypass, user-context config)**; **M20 (current) = screen recording, CSP disable, widget events** ([MozillaWiki](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi)).
- `navigator.webdriver` is forced `true` whenever the Remote Agent is enabled ([bug 1719505](https://bugzilla.mozilla.org/show_bug.cgi?id=1719505)) — relevant to glass-box stealth expectations.

### 3.4 Safari / WebKit — THE BIG QUESTION, answered as of June 2026

**Shipped Safari: no BiDi.**
- Safari 26.0 (Sep 2025), 26.2 (12 Dec 2025), 26.3 (11 Feb 2026), 26.4 (24 Mar 2026): release notes contain **zero** BiDi mentions; WebDriver news is Classic-only — e.g., 26.2 added the (Classic) **Set Storage Access** command for Storage Access API testing ([Safari 26.2 notes / WebKit blog](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/), [Safari 26.4 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26_4-release-notes)).
- **Safari 27 beta (released 8 June 2026 at WWDC26)**: the only WebDriver line item is "Fixed the Safari Develop menu and WebDriver to launch Device Hub instead of Simulator when available in Xcode" ([Safari 27 beta release notes](https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes)); the WWDC26 WebKit announcement post (58 features) has no automation news ([webkit.org/blog/17967](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/)). Nothing at WWDC25 either ([webkit.org/blog/16993](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)).
- Recent Safari Technology Preview release notes (e.g., STP 232) likewise contain no BiDi entries ([STP 232 notes](https://developer.apple.com/documentation/safari-technology-preview-release-notes/stp-release-232)).

**WebKit engine: BiDi is being built, right now.**
- WebKit's standards position on BiDi: **support** ([WebKit/standards-positions#240](https://github.com/WebKit/standards-positions/issues/240), opened Aug 2023).
- Implementation strategy (from WebKit Contributors Meeting 2024 + bug comments): exploit **mixed Classic+BiDi sessions**, implement *new-capability* commands first (`log.entryAdded` landed first), transport via **libsoup's WebSocket** with "most code being port-agnostic" ([Contributors Meeting 2024](https://docs.webkit.org/Other/Contributor%20Meetings/ContributorMeeting2024.html)).
- Who: **Igalia** drives most patches (reporter Lauro Moura; Igalia presented "Advancing WebDriver BiDi support in WebKit" on 26 May 2025 — [Igalia WebKit Periodical #12](https://blogs.igalia.com/webkit/blog/2025/wip-12/)); **Apple's BJ "Blaze" Burg is the assignee of the browsingContext meta-bug** ([bug 281943](https://bugs.webkit.org/show_bug.cgi?id=281943)) — i.e., Apple is engaged, not absent.
- Progress markers: `browsingContext.navigate` merged **23 Mar 2026** ([bug 288330](https://bugs.webkit.org/show_bug.cgi?id=288330)); active mid-2026 work on `emulation.setTimezoneOverride` ([bug 303185](https://bugs.webkit.org/show_bug.cgi?id=303185)) and `contextCreated` replay-on-subscribe ([bug 303207](https://bugs.webkit.org/show_bug.cgi?id=303207)). As of the meta-bug snapshot: 4 browsingContext items resolved, **~20 commands/events still open** — WebKit BiDi is genuinely early.
- Where it ships first: **WebKitGTK/WPE** — BiDi enabled as an *experimental feature* in WebKitGTK **2.47.4 (5 Feb 2025)** ([webkitgtk.org release notes](https://www.webkitgtk.org/2025/02/05/webkitgtk2.47.4-released.html)); Linux `WebKitWebDriver` is the vehicle.
- **Bottom line for Safari**: BiDi in safaridriver has not shipped and has no announced date; the engine plumbing is being laid (port-agnostic, Apple reviewer engaged), so a Safari 27.x-cycle or Safari 28 (WWDC27) debut is plausible speculation — *plan for Safari = Classic-only through at least early 2027*. Side signal: **Simon Stewart (WebDriver's creator) now edits WebDriver Classic with an Apple affiliation** ([w3.org/TR/webdriver2, WD 28 May 2026](https://www.w3.org/TR/webdriver2/)), and Apple keeps investing in Classic-side features (Set Storage Access, device-hub integration) — Apple's automation center of gravity is still Classic.

### 3.5 Edge, Brave, Arc, other Chromium derivatives

- **Edge**: msedgedriver is the Chromium driver lineage; BiDi is delivered exactly like Chrome — chromium-bidi mapper (Selenium's Edge options expose a "custom bidi mapper path"; Edge WebDriver is a Windows Feature-on-Demand auto-updated with Edge) ([learn.microsoft.com WebDriver docs](https://learn.microsoft.com/en-us/microsoft-edge/webdriver/), [selenium edge module](https://www.selenium.dev/selenium/docs/api/javascript/module-selenium-webdriver_edge.html)). No Edge-specific BiDi divergence found.
- **Brave**: keeps CDP/`--remote-debugging-port` functioning (with Chrome's 136+ user-data-dir restriction inherited); drivable by version-matched chromedriver+mapper. No first-party BiDi statements (confidence: medium — absence of evidence).
- **Arc / other Chromium shells**: CDP attach generally works where the vendor hasn't disabled it; BiDi only via mapper-over-CDP; entirely unsupported officially (confidence: medium).
- **Cloud grids**: BrowserStack has run production BiDi on hosted Selenium since **1 Aug 2024** ([Chrome blog](https://developer.chrome.com/blog/webdriver-bidi-support-in-browserstack)); Sauce Labs followed ([Chrome blog, Jan 2025](https://developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi)).

### 3.6 Tooling adoption snapshot (June 2026)

| Tool | BiDi status |
|---|---|
| **Selenium** (4.40.x) | BiDi network/script/log APIs across Java/Python/C#/Ruby/JS/Kotlin via `webSocketUrl:true`; "transitioning from WebDriver Classic to WebDriver BiDi"; Firefox-CDP removed in 4.29; CDP retained for Chromium "until BiDi has been implemented"; data-collector APIs landing ([selenium.dev BiDi docs](https://www.selenium.dev/documentation/webdriver/bidi/), [PR #16336](https://github.com/SeleniumHQ/selenium/pull/16336)). Selenium 5 framing = BiDi-first ([ideas2it overview](https://www.ideas2it.com/blogs/selenium-evolution-of-qa)). |
| **Puppeteer** | BiDi **default for Firefox** (since Fx 129 / Aug 2024); Chrome opt-in (`protocol: 'webDriverBiDi'`); response bodies via BiDi data collectors landed ([commit b4d4d19](https://github.com/puppeteer/puppeteer/commit/b4d4d1915f729a2760a8c74b50877d92ce5e1c94)); `Puppeteer.connect` over BiDi has been a long-running gap ([#11335](https://github.com/puppeteer/puppeteer/issues/11335)). |
| **Playwright** | Still patched-browser custom protocols; **experimental BiDi** channels for Chromium/Firefox; adoption blocked by a tracked gap list ([pw#32577](https://github.com/microsoft/playwright/issues/32577), [w3c#769](https://github.com/w3c/webdriver-bidi/issues/769), [moz meta 1917540](https://bugzilla.mozilla.org/show_bug.cgi?id=1917540)); Mozilla's M19 (Mar 2026) explicitly shipped Playwright-unblocking APIs — convergence is happening but not done. |
| **Cypress** | Firefox over BiDi by default since **14.1 (Feb 2025)**; Firefox-CDP dropped in **Cypress 15 (Aug 2025)** ([cypress issue #32148](https://github.com/cypress-io/cypress/issues/32148)). |
| **WebdriverIO** | Dedicated BiDi protocol package; BiDi used by default when the browser offers `webSocketUrl` ([webdriver.io BiDi API](https://webdriver.io/docs/api/webdriverBidi/)). |
| **Appium / Testplane / others** | BiDi adapters shipping ([Testplane BiDi](https://testplane.io/blog/support-bidi-protocol/)). |

---

## 4. CDP vs BiDi capability gap analysis

### 4.1 Still CDP-only (June 2026)

| Capability | CDP | BiDi status / roadmap |
|---|---|---|
| **WebAuthn virtual authenticator** | `WebAuthn.*` domain | ❌ No BiDi module. Classic WebDriver *does* have the Virtual Authenticator extension (so Safari/Firefox can do it via Classic). No published BiDi timeline ([Playwright webkit ask #26621](https://github.com/microsoft/playwright/issues/26621), [pptr BiDi gaps](https://pptr.dev/webdriver-bidi)). |
| **Accessibility tree** | `Accessibility.*` full AX tree | ❌ Nothing in BiDi (Puppeteer ARIA selectors + a11y snapshots are CDP-only). Classic offers only per-element computed role/label. No concrete proposal yet. |
| **Coverage & profiling** | `Profiler`, `CSS/JS coverage`, `Performance.metrics`, heap snapshots | ❌ Out of scope so far; Puppeteer lists Coverage and `Page.metrics()` as unsupported over BiDi. |
| **Screencast / video** | `Page.startScreencast` | ⏳ **In flight**: screen-recording commands are a Firefox **M20** deliverable and a spec work item ([MozillaWiki](https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi)). |
| **Virtual time / clock control** | `Emulation.setVirtualTimePolicy` | ❌ No BiDi equivalent (Playwright/your `clock` tool does JS-level shimming instead). |
| **Deep device emulation** | CPU throttling, idle-state, vision-deficiency, full `Page.emulate` device presets | ❌/⏳ Puppeteer: `emulateCPUThrottling`, `emulateIdleState` etc. unsupported over BiDi; BiDi's emulation module is absorbing the high-value subset (geolocation, locale, TZ, screen, orientation, touch, UA, network conditions). |
| **Streamed body mutation** | `Fetch.fillResponse`/streaming via debugger | ⚠️ BiDi mutates via whole-response `provideResponse` + data collectors; body **streaming** is an active spec topic (M20). |
| **Raw multi-client / multi-target fan-out** | Any number of WS clients on `/json`; flat sessions; auto-attach | ⚠️ BiDi spec permits multiple **connections** per session (see §2.4) but only one session per browser in practice ([#103](https://github.com/w3c/webdriver-bidi/issues/103)). |
| **Tab-less browser bootstrap, DevTools co-existence** | CDP is what DevTools itself speaks; attach piggybacks anywhere | BiDi needs a serving endpoint (native in Firefox; mapper in Chromium). |
| Extension-realm debugging, `createCDPSession` escape hatches | ✅ | ❌ by definition (BiDi+ `goog:cdp` commands exist in the mapper as a pressure valve). |

### 4.2 Where BiDi is better than CDP

| Capability | Why BiDi wins |
|---|---|
| **Cross-browser by construction** | One protocol for Chromium + Firefox today, WebKit tomorrow; CDP is single-vendor and Firefox **removed** it (Fx 141). |
| **Preload scripts + sandboxes + channels** | `script.addPreloadScript` (with isolated sandbox realms and `channel` callbacks) is spec-defined and works identically cross-browser — the standardized union of CDP's `Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding`, with cleaner isolation. |
| **Realms model** | Explicit realm/world enumeration and targeting (incl. sandboxes, workers direction) vs CDP's execution-context bookkeeping pain. |
| **Spec-defined input** | `input.performActions` reuses Classic's action-sequence semantics — deterministic, testable, identical across engines; Firefox dispatches at widget level for fidelity (M16–M20). |
| **User contexts** | `browser.createUserContext` = standardized profile-lite isolation (cookies/storage) across browsers; CDP's `BrowserContext` equivalent is Chrome-only. |
| **Network auth + phases** | `network.authRequired` phase + `continueWithAuth` standardizes HTTP-auth automation that CDP handles awkwardly via `Fetch.continueWithAuth`. |
| **Event subscription model** | Global or per-context, per-module subscription with buffered replay (e.g., `contextCreated` replay) — saner than CDP enable-per-domain-per-target. |
| **Serialization** | Structured, spec-defined remote-value serialization (incl. shadow DOM, platform objects) vs CDP's `RemoteObject` quirks. |
| **Forward-compat governance** | W3C process; "no breaking changes" evolution policy; WPT conformance suite as source of truth ([wpt.fyi BiDi](https://wpt.fyi/results/webdriver/tests/bidi)). |

---

## 5. BYOB — attaching to the user's running browser, per engine

### 5.1 Chromium (Chrome, Edge, Brave, Arc…)

- Classic story: launch or attach via `--remote-debugging-port=NNNN` (CDP HTTP + WS). **Changed hard in Chrome 136 (stable early May 2025):** the flag is **ignored when pointed at the default user-data directory**; you must pass a separate `--user-data-dir`, whose data is encrypted with a different key — explicitly to stop infostealer-style cookie theft ([Chrome for Developers blog](https://developer.chrome.com/blog/remote-debugging-port), [chromium issue 417456892](https://issues.chromium.org/issues/417456892)).
  - **Consequence for browxai**: on Chrome ≥136 there is no sanctioned way to CDP/BiDi-attach to the user's *actual day-to-day profile*. BYOB on Chromium now means: (a) a dedicated automation profile dir (cookies imported/synced by other means), (b) an extension-relay architecture (chrome.debugger / chrome-devtools-mcp-style, as Claude-in-Chrome does), or (c) pre-136 forks. Tools across the ecosystem broke on this exact change ([browser-use#1520](https://github.com/browser-use/browser-use/issues/1520), [chrome-devtools-mcp#1830](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1830)).
- BiDi-attach: Chromium has **no native BiDi listener**; you attach CDP and run the chromium-bidi mapper over that connection (what ChromeDriver does internally). So Chromium BYOB capability == CDP BYOB capability, with BiDi as an overlay.
- Multi-client: CDP supports many simultaneous WS clients (DevTools + your bridge can co-exist); BiDi sessions via the mapper are 1:1 with a browser today.

### 5.2 Firefox

- **The best standards-native BYOB story.** Start Firefox — *any* profile, including the user's real one; no Chrome-136-style profile ban — with `--remote-debugging-port[=9222]`, and the Remote Agent serves a **WebDriver BiDi WebSocket** (CDP gone since Fx 141).
- Security gates ([firefox-source-docs Security](https://firefox-source-docs.mozilla.org/remote/Security.html)): loopback-only binding; Host-header and Origin-header allowlists (`--remote-allow-hosts`, `--remote-allow-origins`) for non-local/WebSocket-from-web access; no encryption/auth on the socket (treat as a local root-equivalent capability); content-process scope by default with `--remote-allow-system-access` required for chrome-level (full Gecko API) automation.
- Caveats: the flag must be present at launch (attach-after-the-fact to an already-running, non-instrumented Firefox is not possible); `navigator.webdriver` is `true` whenever the agent runs ([bug 1719505](https://bugzilla.mozilla.org/show_bug.cgi?id=1719505)); one BiDi session at a time, but the spec's multi-connection model applies.
- geckodriver path (Classic+BiDi mixed session with `webSocketUrl`) always *launches* its own Firefox; for glass-box attach, run the Remote Agent flag directly and speak BiDi-only.

### 5.3 Safari

- **You can never attach to the live user session. Period.** Apple's model ([webkit.org "WebDriver is Coming to Safari in iOS 13"](https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/), [Apple: Testing with WebDriver in Safari](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari)):
  - Gate: `safaridriver --enable` once (or Develop ▸ **Allow Remote Automation**).
  - Sessions run in **dedicated automation windows**: "an automated browser always starts from a clean state like a private browsing session… doesn't have access to Safari's browsing history, AutoFill data" — orange Smart Search field marks them; local state (cookies etc.) is destroyed at session end.
  - A transparent **glass pane** blocks user input over automation windows during the session; the user can "break" the glass to kill the session.
  - One session per safaridriver instance; Safari + STP each ship their own `safaridriver` and can run simultaneously.
  - safaridriver is HTTP/Classic only (REST API → XPC to the browser); **no WebSocket/BiDi endpoint exists** as of Safari 27 beta.
- Implication: Safari support in browxai = managed (isolated) sessions only, Classic protocol (directly or via Playwright's WebKit build — noting Playwright's `webkit` is a custom-built WebKit with its own protocol, *not* the user's Safari).

### 5.4 What the standards say about session ownership

- Classic: a remote end has at most one active session (per spec) — guarantees exclusivity, kills multi-client by design.
- BiDi: multiple WebSocket **connections** may share one session (§2.4); **BiDi-only sessions** legitimize browser-exposed listeners with no driver binary — exactly the Firefox `--remote-debugging-port` shape, and the natural shape for a future "Safari exposes BiDi" world. Multiple *sessions* per browser remains an open design question ([#103](https://github.com/w3c/webdriver-bidi/issues/103)).

---

## 6. WebDriver Classic going forward

- **Classic is not dying; it's the substrate.** Spec ("WebDriver", a.k.a. webdriver2) is an actively-edited W3C **Working Draft dated 28 May 2026**, editors **Simon Stewart (Apple)** and **David Burns (BrowserStack)** ([w3.org/TR/webdriver2](https://www.w3.org/TR/webdriver2/)). (WebDriver 1 became a Recommendation in 2018; the living draft carries development.)
- Division of labor that's emerged:
  - **Classic** = session bootstrap (capabilities negotiation, `webSocketUrl` hand-off to BiDi), the synchronous command set, and the home of **extension specs**: WebAuthn virtual authenticators, Permissions, Reporting (`generateTestReport`), Custom Handlers, Sensors, and Apple's new **Set Storage Access** command (Safari 26.2, Dec 2025).
  - **BiDi** = everything event-driven, network, emulation, preload scripts — and increasingly the *only* place new automation capability is specced (Mozilla/Google ship new features BiDi-first).
- Interop mechanics: one session identity spans both; a Classic session created with `webSocketUrl: true` returns the BiDi socket; BiDi events/commands operate on the same browsing contexts the Classic session controls ("mixed sessions" — exactly the migration strategy WebKit chose). BiDi-only sessions skip Classic entirely.
- Safari = Classic-only today; therefore any "maximal coverage" bridge must keep a Classic/HTTP execution path alive for the foreseeable future (Selenium 4.40 / WebDriverIO do; Playwright's WebKit sidesteps it with a custom build).

---

## 7. Implications for browxai (BYOB-attach-first, MCP-native)

1. **Protocol abstraction should be 3-headed**: CDP (Chromium native, attach), BiDi (Firefox native today; Chromium via mapper; WebKit tomorrow), Classic (Safari, plus WebAuthn/permissions extension commands everywhere).
2. **Firefox support is cheap now**: a BiDi client against `--remote-debugging-port` gives launch-or-glassbox attach on real profiles, preload scripts, network interception incl. bodies, emulation — no geckodriver needed for BiDi-only sessions. Mind the loopback/allowlist flags and `navigator.webdriver=true`.
3. **Safari support means Classic + safaridriver isolation** — design the UX around "Safari sessions are always isolated automation windows," and watch WebKit bugzilla ([bug 281943](https://bugs.webkit.org/show_bug.cgi?id=281943) and the 303xxx series) + Safari release notes for the BiDi flip; the port-agnostic engine work suggests it's a *when*, not *if*.
4. **Chromium BYOB needs a post-136 strategy** (separate user-data-dir profiles or an extension relay); don't promise "attach to your daily Chrome profile" on Chrome ≥136.
5. **Keep CDP fallbacks for**: WebAuthn, AX tree, coverage/profiling, screencast (until BiDi screen recording ships — track Firefox M20), virtual time. These are exactly the features behind browxai tools like `coverage_*`, `clock`, `heap_*`, `perf_*`, video recording.

---

## 8. Source index (primary, dated)

**Specs / W3C**
- WebDriver BiDi TR (WD 1 Jun 2026): https://www.w3.org/TR/webdriver-bidi/ ; ED: https://w3c.github.io/webdriver-bidi/ ; Feb 2026 snapshot: https://www.w3.org/TR/2026/WD-webdriver-bidi-20260219
- WebDriver Classic (WD 28 May 2026): https://www.w3.org/TR/webdriver2/
- BTT WG: https://www.w3.org/testing/browser/ ; participants: https://www.w3.org/groups/wg/browser-tools-testing/participants/ ; charter: https://www.w3.org/2024/btt-wg-charter.html
- Multi-session issue: https://github.com/w3c/webdriver-bidi/issues/103 ; BiDi-only sessions: https://github.com/w3c/webdriver-bidi/issues/97 ; Playwright gaps: https://github.com/w3c/webdriver-bidi/issues/769
- Permissions BiDi extension: https://lists.w3.org/Archives/Public/public-webapps-github/2023Nov/0473.html ; Web Bluetooth BiDi: https://github.com/WebBluetoothCG/web-bluetooth/issues/616
- MDN module reference: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules
- WPT dashboard: https://wpt.fyi/results/webdriver/tests/bidi

**Chromium / Google**
- chromium-bidi: https://github.com/GoogleChromeLabs/chromium-bidi (+ /milestones, /blob/main/README.md) ; typed protocol: https://github.com/GoogleChromeLabs/webdriver-bidi-protocol
- BiDi production-ready / BrowserStack (1 Aug 2024): https://developer.chrome.com/blog/webdriver-bidi-support-in-browserstack
- Puppeteer×Firefox BiDi GA (Jan 2025 update): https://developer.chrome.com/blog/firefox-support-in-puppeteer-with-webdriver-bidi
- Chrome 136 remote-debugging hardening: https://developer.chrome.com/blog/remote-debugging-port ; https://issues.chromium.org/issues/417456892
- Contributor retrospective (Feb 2026): https://perrotta.dev/2026/02/webdriver-bidi-from-spec-to-implementation/

**Mozilla / Firefox**
- BiDi status & milestones (M17–M20): https://wiki.mozilla.org/WebDriver/RemoteProtocol/WebDriver_BiDi
- CDP retirement (Fx 141, 22 Jul 2025): https://fxdx.dev/cdp-retirement-in-firefox/ ; deprecation (Fx 129): https://fxdx.dev/deprecating-cdp-support-in-firefox-embracing-the-future-with-webdriver-bidi/ ; MDN Fx141: https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141 ; Selenium removal note: https://www.selenium.dev/blog/2025/remove-cdp-firefox/
- Remote Agent security: https://firefox-source-docs.mozilla.org/remote/Security.html ; navigator.webdriver: https://bugzilla.mozilla.org/show_bug.cgi?id=1719505 ; webSocketUrl in geckodriver: https://bugzilla.mozilla.org/show_bug.cgi?id=1693004 ; geckodriver releases: https://github.com/mozilla/geckodriver/releases
- Playwright-BiDi meta: https://bugzilla.mozilla.org/show_bug.cgi?id=1917540 ; request-body collectors: https://bugzilla.mozilla.org/show_bug.cgi?id=1988955

**WebKit / Apple / Igalia**
- Standards position (support): https://github.com/WebKit/standards-positions/issues/240
- browsingContext meta (BJ Burg): https://bugs.webkit.org/show_bug.cgi?id=281943 ; navigate (merged 23 Mar 2026): https://bugs.webkit.org/show_bug.cgi?id=288330 ; timezone override: https://bugs.webkit.org/show_bug.cgi?id=303185 ; contextCreated replay: https://bugs.webkit.org/show_bug.cgi?id=303207
- WebKitGTK 2.47.4 (BiDi experimental, 5 Feb 2025): https://www.webkitgtk.org/2025/02/05/webkitgtk2.47.4-released.html ; Igalia periodical: https://blogs.igalia.com/webkit/blog/2025/wip-12/ ; Contributors Meeting 2024: https://docs.webkit.org/Other/Contributor%20Meetings/ContributorMeeting2024.html
- Safari release notes: 26.2 https://webkit.org/blog/17640/webkit-features-for-safari-26-2/ ; 26.4 https://developer.apple.com/documentation/safari-release-notes/safari-26_4-release-notes ; 27 beta https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes ; WWDC26 WebKit: https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/ ; WWDC25: https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/
- safaridriver setup/arch: https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari ; iOS WebDriver & isolation/glass pane: https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/

**Tooling**
- Puppeteer BiDi support matrix: https://pptr.dev/webdriver-bidi ; connect-over-BiDi: https://github.com/puppeteer/puppeteer/issues/11335 ; BiDi response bodies: https://github.com/puppeteer/puppeteer/commit/b4d4d1915f729a2760a8c74b50877d92ce5e1c94
- Playwright BiDi blockers: https://github.com/microsoft/playwright/issues/32577 ; WebKit virtual authenticators ask: https://github.com/microsoft/playwright/issues/26621
- Selenium BiDi docs: https://www.selenium.dev/documentation/webdriver/bidi/ ; data collectors PR: https://github.com/SeleniumHQ/selenium/pull/16336
- Cypress 15 / Fx141: https://github.com/cypress-io/cypress/issues/32148 ; WebdriverIO BiDi: https://webdriver.io/docs/api/webdriverBidi/
- Edge WebDriver: https://learn.microsoft.com/en-us/microsoft-edge/webdriver/
- Post-136 attach breakage in the wild: https://github.com/browser-use/browser-use/issues/1520 ; https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1830
