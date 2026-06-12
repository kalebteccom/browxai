# RFC 0002 — decision matrix (research synthesis)

Machine-extracted from the June 2026 research workflow critic pass. The full reports are the sibling files in this directory. This is the decision skeleton RFC 0002 resolves; each decision carries the evidence-backed lean from the research, not the final ruling (see the RFC for rulings).

## Contradictions found across the three reports (resolved)

- pdf_save classification: the coupling audit declares 'No BiDi equivalent. D on Firefox/WebKit' (pdf.ts:19-23), but the standards report lists browsingContext.print in the core spec and the ecosystem report says Puppeteer supports PDF over BiDi. RESOLVED by WebFetch: browsingContext.print exists (spec ED §7.3.3.9) and pptr.dev confirms Page.pdf works over BiDi incl. Firefox (subset of options). The gap is client-level (Playwright's page.pdf() throws off-Chromium), not protocol-level — pdf_save should be reclassified C-on-Firefox, not D.
- User-agent override: audit says 'UA override not in BiDi' (its port note for src/session/emulation.ts), but the standards report lists emulation.setUserAgentOverride in the core emulation module. RESOLVED by WebFetch: emulation.setUserAgentOverride exists in the spec ED (§7.4.2.7). The audit is stale; per-engine implementation status (Firefox/chromium-bidi) still needs verification.
- Network throttling: audit classifies network_emulate as 'D until BiDi network throttling lands', but the standards report lists emulation.setNetworkConditions in the emulation module. RESOLVED by WebFetch: emulation.setNetworkConditions exists in the spec ED (§7.4.2.4) — however pptr.dev still lists Page.emulateNetworkConditions as unsupported over BiDi, so it is spec'd-but-not-yet-implemented. Correct classification: C-pending-implementation, not D.
- Firefox BYOB framing: the standards report calls Firefox 'the best standards-native BYOB attach story' and says 'Firefox support is cheap now', while the coupling audit classifies BYOB-attach-on-Firefox as class D — 'a raw WebDriver-BiDi client and reimplementing the Locator surface — a second product, not an adaptation'. Both are true at different layers: protocol attach is trivial (BiDi WS on --remote-debugging-port), but preserving browxai's Playwright-Locator-based tool surface over that socket is blocked because Playwright has no public connectOverBiDi. Note the standards report itself concedes the flag must be present at Firefox launch — so even protocol-level it is launch-or-glassbox, never attach-to-already-running. The RFC must not conflate the two layers.
- Video recording: the audit classifies stop_video/get_video/recordVideo as class A 'engine-agnostic' — true only on Playwright's patched Juggler Firefox / custom WebKit builds. On the stock-Firefox BiDi lane there is no screencast until Firefox M20 lands (both research reports list screen-recording as the in-flight M20 item; CONFIRMED by WebFetch: pptr.dev lists Page.screencast as unsupported over BiDi). The class-A label is conditional on which Firefox lane is chosen — the audit and ecosystem reports silently assume different lanes.
- Response-body access maturity disagreement: standards report says Firefox shipped network response bodies in M17 and data collectors 'closed the historic gap'; the audit says 'BiDi network.getData still maturing in Firefox'; the ecosystem report lists body access among Playwright's cited BiDi gaps while noting it 'since largely landed'. Not fully resolvable from sources — treat bodies-over-BiDi as landed-but-recent and verify empirically before routing network_body through it.
- clock tool mischaracterized: the standards report (§4.1) claims 'Playwright/your clock tool does JS-level shimming instead', but the audit shows browxai's clock rides CDP Emulation.setVirtualTimePolicy (clock.ts:189-203) and explicitly does NOT use the Playwright page.clock shim — the audit notes an honest port to page.clock changes documented behavior (no pauseIfNetworkFetchesPending coupling). Port-difficulty estimates that assume browxai is already on the shim are wrong.
- Playwright BiDi maturity framing drift: the standards report (§3.6) describes Playwright as 'still patched-browser custom protocols; experimental BiDi channels' with no mention of moz-firefox, while the ecosystem report documents the moz-firefox/moz-firefox-beta/moz-firefox-nightly channels exposed through playwright-mcp on 2026-06-08 (PR #41126). Facts are compatible (experimental, not default) but the standards report's framing and channel names are stale — the RFC should cite the ecosystem report's fresher data.

## Missing decision inputs (product calls / empirical gaps)

- Firefox BYOB product semantics unanswered: does launch-with-flag on the user's real profile count as BYOB? Firefox profile locking means browxai cannot start a second instance against an in-use profile — so 'attach to your daily Firefox' requires the user to have launched Firefox with --remote-debugging-port themselves. No report evaluates this UX, the profile-lock constraint, or any upstream timeline for Playwright connectOverBiDi.
- No tested API-coverage matrix of browxai's critical Playwright surface (addInitScript, exposeBinding, route/routeFromHAR, storageState, recordVideo, locator.ariaSnapshot, page.pdf) against the moz-firefox BiDi channel specifically. The audit's class-A figures implicitly assume Playwright mainline Firefox (Juggler); the research reports assume stock-Firefox BiDi — the matrix for whichever lane is chosen does not exist.
- Juggler-as-v1 unevaluated: none of the three reports weighs shipping Playwright's bundled patched Firefox (full Playwright API today, ~139 class-A tools immediately, but not stock Firefox and no BYOB) as the v1 Firefox lane versus moz-firefox/raw BiDi. The ecosystem report's 6.1 only compares moz-firefox channels vs direct BiDi.
- Plugin runtime / eval_js per-engine behavior is asserted portable ('inherits for free' — PluginApi exposes only registerTool/callTool; eval_js = page.evaluate) but has zero empirical verification: no Firefox keystone lane exists, and the repo's own discipline (docs/ai-context/page-side-functions/pattern.md) says mocked tests cannot catch evaluate-serialization failures per engine. Canvas plugin paths (toDataURL/readPixels) on Gecko/WebKit are also unverified.
- No WebDriver Classic feasibility map: the audit classified all 198 tools against Playwright/CDP/BiDi but never against Classic — the proposed 30-50-tool real-Safari/iOS lane is a guess with no per-tool mapping (Classic has no events, no interception, one session, isolated windows).
- Mobile scope ambiguity: the plan says 'Appium lane' but the ecosystem report shows Android browsers need only adb+CDP (Playwright _android pattern) and Appium adds value only for native/hybrid contexts and iOS plumbing. Missing product input: are native-app contexts in scope, or just mobile browsers? Also unverified: whether Chrome 136+'s anti-infostealer restriction has any Android analogue affecting attach to the user's real Android Chrome profile via localabstract:chrome_devtools_remote.
- BiDi session model vs browxai's session registry: BiDi is one session per browser in practice (w3c/webdriver-bidi#103 open). How browxai's multiple concurrent sessions and incognito mode map onto BiDi user contexts within a single Firefox instance is unaddressed by all three reports.
- No snapshot-substrate fidelity benchmark: ariaSnapshot()/page-side ARIA walker output has never been compared against CDP Accessibility.getFullAXTree for ref-minting, find ranking, and snapshotDelta quality on Firefox/WebKit — the D4 decision below cannot be finalized without it.
- No tool-usage telemetry: nothing says which of the 198 tools agents actually invoke, which is needed to prioritize the ~36 class-C ports and validate the Safari subset size.
- Chromium post-136 BYOB needs a product call with no data: separate user-data-dir profile vs chrome.debugger extension relay are different trust/installation models; whether daily-profile attach is core to browxai's value proposition is asserted nowhere.
- Per-engine implementation status of the newly-confirmed spec commands (emulation.setUserAgentOverride, emulation.setNetworkConditions) in Firefox and chromium-bidi is unverified — Puppeteer still throws for network conditions over BiDi, so spec presence alone cannot drive the set_user_agent/network_emulate classifications.
- No performance measurement of the ActionResult envelope rebuilt on Playwright events vs the current CDP NetworkTap (browser-use's raw-CDP latency argument cuts against the portable path); the per-action envelope is browxai's hottest path and the port decision has no perf data.

## The decisions

### D1. How does multi-engine support enter the session layer — minimal Playwright-internal change or a full protocol-pluggable driver abstraction?

Options:
- Minimal: make BrowserSession.cdp() optional/lazy (src/session/types.ts:76), thread a browserType option through the three factories (managed.ts:68, incognito.ts:52, byob.ts:55) and entryFor in server.ts, keep Playwright as the sole client library
- Protocol-pluggable driver layer (CDP / BiDi / Classic adapters) beneath the tool surface, with Playwright as one driver among several
- Per-engine sibling servers sharing the tool registry (no shared session abstraction)

**Evidence lean:** Minimal first: the audit shows the only hard gate is one mandatory interface member plus three eager newCDPSession calls, and ~139/198 tools are already pure Playwright surface; a raw-BiDi driver means reimplementing the Locator surface ('a second product'). But shape the interfaces so option 2 can grow in later — the Safari Classic lane and any future Firefox BiDi attach will force a partial driver abstraction anyway, which is also where all four ecosystem clients (Puppeteer, Selenium, WebdriverIO, Playwright) independently converged.

### D2. Which Firefox lane is v1: Playwright's bundled patched Firefox (Juggler), the experimental moz-firefox BiDi channels, or a raw BiDi client?

Options:
- Bundled Juggler Firefox — full Playwright API today (routes, video, HAR), unlocks the class-A surface immediately, but not stock Firefox and structurally no BYOB
- moz-firefox BiDi channels (stock Firefox, exposed in playwright-mcp 2026-06-08 via PR #41126) — strategic lane, but experimental with gaps (no screencast until Mozilla M20; Playwright meta-bug 1917540 at 26/37 resolved)
- Raw WebDriver BiDi client against --remote-debugging-port — maximal control and the only route to Firefox glass-box launch, at the cost of rebuilding the Locator/page surface
- Two-track: Juggler as the supported v1 lane plus moz-firefox behind a flag, flipping default when M20 closes (2026-2027 window per both research reports)

**Evidence lean:** Two-track (option 4): Juggler is the only path that makes the audit's '139 class-A tools' true today including video/HAR; moz-firefox is the confirmed direction of travel (Playwright's own MCP exposes it) but its screencast/streaming gaps are exactly browxai tool surface. Raw BiDi only if Firefox BYOB becomes a committed product feature (see BYOB decision). Prerequisite either way: the missing moz-firefox API-coverage matrix.

### D3. What is the BYOB story per engine now that Chrome 136+ blocks default-profile attach, Firefox has no Playwright attach client, and Safari forbids attach by design?

Options:
- Chromium: separate user-data-dir automation profile as the sanctioned default (post-136 reality), with chrome.debugger extension relay as a tracked research lane; never promise daily-profile attach on Chrome >=136
- Firefox: ship glass-box LAUNCH of the user's real profile with --remote-debugging-port (subject to profile lock), reuse byob.ts's protocol-neutral loopback/not-owned policy, reserve attached-Firefox naming (BROWX_ATTACH_BIDI) until Playwright grows connectOverBiDi or a raw BiDi attach client is funded
- Safari: structured refusal for mode:'attached' — isolated automation windows with glass pane are the only sanctioned model, attach is impossible by design
- Android: adb+CDP attach to real Chrome-on-Android (localabstract:chrome_devtools_remote) as the one place full-fidelity BYOB to a user's real profile still works

**Evidence lean:** These are mostly forced moves, not choices — the real decisions are (a) Chromium: separate-profile vs extension-relay priority (needs the missing product input), and (b) whether Firefox launch-mode satisfies the BYOB-first brand. Evidence: Chrome blog + ecosystem breakage issues confirm 136+ is permanent; the audit confirms byob.ts policy (loopback allowlist, not-owned detach) ports as-is while the transport does not; the contradiction analysis confirms Firefox attach-to-running is impossible at every layer (flag must be present at launch AND no client exists).

### D4. How is the snapshot/a11y substrate (a11y.ts, dom-walk.ts, bbox.ts, compose.ts, shadow.ts — ~1,800 lines feeding ~30 tools plus every snapshotDelta) made cross-engine?

Options:
- Playwright locator.ariaSnapshot() per engine (cross-browser, different shape, loses backendDOMNodeId keying)
- Page-side ARIA walker via page.evaluate (full control, main-world, follows the repo's fixed-function-literal pattern; fidelity vs the real AX tree unproven)
- Hybrid: keep CDP Accessibility.getFullAXTree on Chromium for fidelity, use ariaSnapshot or the walker on Firefox/WebKit behind one substrate interface

**Evidence lean:** Hybrid: the audit shows refs survive any substrate (content-hashed role/name/testId/cssPath, protocol-neutral), bbox already has a Playwright boundingBox fallback (bbox.ts:98), the frame-scoped dom-walk already uses frame.evaluate, and closed-shadow piercing degrades to 'open' via an existing degrade path (compose.ts:76-80, the one true feature-level D). The ariaSnapshot-vs-walker choice within the hybrid is blocked on the missing fidelity benchmark — run it before the RFC freezes.

### D5. How is the network substrate and ActionResult envelope (NetworkTap/NetworkBuffer/WsBuffer + actionresult.ts, ~900 lines feeding network_read/ws_read and every action's envelope) made cross-engine?

Options:
- Playwright context request/response/websocket events as the portable layer (cross-engine today; documented field degrades — resourceType nuance, timings; network_body must capture at response time)
- BiDi network module + data collectors directly (stock-Firefox-native; bodies landed M17 but maturity disputed across the reports)
- Hybrid: keep CDP NetworkTap on Chromium, Playwright events elsewhere, behind one tap interface

**Evidence lean:** Hybrid with Playwright events as the portable implementation: the audit names them the cross-browser replacement and the same port simultaneously fixes nav detection (page.on('framenavigated')) and un-gates all ~18 action tools' envelopes at once. Do not bet the envelope on BiDi getData yet (maturity contradiction unresolved). Caveat: no perf data exists for the envelope on the event path — measure before committing (missing input).

### D6. Gate or port the ~19 class-B Chromium-deep tools, and what per-engine capability/test machinery enforces the answer?

Options:
- Gate: extend the existing TOOL_CAPABILITY layer (util/capabilities.ts, 181 mapped entries) with an engine dimension and reuse the structured-refusal-with-hint pattern (already shipped for pdf_save-on-BYOB, extensions-on-incognito)
- Port per engine: e.g. Gecko profiler backend for perf tools, web-ext mechanism for Firefox extensions
- Silent degradation (return empty/approximate results off-Chromium)

**Evidence lean:** Gate, decisively: all three reports agree perf/coverage/heap/cpu/SW-interception are CDP-only indefinitely (even Puppeteer throws UnsupportedOperation), and the audit calls a Gecko-profiler lane 'a separate implementation, not an adaptation'. But first re-audit the B/D list against the WebFetch-resolved spec facts: pdf_save → C (browsingContext.print), network_emulate → C-pending (emulation.setNetworkConditions spec'd), set_user_agent → C (emulation.setUserAgentOverride spec'd). Mandatory companion decision: a Firefox keystone lane (browserType knob through createServer, per-engine skip/refusal expectation matrix, doctor engine checks) — non-negotiable per the repo's own evaluate-serialization discipline.

### D7. What does 'Safari support' mean: playwright-webkit engine coverage, a curated real-Safari Classic lane, or wait for Safari BiDi?

Options:
- playwright-webkit only — WebKit-engine correctness lane, works with the class-A surface today (minus persistent mode, touch injection), but is a custom WebKit build, not Safari
- Add a curated 30-50-tool WebDriver Classic lane over safaridriver — real Safari desktop + iOS, always-isolated automation windows, macOS host required, no events/interception
- Defer real Safari until BiDi ships in safaridriver (Igalia/WebKitGTK plumbing landing, Apple's BJ Burg engaged, but zero release-note signal through Safari 27 beta — Classic-only through at least early 2027)
- Buy real-iOS-Safari coverage from cloud farms (BrowserStack/LambdaTest commercialized exactly this gap)

**Evidence lean:** playwright-webkit now (cheap once the session layer lands; persistent-mode-on-WebKit is a known D), with the Classic lane as a separately-scoped product decision — it cannot be sized until the missing Classic feasibility map exists, and all reports agree 200-tool parity on Safari is impossible (protocol ceiling is real). Watch WebKit bug 281943 and Safari release notes for the BiDi flip; design the capability matrix so Safari-BiDi slots in as an engine row, not an architecture change.

### D8. What is the mobile lane architecture — and is Appium in it?

Options:
- Android browsers/WebViews via adb + CDP socket discovery (Playwright _android pattern), reusing the existing CDP core verbatim — no Appium; even the T3 CDP-deep tools work
- Appium scoped strictly to native/hybrid app contexts and iOS device plumbing (WebDriverAgent, RemoteXPC tunnels) — the only things it uniquely owns; its BiDi is events-only, never a command path
- Full Appium lane fronting all mobile browsers (as the current plan's phrasing implies)
- Cloud device farms for real-iOS-Safari coverage without owning the plumbing

**Evidence lean:** Option 1 for Android is near-free and high-fidelity per the ecosystem report; option 3 is explicitly anti-recommended ('do not route browsers through Appium' — thin wrappers over the same drivers plus a server hop). iOS real Safari rides the Classic/safaridriver decision above, with Appium XCUITest only if console/network log streams or hybrid contexts are required; avoid GPL-3.0 pymobiledevice3 in favor of Apache-2.0 appium-ios-remotexpc or MIT go-ios. The whole decision is partially blocked on the missing product input: are native-app contexts actually in scope, or did 'Appium lane' just mean 'mobile browsers'?

