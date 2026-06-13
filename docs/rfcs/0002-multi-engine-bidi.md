# RFC 0002 — Multi-engine browser support via a driver-port abstraction

**Date:** 2026-06-13
**Status:** Draft (research complete, all five reference lanes landed). **P0 + P1 landed** — P0 shipped the `BrowserEngine` port + `PlaywrightChromiumAdapter` extraction with zero behavior change; P1 shipped Firefox as a real second engine (`PlaywrightFirefoxAdapter` over bundled Juggler, the engine-dimension capability gate refusing the CDP-deep tools on Firefox, a real-Firefox keystone lane, a doctor Firefox check, and the per-engine capability matrix). All existing Chromium unit + keystone tests pass unchanged; see [`docs/ai-context/architecture/engine-adapters.md`](../ai-context/architecture/engine-adapters.md).
**Author:** Claude (orchestrated research + synthesis, June 2026)
**Trigger:** Owner directive — browxai must automate Firefox, Safari, and any automatable browser/mobile, staying on modern standards (WebDriver BiDi), and must decouple by adapter even from WebDriver itself. Conforms to [`docs/ai-context/architecture/architecture-principles.md`](../ai-context/architecture/architecture-principles.md).

This RFC is backed by a five-part research record in [`references/`](references/): the WebDriver BiDi standards survey, the ecosystem + Appium survey, a tool-by-tool coupling audit of browxai's own source, the machine-extracted decision matrix, and the Safari-XPC feasibility deep dive. The Selenium per-driver-protocol diagram (`references/selenium-driver-protocols.webp`) is the mental model: one stable protocol up to the driver, a per-browser native channel below it (chromedriver → CDP, geckodriver → Marionette, **safaridriver → XPC**).

## Summary

browxai today is a single-engine product: ~198 MCP tools sit on Playwright, and ~19 of them reach past Playwright into raw CDP. The coupling audit shows the good news — roughly **139 of 198 tools already use only Playwright's cross-browser surface** and would work on another engine the day the session layer stops assuming Chromium. The cost is concentrated in a handful of substrate modules and three eager `newCDPSession()` calls.

The ruling: introduce a **`BrowserEngine` driver port** beneath the tool surface, extract today's behavior as the first adapter (`PlaywrightChromiumAdapter`) with **zero behavior change** (strangler-fig), and grow engines as adapters that **declare their capabilities** rather than assume them. This is dependency inversion at the engine boundary: tools depend on the port, never on Playwright, CDP, or WebDriver. It is also the shape all four ecosystem clients (Puppeteer, Selenium, WebdriverIO, Playwright) independently converged on.

## Non-negotiable framing (from the standards research)

- **Firefox removed CDP entirely in Firefox 141** (22 Jul 2025). The only forward path to Firefox is BiDi/Marionette. Do not build Firefox on a CDP-shaped attach.
- **Chrome 136+ (May 2025) refuses `--remote-debugging-port` against the default user-data-dir** (anti-infostealer). BYOB-attach to the user's _daily_ Chrome profile is dead on stable. This is permanent.
- **Safari has not shipped BiDi** as of Safari 27 beta (WWDC26, 8 Jun 2026). safaridriver is WebDriver-Classic-only: one session, isolated automation windows, a glass pane, and **attach-to-the-live-session is impossible by design**. The WebKit _engine_ is getting BiDi (Igalia-driven, port-agnostic, `browsingContext.navigate` merged Mar 2026, Apple's BJ Burg on the meta-bug) but with zero release-note signal — plan Safari as Classic-only through at least early 2027.
- **BiDi is a W3C Working Draft, not a REC** (snapshot 1 Jun 2026), but it is the only cross-engine bidirectional protocol with momentum. Treat it as a living standard.

## The architecture

A capability-segregated port (interface segregation — an adapter implements only what its engine supports, and declares the rest as unsupported, never throwing a vague error):

```
BrowserEngine (port)
├── Lifecycle      launch / attach / contexts / close
├── Navigation     goto / waitForLoad / frames
├── Snapshot       a11y + DOM-walk substrate (ref minting)   ← hybrid per engine
├── Input          click / fill / press / gestures
├── Network        request/response/ws tap + ActionResult envelope  ← hybrid per engine
├── Storage        cookies / localStorage / IDB / caches
├── Script         evaluate / exposeBinding / preload scripts
├── Emulation      viewport / locale / UA / network conditions / clock
├── Capture        screenshot / pdf / video
└── Deep (CDP)     coverage / heap / perf / virtual-authenticator / extensions  ← capability-gated
```

Adapters: `PlaywrightChromiumAdapter` (v1, today's behavior verbatim), `PlaywrightFirefoxAdapter` (bundled Juggler), `PlaywrightWebKitAdapter`, then `BidiFirefoxAdapter` (stock Firefox), `SafariClassicAdapter`, `AndroidCdpAdapter`. Engine support is declared through the existing capability system (`util/capabilities.ts`, 181 mapped entries) extended with an **engine dimension**, so a tool that needs a CDP-deep capability is refused on engines that lack it with the already-shipped structured-refusal-with-hint pattern (the same one used for `pdf_save`-on-BYOB and `extensions`-on-incognito).

Refs are already protocol-neutral (content-hashed role/name/testId/cssPath), so they survive any snapshot substrate — this is why the abstraction is feasible without reinventing browxai's identity model.

## Decisions

**D1 — Driver abstraction shape: strangler-fig minimal-first, shaped for growth.** Make `BrowserSession.cdp()` capability-optional (lazy), thread a `browserType` option through the three session factories (`managed`/`incognito`/`byob`) and `entryFor` in `server.ts`, and keep Playwright as the sole _client library_ for the Chromium/Firefox/WebKit adapters. Do **not** build a raw-BiDi client that reimplements the Locator surface — the audit is explicit that this is "a second product, not an adaptation." But segment the port interfaces now so the Safari Classic lane and any future BiDi-attach adapter grow as new adapters, not as a rewrite.

**D2 — Firefox v1 lane: two-track.** Ship Playwright's bundled **Juggler Firefox as the supported v1 lane** (full Playwright API today — routes, video, HAR — making the ~139 class-A tools real immediately) **plus the `moz-firefox` BiDi channel behind a flag** (stock Firefox, exposed in playwright-mcp 2026-06-08 via PR #41126). Flip the default to stock-Firefox-BiDi when Mozilla Milestone 20 closes (screencast/streaming — the exact browxai tool surface that is missing today); both research reports put that in the 2026-2027 window. Prerequisite: the missing `moz-firefox` API-coverage matrix (build it as part of D2).

**D3 — BYOB per engine (mostly forced moves).**

- _Chromium:_ a separate automation `user-data-dir` is the sanctioned default post-136; `chrome.debugger` extension relay is a tracked research lane; **never promise daily-profile attach on Chrome ≥136**.
- _Firefox:_ glass-box **LAUNCH** of the user's real profile with `--remote-debugging-port` (subject to the profile lock — a second instance against an in-use profile is impossible, so true "attach to your running Firefox" requires the user to have launched it with the flag themselves). Reuse `byob.ts`'s protocol-neutral loopback/not-owned policy. Reserve `BROWX_ATTACH_BIDI` naming until a BiDi attach client exists.
- _Safari:_ structured refusal for `mode:"attached"` — isolated automation windows are the only sanctioned model.
- _Android:_ `adb` + CDP socket discovery (Playwright `_android` pattern) to the user's real Chrome-on-Android is the **one place full-fidelity BYOB to a real profile still works** — reuses browxai's CDP core verbatim.

**D4 — Snapshot/a11y substrate: hybrid behind one interface.** Keep CDP `Accessibility.getFullAXTree` on Chromium for fidelity; use `locator.ariaSnapshot()` or a page-side ARIA walker on Firefox/WebKit. The audit confirms the enablers already exist: refs are content-hashed, `bbox.ts:98` already has a Playwright `boundingBox` fallback, `dom-walk` already uses `frame.evaluate`, and closed-shadow piercing degrades to "open" (`compose.ts:76-80`, the one true feature-level loss). The ariaSnapshot-vs-walker choice is **blocked on a fidelity benchmark** (find-ranking + snapshotDelta quality vs the real AX tree) — run it before this decision freezes.

> **Implemented (P2a).** Landed behind a `SnapshotSubstrate` interface (`src/page/snapshot-substrate.ts`): `CdpSnapshotSubstrate` keeps the CDP path on Chromium verbatim (byte-identical — 71 Chromium keystones + 1663 unit tests unchanged), `PlaywrightSnapshotSubstrate` is the page-side walker on Firefox/WebKit. **The benchmark closed open input #3 toward the walker, not `ariaSnapshot()`:** on a testid-tagged fixture in real Firefox the walker carried testId on 9 nodes vs ariaSnapshot's 0, hit 4/5 find targets vs 0/5, and ran ~10× faster (10 ms vs 104 ms) — because `find` scores +5 on a testId hit and `elementKey` hashes testId into the ref, an ariaSnapshot substrate degrades both ranking and ref stability. The walker emits the existing `DomWalkEntry` shape, so the Firefox tree is byte-shape-identical to the Chromium DOM-walk leaves and refs are stable across substrates and re-snapshots. Substrate selection is the engine's (by CDP capability, via `snapshotSubstrateFor`), captured once per session (no hot-path allocation; sub-nanosecond dispatch — measured). This un-gated `snapshot`/`find`/`navigate`/`click`/`fill`/`text_search`/`extract`/`set_of_marks`/`plan` on Firefox; closed-shadow `shadow_trees` stays CDP-gated. The network slice of the action envelope is empty on Firefox until P2b (the Playwright-event tap).

**D5 — Network substrate + ActionResult envelope: hybrid, Playwright events as the portable layer.** Playwright context `request`/`response`/`websocket` events replace the CDP `NetworkTap` off-Chromium; the same port simultaneously fixes nav detection (`page.on('framenavigated')`) and un-gates every action tool's envelope. Retain CDP `NetworkTap` on Chromium. Do **not** bet the envelope on BiDi `network.getData` yet (the reports disagree on Firefox body-access maturity). **This is browxai's hottest path** — measure the envelope rebuilt on the event path against the current CDP tap before committing (no perf data exists today; per the architecture doctrine, performance is a design input and the hot path gets measured, not guessed).

**D6 — The ~19 CDP-deep tools: gate, don't port.** All three reports agree perf/coverage/heap/CPU/SW-interception are CDP-only indefinitely (even Puppeteer throws `UnsupportedOperation`). Extend `TOOL_CAPABILITY` with an engine dimension and refuse with a hint off-Chromium. **But first re-classify per the spec facts the critic re-fetched:** `pdf_save` → C (`browsingContext.print` exists; only Playwright's client throws off-Chromium), `network_emulate` → C-pending (`emulation.setNetworkConditions` is spec'd but not yet implemented over BiDi), `set_user_agent` → C (`emulation.setUserAgentOverride` is spec'd). Mandatory companion: a **Firefox keystone lane** (browserType knob through `createServer`, a per-engine skip/refusal expectation matrix, doctor engine checks) — non-negotiable under the repo's own evaluate-serialization discipline.

**D7 — Safari: playwright-webkit for engine correctness; real-Safari is a tiered companion lane (eval+DOM-grade, not CDP-grade); the XPC surface is categorically closed.** The XPC deep dive ([`references/05-safari-xpc.md`](references/05-safari-xpc.md)) settled the owner's lead with local-machine evidence: safaridriver's protocol IS the Remote Web Inspector protocol with an `Automation` target type, brokered by `webinspectord` over the `com.apple.webinspector` Mach/XPC service — and that surface is **closed to third-party code on three independent Apple gates**: the Apple-private entitlement `com.apple.private.webinspector.driver-client` (CoreTrust/AMFI won't honor `com.apple.private.*` on non-platform binaries; no provisioning profile allowlists it), and `xpc_connection_set_peer_code_signing_requirement` rejects non-Apple peers. The only direct route needs SIP disabled — non-shippable. And it would be the **wrong browser anyway**: WebDriver hard-isolates automation into a clean ephemeral window (no cookies, localStorage, Keychain, or history from the real profile), so it is structurally incapable of BYOB. Safari has not shipped BiDi (June 2026).

Rulings:

- **Engine correctness:** ship `playwright-webkit` (WebKit build, not Safari) once the session layer lands — cheap, covers the class-A surface; persistent-mode-on-WebKit is a known loss.
- **Sanctioned non-BYOB automation:** `safaridriver` (WebDriver Classic; BiDi when it ships) as a curated subset lane — isolated automation windows, macOS host. Design the capability matrix so **Safari-BiDi slots in as an engine row, not an architecture change** (watch WebKit bug 281943, Apple's BJ Burg on the meta-bug).
- **True real-Safari BYOB** (only via Apple-supported channels, both eval/DOM-grade): Tier B = an AppleScript `do JavaScript` companion (eval in the user's real page context; Automation-permission gated); Tier C = a notarized **Safari Web Extension + native-messaging companion** for DOM read/write (prior art: `safari-mcp`). No protocol-level network interception, no closed-shadow piercing — the ceiling is real and is documented as such. These are a separate companion product surface, capability-declared honestly, not a browxai engine adapter.

All reports agree 200-tool parity on Safari is impossible — the protocol ceiling, not an implementation gap.

**D8 — Mobile: Android via adb+CDP, no Appium for browsers.** Android browsers/WebViews ride `adb` + CDP (Playwright `_android` pattern), reusing the CDP core — even the CDP-deep tools work. Appium is scoped **strictly to native/hybrid app contexts and iOS device plumbing** (WebDriverAgent, RemoteXPC tunnels via Apache-2.0 `appium-ios-remotexpc` or MIT `go-ios`, never GPL-3.0 `pymobiledevice3`), and only if console/network log streams or hybrid contexts are required. Never route browsers through Appium (a server hop over the same drivers). Whether native-app contexts are in scope is a **product call** the owner makes.

## Open inputs the owner/empirics must close (tracked, not blocking)

1. **Firefox BYOB UX** — is launch-with-flag on a real profile "BYOB enough" for the brand, given the profile-lock constraint? (D3)
2. **moz-firefox API-coverage matrix** — empirical, against browxai's critical surface (addInitScript, exposeBinding, route, storageState, recordVideo, ariaSnapshot, pdf). (D2)
3. **Snapshot fidelity benchmark** — ariaSnapshot vs the real AX tree on Firefox/WebKit. (D4)
4. **ActionResult envelope perf** on the Playwright-event path vs the CDP tap. (D5)
5. **Mobile scope** — native-app contexts, or just mobile browsers? (D8)
6. **Chromium post-136 BYOB** — separate-profile vs `chrome.debugger` extension relay priority; is daily-profile attach core to the value prop? (D3)
7. **BiDi session model** — one-session-per-browser vs browxai's concurrent-session registry and incognito → BiDi user contexts. (architecture)
8. **Tool-usage telemetry** — which of the 198 tools agents actually invoke, to prioritize the ~36 class-C ports and size the Safari subset.

## Phasing (conforms to strangler-fig; gate green every step)

- [x] **P0** — `BrowserEngine` port + `PlaywrightChromiumAdapter` extraction, zero behavior change, Chromium keystone unchanged. **Landed:** port in `src/engine/`, `cdp()` made optional + routed through `requireCdp`, `browserType` threaded (default chromium) with a structured not-yet-supported error for firefox/webkit, the engine dimension on the capability system (chromium = everything), doctor + `list_sessions` report the active engine. (Task #20, #21)
- [x] **P1** — Firefox Juggler adapter + Firefox keystone lane + engine-dimension capability gating + doctor engine checks. **Landed:** `PlaywrightFirefoxAdapter` (bundled Juggler, no eager CDP) wired into the three session factories via the `browserType` dispatch; `FIREFOX_CAPABILITIES` declares `deep: false`; `assertEngineSupports`/`engineGate` structured-refuse the CDP-deep tools (audit class B + the live-CDP class-C tools) on Firefox with a hint; the three D6 re-classifications applied empirically (`pdf_save` gated with a Firefox-specific hint, `network_emulate` `refuse-pending`, `set_user_agent` no-live-PW-setter); `firefox-attach-not-supported` per D3 with `BROWX_ATTACH_BIDI` reserved; the `moz-firefox` BiDi channel behind `BROWX_FIREFOX_CHANNEL`; a real-Firefox keystone lane (class-A works + refusal asserts) via `createServer({browserType:"firefox"})`; doctor Firefox-availability check; the per-engine capability matrix (task #24) in `engine-adapters.md`. Chromium unit + keystone suites unchanged. The CDP-fed action/snapshot/network envelope substrate is P2. (Task #22, #24)
- [x] **P2a** — snapshot/a11y hybrid substrate behind the `SnapshotSubstrate` interface. **Landed:** `CdpSnapshotSubstrate` (chromium, verbatim CDP — byte-identical) + `PlaywrightSnapshotSubstrate` (firefox/webkit, the page-side `frame.evaluate` walker), selected per session by CDP capability (`snapshotSubstrateFor`) and captured once (no hot-path allocation). The snapshot-fidelity benchmark (open input #3) ran on real Firefox and chose the walker over `ariaSnapshot()` (testId + find-ranking + latency evidence). Un-gated `snapshot`/`find`/`navigate`/`click`/`fill`/`text_search`/`extract`/`set_of_marks`/`plan` on Firefox; the action window's nav detection moved to the cross-browser `page.on('framenavigated')`; `shadow_trees` (closed-shadow) added to the CDP gate. Firefox keystone extended with a `navigate → snapshot → find → fill → click` flow on real Firefox (stable refs across re-snapshot, ranked target, acted-on effect). Chromium unit (1663) + keystone (71) suites unchanged.
- **P2b** — the network substrate (CDP `NetworkTap` → Playwright `request`/`response`/`websocket` events) behind its interface + the envelope-perf benchmark (open input #4); un-gates `network_read`/`ws_read`/`network_body` and populates the action envelope's network slice on Firefox.
- **P2c** — playwright-webkit adapter (both substrates already engine-agnostic; the adapter declares its capabilities and the walker substrate serves it).
- **P3** — stock-Firefox `moz-firefox` BiDi adapter behind a flag; Android adb+CDP adapter.
- **P4** — real-Safari lane per reference 05; Safari-BiDi engine row when upstream ships.

## References

- [`references/01-webdriver-bidi-standards.md`](references/01-webdriver-bidi-standards.md) — BiDi spec module status + per-browser matrix.
- [`references/02-ecosystem-and-appium.md`](references/02-ecosystem-and-appium.md) — Playwright/Puppeteer/Selenium/WebdriverIO/Appium strategy + mobile lanes.
- [`references/03-browxai-coupling-audit.md`](references/03-browxai-coupling-audit.md) — tool-by-tool A/B/C/D classification with file:line evidence.
- [`references/04-decision-matrix.md`](references/04-decision-matrix.md) — the full critic synthesis: resolved contradictions, missing inputs, eight decisions with evidence leans.
- [`references/05-safari-xpc.md`](references/05-safari-xpc.md) — real-Safari feasibility: the `webinspectord` XPC surface is closed to third parties; the AppleScript + Web-Extension companion tiers are the only Apple-supported real-Safari channels.
- `references/selenium-driver-protocols.webp` — the per-driver-protocol mental model.
