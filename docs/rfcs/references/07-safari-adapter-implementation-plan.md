# Safari engine — implementation plan & handoff (RFC 0002 P4)

**Date:** 2026-06-13 · **Status:** IN PROGRESS — docs landed; **Increments 1 (transport + adapter + engine declaration) & 2 (snapshot substrate) LANDED & gate-green** (1756 unit tests); Increments 3–5 remain. **NEXT = Inc 3: the no-Playwright-Page session seam + action seam (the big one) — make `safari` operator-reachable.** **Author:** Claude (probe + spike + validated plan). **Read this first if you are picking up the real-Safari engine.** It is the single source for continuing the `SafaridriverHybridAdapter` build. Pairs with [`06-safari-bidi-probe.md`](06-safari-bidi-probe.md) (the empirical capability evidence) and the RFC's D7 / line-20 / P4 (corrected by this workstream).

---

## 0. TL;DR for the next agent

- **What this is:** add real Safari (`safaridriver`, non-BYOB isolated automation windows) as the **5th** `BrowserEngine` adapter — the **FIRST non-Playwright adapter**. Classic WebDriver is the workhorse; experimental BiDi is the additive bidirectional layer.
- **Already done & committed** (`de8636f` on `main`): the RFC correction (Safari DOES ship partial BiDi) + the empirical evidence doc `06-safari-bidi-probe.md`. The probe + spike are reproducible (scripts in [`safari-probe/`](safari-probe/)).
- **Decisively de-risked:** (a) Safari 26.5 ships a real WebDriver BiDi socket behind the vendor cap `safari:experimentalWebSocketUrl:true`; (b) WebDriver Classic is a complete workhorse; (c) **browxai's exact DOM-walk `PAGE_SCRIPT` returns the identical `DomWalkEntry` shape under Classic `execute/sync`** — so the Safari snapshot substrate is feasible (RFC open-Q#7 CLOSED, see §4).
- **The hard part (NOT a normal adapter):** the `BrowserEngine` port and the whole session/server layer are built on a Playwright `Page`. Safari has none. This is a **session-layer seam**, not just a new adapter file. See §3 — this is why it's the biggest engine add.
- **Build is staged into 5 gate-green increments** = tasks #31–#35 (§6). Increment 1 (transport + adapter + engine declaration, unit-tested, NOT yet operator-reachable) is the safe first commit.
- **Repo rules:** browxai AGENTS.md governs. Full gate: `typecheck` / `test` / `test:keystone` / `lint` / `format:check` / `build` / `docs:build`. Single-line conventional commits ≤72 chars, **NO trailers** (the commit-msg hook rejects multi-line/trailer subjects — run each `git commit` as its OWN command, never chained with `&&`). Explicit `git add <files>` only; never `-A`. The owner's uncommitted `.gitignore` (`.scratch/`) edit stays untouched.

---

## 1. The empirical ground truth (from the probe — full detail in 06)

Host: macOS 26.5 (build 25F71), Safari 26.5 (`21624.2.5.11.4`), Apple Silicon. Node v22.15.0 (built-in global `WebSocket`, no `ws` dep). `safaridriver` at `/usr/bin/safaridriver` → `/System/Cryptexes/App/usr/bin/safaridriver`. **No `safaridriver --enable` / sudo was needed on this host** (Allow Remote Automation already permitted; on a fresh host expect to need it — map the session-create failure to a `safari-remote-automation-disabled` structured error pointing at `safaridriver --enable` + Develop-menu "Allow Remote Automation").

**Launch:** `safaridriver -p 4444 --bidi 9223` → listens on 4444 (HTTP/WebDriver). The `--bidi <port>` value is NOT the listen port; the BiDi socket is allocated dynamically and reported in the granted caps. **One session at a time** (a 2nd concurrent `POST /session` fails).

**BiDi gating (load-bearing):** `{webSocketUrl:true}` alone → granted caps echo a boolean `"webSocketUrl":true` + `"safari:experimentalWebSocketUrl":false`, **no socket**. Add `{"safari:experimentalWebSocketUrl":true}` → granted `"webSocketUrl":"ws://127.0.0.1:<port>/session/<uuid>"` + a live listener.

**BiDi module coverage (live):**

- **OK:** `session.status/subscribe`; `browsingContext.getTree/navigate/setViewport/activate/create`; `script.evaluate/callFunction/getRealms/addPreloadScript`; `network.setCacheBehavior`.
- **Events that fired:** `browsingContext.navigationStarted/navigationCommitted/domContentLoaded/load`; `log.entryAdded`.
- **MISS (domain/command absent):** `browsingContext.captureScreenshot`, `browsingContext.locateNodes`, `network.addIntercept` (the `network` domain beyond setCacheBehavior), all of `input`, all of `emulation`, `webExtension`.
- **ERR (present but throws `InternalError`):** `storage.getCookies`, `storage.setCookie`.

**WebDriver Classic (same driver, plain session) — ALL OK:** navigate, screenshot (PNG), findElement, element.text/click, getCookies, executeScript, sendKeys. **Classic is the complete workhorse.**

**Hybrid synthesis:** Classic owns Input, Capture/screenshot, cookies, navigation, exec. BiDi owns Script (multi-realm + preload), browsingContext nav/lifecycle/viewport, and live events (`log.entryAdded` + nav). Gated (unavailable on real Safari at all): network observation/interception, all CDP-deep tools, BiDi input/emulation/screenshot/locateNodes, storage-over-BiDi. **Non-BYOB** always (isolated ephemeral automation windows — BYOB to the real logged-in Safari is categorically closed per `05-safari-xpc.md`; unchanged).

**iOS:** out of this adapter's scope but feasible — Xcode + iOS 26.5 Simulator runtime present on this Mac (also 17.2, 16.2). Mobile Safari driveable via simulator (WebKit remote inspector) or Appium-XCUITest for real devices. Track separately.

---

## 2. Capability declaration for `safari`

Add to `src/engine/capabilities.ts` (mirroring the others). Safari serves a **curated subset** — this is the honest sub-interface set:

```ts
export const SAFARI_CAPABILITIES: EngineCapabilities = {
  engine: "safari",
  // lifecycle/navigation/snapshot/input/storage/script/capture = YES (Classic + BiDi);
  // NETWORK omitted (no tap/interception at all — worse than firefox/webkit);
  // EMULATION omitted (only browsingContext.setViewport works; gate the rest);
  subInterfaces: new Set(["lifecycle", "navigation", "snapshot", "input", "storage", "script", "capture"]),
  deep: false, // no CDP on Safari at all — gates the ~26 CDP-deep tools via the existing caps.deep gate
};
```

**Caveat the gate does not yet handle:** `tool-gate.ts` currently refuses only on `deep:false` (the CDP-deep family). The **network** family (`network_read`/`ws_read`/`network_body`/`route`/`start_har`) is NOT in `DEEP_TOOLS`; on firefox/webkit those are tracked as P2b SKIPs (substrate present), but on Safari there is **no network substrate at all** so they must actively REFUSE. That needs a new **sub-interface gate** (`assertEngineSubInterfaceSupports`) wired into the network tool handlers in `server.ts` (the existing engine gate at ~`server.ts:1184` only covers `DEEP_TOOLS`). This is the genuinely-new gating posture — see §6 task #35.

---

## 3. THE CRUX — the no-Playwright-Page seam (why this is the biggest engine add)

Every prior engine returned a real Playwright `Page`: chromium/firefox/webkit are Playwright builds; android attaches via `connectOverCDP` and gets a real `Page` + `CDPSession`. **Safari is the first engine with neither Playwright nor CDP.** The port leaks Playwright types throughout:

- `src/engine/types.ts:79-88` — `EngineSession.page(): Page`, `context(): BrowserContext` (from `playwright-core`), mandatory.
- `src/session/types.ts:81-101` — `BrowserSession.page(): Page` (line 86); `SessionInternals { context: BrowserContext; page: Page; cdp: CDPSession }` (96-101) — Playwright/CDP-typed, consumed everywhere.
- `src/engine/tool-gate.ts:131-146` — keys on `caps.deep` (GOOD: auto-refuses the ~26 CDP-deep tools on Safari with **zero gate edits**, open/closed-correct).
- **Action core (Playwright-bound — the verifier's load-bearing gap, NOT in the original 8-file plan):**
  - `src/page/locator.ts` — `locatorFor(page, …)` / `resolveTarget` / `resolveTargetChecked` (`locator.ts:31-59`) return a Playwright `Locator`.
  - `src/page/actions.ts` — calls `.click()` / `.fill()` / `page.mouse.click()` on the Locator (`actions.ts:37,69,123,125,213`).
  - `src/page/actionresult.ts` — the per-action envelope hardcodes `ctx.page.url()` / `ctx.page.on("framenavigated")` / `ctx.page.mainFrame()` / `ctx.page.waitForLoadState()` (`actionresult.ts:432-493`). EVERY click/fill/navigate builds this envelope.
  - `src/page/refs.ts` — `bindFrame` binds Playwright `Frame` handles (`refs.ts:80,142`); BUT `elementKey` content-hashed keys ARE portable (reuse them verbatim).
  - `src/page/console.ts` — `ConsoleBuffer.attach(page)` hooks `page.on('console')` / `page.on('pageerror')` (`console.ts:35-40`).
- **`src/server.ts` session-creation block (~838-1011): ~20+ direct `sess.page()` / `.context()` consumers** — `applyHarReplay`, `ConsoleBuffer`, `networkSubstrateFor`, `BrowxBridge.attach`, `attachDialogPolicy`, `PermissionPolicyState`+`applyPermissionCdpBaseline`, `attachNotificationPolicy`, `attachDownloadCapture`, `applyOverlayHide`, `applyStealth`, `attachDeviceEmulation`, the `targetcreated` CDP reapply, snapshot-substrate wiring. `applyPermissionCdpBaseline` (`server.ts:893`) and the `targetcreated` `newCDPSession` reapply (`server.ts:1011`) are CDP-specific → **hard-skip** on Safari, not "gate".
- `src/session/registry.ts:289` — `entries = new Map<…>` with no concurrency cap (N concurrent sessions assumed). Safari's **one-session-at-a-time** constraint conflicts — DECIDE: adapter-level reject-2nd vs registry-level serialize.

### Chosen design (recommended, decide explicitly at implementation)

1. **`EngineSession.page()` on Safari throws a structured `safari-no-playwright-page`** (option (a)). Add a native handle: widen `EngineSession` with `native?(): SafariNativeHandle` (the `SafariWebDriverClient` + optional `SafariBidiClient`) — option (c). Recommendation = (a)+(c).
2. **Gate the curated subset UP FRONT.** The tool-gate refuses every tool that isn't on the Safari-supported list BEFORE it reaches `page()`. So `page()` is only reached by supported tools, which route to Safari-native paths. This bounds the blast radius.
3. **A single engine guard** in the `server.ts` session-creation block: `if (engine === "safari") { …Safari-native wiring… } else { …existing Playwright wiring… }` — skips ConsoleBuffer-on-page (use a BiDi-fed console source instead), BrowxBridge, dialog/permission/notification policies, HAR/video, device emulation, the CDP baseline + targetcreated reapply.
4. **Supported tools route through seams:** snapshot/find/text_search/extract via the new `SafariClassicSnapshotSubstrate` (§4); click/fill/press via a new **action seam** over `SafariWebDriverClient` element click/value/clear; navigate/screenshot/cookies/eval via direct Classic; console via BiDi `log.entryAdded`. Network = refuse. Everything CDP-deep = refuse (caps.deep). Most other class-A tools that need a raw Playwright Page = **gated** (the curated-subset reality — RFC D7 always said 200-tool parity on Safari is impossible).

> **Strangler-fig discipline:** keep `safari` OUT of `IMPLEMENTED_ENGINES` (src/engine/select.ts:26) until it works end-to-end, so `--engine safari` keeps giving the structured `UnknownEngineError` (which already has a Safari→RFC note at select.ts:70) and main is never half-broken. Flip it on in the final integration increment.

---

## 4. The snapshot substrate — feasibility PROVEN (open-Q#7 closed)

The spike (`safari-probe/safari-substrate-spike.mjs`) ran browxai's **exact** `PAGE_SCRIPT` (extracted from `src/page/dom-walk.ts:143`, eval'd so source `\\s` → runtime `\s`) via Classic `POST /session/<id>/execute/sync` `{script:"return ("+PAGE_SCRIPT+")(arguments[0],arguments[1],arguments[2])", args:[testAttrs,max,walkOpen]}`. Result on a 5-element fixture: identical `DomWalkEntry` shape — role/name/testId/testIdAttr/tag/id/structuralPath/cssPath all present, `data-testid=go` captured, aria-label name resolution worked, cssPath non-empty on all. **The walker is portable to Classic verbatim.**

Implementation: `src/page/snapshot-substrate-safari.ts` — `SafariClassicSnapshotSubstrate implements SnapshotSubstrate` (interface at `src/page/snapshot-substrate.ts:46`). Mirror `PlaywrightSnapshotSubstrate` (same file, line 102) but replace `runDomWalkOnFrame(this.page.mainFrame(), …)` with a call that ships `PAGE_SCRIPT` through `SafariWebDriverClient.executeScript`. Reuse `mergeDomWalkIntoTree` + `elementKey` + `annotateStructuralContext` verbatim — refs stay stable across substrates. Wire `src/page/snapshot-substrate-select.ts` (`snapshotSubstrateFor`) to pick the Safari substrate for engine `safari` (it currently keys on CDP presence → would fall to the Playwright walker, which needs a Page Safari lacks; add an explicit safari branch).

---

## 5. The validated 8-new / 18-edited file plan (from the orchestrated workflow)

Adapter name: **`SafaridriverHybridAdapter`** (`src/engine/adapters/safaridriver-hybrid.ts`), with transport split into `src/engine/adapters/safari/` (mirrors how `android-cdp.ts` factors transport into `adb.ts`).

**New files (8 in the plan + the action seam the verifier added):**

1. `src/engine/adapters/safaridriver-hybrid.ts` — the adapter (5th, first non-Playwright). Owns lifecycle: spawn safaridriver, `POST /session` with `{webSocketUrl:true,"safari:experimentalWebSocketUrl":true}`, open the BiDi ws when granted a real `ws://` URL. `launchManaged` (ONE isolated automation window); `attach()` structured-refuses (`safari-attach-not-supported` — hard-isolated, BYOB impossible, like webkit). Returns a Safari-native session, NOT a Playwright Page.
2. `src/engine/adapters/safari/webdriver-client.ts` — `SafariWebDriverClient` (Classic HTTP, the workhorse). Wraps: `POST /session` (+caps negotiation), `DELETE /session`, `POST url`, `GET screenshot`, `POST element`/`elements`, element `click`/`value`/`text`/`clear`, `GET/POST cookie(s)`, `POST execute/sync`. Pure `fetch` over loopback; injectable for tests (the IO seam, like `AdbRunner`/`Fetcher` in `adb.ts`).
3. `src/engine/adapters/safari/bidi-client.ts` — `SafariBidiClient` (BiDi WebSocket, behind the negotiated experimental cap). Node global `WebSocket` (no dep). Implements ONLY the live subset (§1): session.subscribe; browsingContext.navigate/setViewport/activate/create/getTree; script.evaluate/callFunction/getRealms/addPreloadScript; and surfaces the events that fired (browsingContext nav-lifecycle + `log.entryAdded`). Everything the probe found MISSING is NOT implemented here.
4. `src/engine/adapters/safari/launch.ts` — safaridriver spawn (`/usr/bin/safaridriver`) + readiness poll (`GET /status`) + parse granted-caps `webSocketUrl` + process-kill teardown. Structured errors: `safari-unavailable` (not macOS / binary absent), `safari-remote-automation-disabled` (session create rejected → `safaridriver --enable` hint), `safari-session-busy` (2nd-POST failure).
5. `src/page/snapshot-substrate-safari.ts` — `SafariClassicSnapshotSubstrate` (§4).
6. `src/engine/adapters/safaridriver-hybrid.test.ts` — adapter orchestration, mocked client/bidi/spawn (binary-free, like `android-cdp.test.ts`): caps negotiation (experimental cap → real ws vs boolean placeholder), one-session-at-a-time refusal, BiDi-absent degradation, structured launch/attach refusals.
7. `src/engine/adapters/safari/webdriver-client.test.ts` — Classic client request-shaping + response-unwrapping vs a mock fetch.
8. `test/keystone/safari.keystone.test.ts` — real-Safari keystone. Sync availability probe at module load (`statSync('/usr/bin/safaridriver')` + macOS check) + `describe.skip` otherwise (green on Linux/CI; mirrors webkit/firefox/android keystones). When present: `createServer({browserType:"safari"})` → open_session → assert `list_sessions.engine==="safari"`; navigate → snapshot → find → fill → click (Classic substrate); cookies + screenshot (Classic); `console_read` surfacing a `log.entryAdded` line (BiDi); and assert the gated families structured-refuse with `engine:"safari"`.
   - **PLUS (verifier addition): the action seam** — `actions.ts`/`actionresult.ts`/`locator.ts` need a non-Playwright path. Either an `ActionSubstrate` seam (parallel to `SnapshotSubstrate`) or a Safari action-window that derives nav lifecycle from BiDi events / Classic url-poll instead of `page.on('framenavigated')`. **This is bigger than the snapshot port and was UNDER-scoped in the original plan — budget for it.**

**Edited files (18):** `src/engine/types.ts` (EngineKind + ENGINE_KINDS + the `native?()` widening), `src/engine/select.ts` (IMPLEMENTED_ENGINES + BROWSER_TYPES — note safari does NOT map to a Playwright BrowserType; the adapter is non-Playwright, so `resolveBrowserType` must special-case or not be used for safari), `src/engine/capabilities.ts` (SAFARI_CAPABILITIES + DECLARATIONS), `src/engine/tool-gate.ts` (sub-interface gate for network/emulation), `src/engine/index.ts` (exports), `src/session/types.ts`, `src/session/managed.ts`, `src/session/incognito.ts`, `src/session/byob.ts` (+ fix the stale Safari comment at `byob.ts:174-178` which is now empirically false), `src/server.ts` (the ~20-consumer engine guard), `src/page/snapshot-substrate-select.ts`, `src/page/network-substrate-select.ts`, `src/cli/doctor.ts` (safari availability check), `docs/ai-context/architecture/engine-adapters.md` (capability-matrix row), `docs/rfcs/0002-multi-engine-bidi.md` (already corrected — keep P4 in sync as it lands), `docs/rfcs/references/05-safari-xpc.md` (cross-link), `src/engine/select-operator.test.ts` (lines 16/30/38 hardcode the 4-engine list `['chromium','firefox','webkit','android']` + the message assertion; lines 84-91 assert `BROWX_ENGINE=safari` / `--engine safari` THROW — these flip once safari is in IMPLEMENTED_ENGINES, so update in the FINAL increment), `src/engine/capabilities.test.ts`.

---

## 6. The build, staged into 5 gate-green increments (= tasks #31–#35)

Each increment is independently committable with the gate green. Land them in order.

- **Inc 1 / task #31 — transport + adapter + engine declaration (unit-only, NOT operator-reachable). ✅ LANDED 2026-06-13.** Commits: `8ec0a25` (SafariWebDriverClient), the BiDi client commit, `…` (launch + SafaridriverHybridAdapter + `SAFARI_CAPABILITIES` + `EngineKind` += safari + index exports + engine.test update). 28 new unit tests; full gate green (1750 unit). `safari` is in `ENGINE_KINDS` + has a capability declaration + an adapter, but is deliberately NOT in `IMPLEMENTED_ENGINES` (select.ts) — `--engine safari` still structured-refuses until Inc 3 wires the session seam. Files added: `src/engine/adapters/safari/{webdriver-client,bidi-client,launch}.ts` (+ tests) + `src/engine/adapters/safaridriver-hybrid.ts` (+ test). `BROWSER_TYPES` in select.ts is now `Partial<Record<EngineKind,BrowserType>>` (safari has no Playwright BrowserType) with a guard in `resolveBrowserType`. **NOTE for Inc 3:** the adapter currently returns a `SafariSessionHandle` (its own shape), NOT an `EngineSession` — wiring it into the session layer (the no-Page seam) is the remaining integration.
- **Inc 2 / task #32 — snapshot substrate. ✅ LANDED 2026-06-13.** `src/page/snapshot-substrate-safari.ts` (`SafariClassicSnapshotSubstrate`) runs the DOM-walk via a new transport-agnostic `runDomWalkViaExecute(exec, opts)` export in `dom-walk.ts` (keeps `PAGE_SCRIPT` encapsulated); it depends only on a tiny `SafariSnapshotIO {exec, currentUrl}` seam so the page layer stays decoupled from the adapter. 6 unit tests (mock IO replaying the spike's `DomWalkEntry` JSON; asserts WebArea root, stable refs across snapshots, testId survival, pierce-closed degrade, empty-page). **NOTE:** the `snapshot-substrate-select.ts` wiring is deliberately NOT changed yet — `snapshotSubstrateFor` needs `page()`, which Safari lacks, so the selector branch joins the session seam in Inc 3 (the substrate is ready, just not yet selected).
- **Inc 3 / task #33 — the no-Page session seam + action seam (THE BIG ONE).** Make safari reachable end-to-end for the curated subset: SafariSession (BrowserSession impl) with `page()` structured-refusing + native handle; the `server.ts` engine guard; the action seam (click/fill via Classic); flip safari INTO `IMPLEMENTED_ENGINES`. Update `select-operator.test.ts` here. Gate green incl. the safari keystone (file 8) — NOTE it opens REAL Safari windows on this Mac (no headless).

  **Code-confirmed integration design (verified against `managed.ts` + `session/types.ts` @ Inc-2 main):**
  1. **`BrowserSession` (session/types.ts:81-94):** add `readonly safari?(): SafariSessionHandle` (the native handle — the adapter's `SafariSessionHandle` from `safaridriver-hybrid.ts`, exposing `webDriver`/`bidi`/`sessionId`). `page(): Page` stays in the interface; the Safari impl's `page` is `() => { throw new Error("safari-no-playwright-page: …") }` (typed `() => never`, assignable to `() => Page`). `cdp` stays absent.
  2. **`openManagedSession` (managed.ts:17):** add a `engine === "safari"` branch BEFORE the Playwright block — `const adapter = new SafaridriverHybridAdapter(); const handle = await adapter.launchManaged();` then `return { mode:"managed", ownsBrowser:true, engine, page:()=>{throw…}, safari:()=>handle, close:()=>handle.close() }`. Do NOT touch the chromium/firefox/webkit path. (incognito.ts/byob.ts: safari → structured refusal — managed/isolated only.)
  3. **`snapshotSubstrateFor` (snapshot-substrate-select.ts:35):** add `if (session.engine === "safari" && session.safari) return new SafariClassicSnapshotSubstrate(safariSnapshotIO(session.safari()))` BEFORE the `cdp`/page branch. `safariSnapshotIO(handle)` = `{ exec:(s,a)=>handle.webDriver.executeScript(handle.sessionId,s,a), currentUrl:()=>handle.webDriver.currentUrl(handle.sessionId) }`. (Widen `SubstrateCapableSession` with the optional `safari?()`.)
  4. **`server.ts` session-creation block (~838-1011):** wrap the Playwright-only bookkeeping (ConsoleBuffer.attach(page), BrowxBridge.attach(context), dialog/permission/notification policies, applyHarReplay, applyPermissionCdpBaseline, the `targetcreated` CDP reapply, attachDeviceEmulation, applyStealth/Overlay) in `if (sess.engine !== "safari") { … }`. Safari gets a minimal branch: wire the snapshot substrate (via #3) + (Inc 4) the BiDi console source. The network substrate is NOT wired (gated).
  5. **Action seam (the genuinely new abstraction):** `actions.ts`/`actionresult.ts`/`locator.ts` call Playwright `Locator`/`page.*`. Introduce an `ActionSubstrate` (parallel to SnapshotSubstrate): `{ click(ref), fill(ref,text), press(ref,key)?, … }` resolved per session. Chromium/FF/WebKit/Android impl wraps the existing Playwright `locatorFor`; Safari impl resolves a ref → a WebDriver element (via the ref's `cssPath` from the snapshot, `findElement(sessionId,"css selector",cssPath)`) → `elementClick`/`elementValue`/`elementClear`. The action-window envelope (`actionresult.ts:432-493`) needs a Safari path that reads `currentUrl()` + (Inc 4) BiDi nav events instead of `page.on('framenavigated')`/`waitForLoadState`. **Budget this as the largest sub-piece.**
  6. **Flip on:** add `"safari"` to `IMPLEMENTED_ENGINES` (select.ts:26) + `BROWSER_TYPES` stays Partial (no safari entry — the managed path bypasses `resolveBrowserType` for safari). Update `select-operator.test.ts` (lines 16/30/38 engine-list + 84-91 safari-throws → now resolves) + `engine.test.ts` "not operator-reachable" test.
  7. **Keystone (file 8):** `createServer({browserType:"safari"})` end-to-end; skip-when-absent (statSync + darwin). Opens REAL windows.
- **Inc 4 / task #34 — BiDi event layer.** Wire `SafariBidiClient` `log.entryAdded` → `console_read` + nav-lifecycle events. Strictly additive: if the experimental cap is unavailable, degrade to Classic-only (no console/nav events) without breaking.
- **Inc 5 / task #35 — gating, server branching, keystone, docs.** The sub-interface network/emulation refusals; finish the ~20 `sess.page()` consumer branching; doctor safari check; `engine-adapters.md` matrix row; `capabilities.test.ts` + `select-operator.test.ts` finalization; byob.ts comment fix. Full gate green.

---

## 7. Gotchas / decisions still open

1. **`page()`-no-Playwright contract** — recommend (a) structured throw + (c) `native?()` handle. Decide explicitly; it changes every `sess.page()` consumer.
2. **One-session-at-a-time** — adapter-level reject-2nd vs registry-level serialize (`registry.ts:289`). Decide before Inc 3.
3. **BiDi strictly additive** — the experimental cap can vanish in any Safari point release; the plain `{webSocketUrl:true}` path is a non-functional boolean placeholder. The adapter MUST run Classic-only if BiDi is absent (Classic alone is a complete workhorse).
4. **`set_viewport`** — the ONE emulation command that works (via BiDi `browsingContext.setViewport`). Either wire it as the lone emulation exception or gate emulation uniformly for a simpler story. Recommend gating uniformly first, add viewport later.
5. **No headless** — the keystone + any managed session open VISIBLE Safari windows. Skip-without-Safari covers Linux CI; a mac CI runner would pop real windows.
6. **Network contract** — P2b promised "action-window network slice real on every engine." That is now FALSE for safari (network fully gated). Document it and keep the gate honest (refuse, don't silently empty).
7. **`resolveBrowserType` (select.ts:51)** — assumes a Playwright `BrowserType`. Safari has none. Either special-case safari out of that path or have the adapter bypass it (the android adapter calls `resolveBrowserType('android') → chromium`; safari can't do the analogue).

---

## 8. Reproducibility — the probe/spike scripts

In [`safari-probe/`](safari-probe/) (copied from the live run, Node v22, built-in `WebSocket`, no deps):

- `bidi-probe.mjs` — negotiates the experimental-cap BiDi session and exercises every module (the §1 coverage table).
- `classic-probe.mjs` — exercises the full WebDriver Classic surface.
- `safari-substrate-spike.mjs` — runs browxai's real `PAGE_SCRIPT` via Classic `execute/sync` (the §4 feasibility proof). Reads `src/page/dom-walk.ts` so it always tests the current script.

Run: `safaridriver -p 4444 --bidi 9223 &` then `node docs/rfcs/references/safari-probe/<script>.mjs`. (On a fresh host you may first need `sudo safaridriver --enable` + Develop-menu "Allow Remote Automation".)

---

## 9. Key file:line index (verified against `main` @ `de8636f`)

| Concern | Location |
|---|---|
| EngineKind union / ENGINE_KINDS | `src/engine/types.ts:21,23` |
| EngineSession.page()/context() (the leak) | `src/engine/types.ts:79-88` |
| EngineCapabilities / sub-interfaces | `src/engine/types.ts:41-66` |
| Per-engine capability declarations | `src/engine/capabilities.ts` (add SAFARI_CAPABILITIES) |
| IMPLEMENTED_ENGINES / BROWSER_TYPES / resolveBrowserType | `src/engine/select.ts:26,13,51` |
| UnknownEngineError (Safari note) / validateEngine | `src/engine/select.ts:67-90` |
| Adapter template | `src/engine/adapters/android-cdp.ts` |
| Transport IO-seam template | `src/engine/adapters/adb.ts` |
| tool-gate (keys on caps.deep) | `src/engine/tool-gate.ts:131-146` |
| SnapshotSubstrate interface + Playwright impl | `src/page/snapshot-substrate.ts:46,102` |
| snapshot substrate selector | `src/page/snapshot-substrate-select.ts` |
| DOM-walk PAGE_SCRIPT + runDomWalkOnFrame | `src/page/dom-walk.ts:143,104` |
| BrowserSession.page() / SessionInternals | `src/session/types.ts:86,96` |
| Action core (Playwright-bound) | `src/page/actions.ts:37,69,123,125,213`; `src/page/actionresult.ts:432-493`; `src/page/locator.ts:31-59` |
| ConsoleBuffer.attach(page) | `src/page/console.ts:35-40` |
| refs bindFrame / elementKey (keys portable) | `src/page/refs.ts:80,142` |
| server.ts session-creation block (~20 page consumers) | `src/server.ts:838-1011` (CDP-specific: 893, 1011) |
| deep-tool engine gate | `src/server.ts:~1184` |
| registry (no concurrency cap) | `src/session/registry.ts:289` |
| byob.ts stale Safari comment | `src/session/byob.ts:174-178` |
| select-operator test (engine-list asserts) | `src/engine/select-operator.test.ts:16,30,38,84-91` |

---

**Provenance:** This plan was produced by an orchestrated workflow (capability-map + architecture-scout + RFC-draft + evidence-doc agents) with an adversarial verification pass that returned 3 `needs-change` verdicts (all incorporated: the capability-map overreach on untested web-storage/snapshot-walker was downgraded to "inferred not probed"; the RFC got 3 additional edits for internal consistency; the plan's missing action-seam was surfaced). The empirical claims are first-party local-machine probes, reproducible via §8.
