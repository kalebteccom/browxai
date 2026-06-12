# browxai protocol-coupling audit — multi-engine (Firefox/WebKit/BiDi) readiness

Read-only audit of `/Users/rowin/Projects/Kalebtec/browxai` @ `main` (`d248ef8`). No commits made.

**Scope read:** `src/server.ts` (12,889 lines, all 198 tool registrations), `src/session/*` (byob/managed/incognito/registry/types/emulation/permission/notification/dialog/fs-picker/extensions/device-emu/storage/cache-storage/idb-storage/profile-snapshot/wedge/metrics), `src/page/*` (all 60+ modules), `src/helper/*` (bridge/browx-page/stealth/overlay-hide), `src/plugin/*`, `src/sdk/*`, `src/util/capabilities.ts`, `src/cli/*`, `packages/plugins/*`, `test/keystone/*`, `vitest.keystone.config.ts`, `docs/ai-context/page-side-functions/*`.

**Tool inventory method:** 167 direct `register("name", …)` calls in `src/server.ts` plus loop-registered families (`mouse_*` ×3 at server.ts:3688, `touch_*` ×3 at :3783, `profile_snapshot|restore` ×2 at :6157, `emulate_{bluetooth,usb,hid}` ×3 at :10529-10539, `{local,session}storage_*` ×10 at :7777) = **198 registered MCP tools**. Cross-checked against `TOOL_CAPABILITY` in `src/util/capabilities.ts` (181 mapped entries; the 17 unmapped — `open_session`, `close_session(s)`, `list_sessions`, `batch`, `get/set/reset_config`, `approve_actions`, `list_approvals`, `plugins_list/info`, `workers_list`, `worker_message*`, `sw_*intercept_fetch` — default to `human`).

---

## 0. Executive architecture summary

browxai is **Playwright-on-Chromium with a permanently-open raw CDP side channel**. The coupling is structural, not incidental:

- `BrowserSession` — the lifecycle abstraction every tool sits on — exposes `cdp(): CDPSession` as a first-class member (`src/session/types.ts:72-78`). All three session factories mint a `CDPSession` eagerly at open: `src/session/managed.ts:68`, `src/session/incognito.ts:52`, `src/session/byob.ts:55`. There is no "Playwright-only" session shape.
- **Action dispatch is engine-agnostic; the observation envelope is not.** Every action tool resolves its target into a plain Playwright `Locator` (role/name/testId/cssPath — `src/page/locator.ts:31-67`, `src/page/refs.ts`) and dispatches via `locator.click()` / `page.mouse` etc. But every action runs inside `runInActionWindow` (`src/page/actionresult.ts:386+`), which builds the `ActionResult` envelope from raw CDP: pre/post a11y trees via `Accessibility.getFullAXTree`, navigation detection via `Page.enable` + `Page.frameNavigated` (`actionresult.ts:413-414`), and a `NetworkTap` on the `Network.*` domain (`src/page/network.ts:100,153-155`).
- The read core (`snapshot`/`find`/`extract`/`text_search`/`watch`) is built on the same CDP substrate, deliberately: *"playwright-core dropped page.accessibility so we go via CDP (Accessibility.getFullAXTree) directly"* (`src/page/a11y.ts:1-4`).
- A large second tier (storage CRUD, route mocking, WS-interactive, workers (web half), policies, uploads/drops, HAR/video, canvas) is **already engine-agnostic** — fixed page-side function literals through `page.evaluate`/`addInitScript`/`exposeBinding`, all Playwright-abstracted cross-browser primitives.
- A third tier (perf tracing, coverage, heap, CPU/network emulation, virtual clock, SW fetch interception, extensions, pdf) is **CDP-hard by nature of the underlying engine facility** (Chrome trace format, V8 heap format, Blink throttling) and should be capability-gated per engine rather than ported.

Bottom line: a multi-engine browxai is **not** a rewrite of 198 tools. It is (a) a `browserType` abstraction in 3 session files + the lazy-open path in `server.ts`, (b) a re-plumb of one snapshot substrate (~5 files) and one network-tap substrate (~2 files) onto Playwright-portable or BiDi mechanisms, (c) an honest per-engine capability matrix for the ~19 genuinely Chromium-bound tools, and (d) a BYOB story that is currently **impossible on Firefox via stock Playwright** (no public `connectOverBiDi`).

---

## 1. THE COUPLING MAP

Classes:
- **[A]** engine-agnostic via Playwright's cross-browser API surface — would work on `playwright-firefox`/`webkit` today (modulo the launch path and the envelope caveat below).
- **[B]** Chromium/CDP-hard — uses `CDPSession`/`connectOverCDP`/CDP-only Playwright APIs; exact API named.
- **[C]** adaptable — works via a different mechanism per engine (Playwright-portable replacement or BiDi module exists; real per-engine work).
- **[D]** conceptually impossible/moot on some engine (named, with why).

> **Envelope caveat (applies to every [A] action tool):** the dispatch is [A], but the `ActionResult` it returns is built by [C] machinery (CDP a11y tree + CDP NetworkTap + `Page.frameNavigated`). Porting the envelope once (Section 1.1) un-gates all of them simultaneously.

### 1.1 Cross-cutting substrates (the real coupling, before any tool)

| Substrate | Mechanism today | Evidence | Class | Per-engine path |
|---|---|---|---|---|
| Session handle | `BrowserSession.cdp(): CDPSession` mandatory member | `src/session/types.ts:76` | **B** (interface-level) | Make `cdp()` optional / engine-tagged; add capability probe |
| a11y tree | `Accessibility.enable` + `Accessibility.getFullAXTree` (+ `DOM.getAttributes` per node) | `src/page/a11y.ts:128-129,238` | **C** | Playwright `locator.ariaSnapshot()` (cross-browser, different shape — no `backendDOMNodeId`); or page-side ARIA walk via `page.evaluate` |
| DOM-walk | top frame via raw `Runtime.evaluate` | `src/page/dom-walk.ts:82` | **C** (trivial) | The frame-scoped variant of the *same script* already runs through `frame.evaluate` (`dom-walk.ts:94-101`) — move main frame onto it |
| bbox | `DOM.resolveNode(backendNodeId)` + `Runtime.callFunctionOn` | `src/page/bbox.ts:82-90` | **C** (mostly done) | Playwright `locator.boundingBox()` fallback **already exists** (`bbox.ts:98-115`); promote to primary off-Chromium |
| Closed-shadow harvest | `DOM.getDocument({pierce:true})` | `src/page/shadow.ts:109`, `src/page/compose.ts:104` | **D** on Firefox/WebKit — no automation-protocol access to closed shadow roots outside CDP; BiDi has no pierce equivalent | Degrade to `"open"` (code already degrades when CDP refuses — `compose.ts:76-80`) |
| Action window / envelope | `Page.enable` + `Page.frameNavigated` listener; CDP `NetworkTap`; pre/post CDP a11y trees | `src/page/actionresult.ts:413-416` | **C** | `page.on('framenavigated')` (Playwright, cross-browser); `context.on('request'/'response')` or BiDi `network.*` events; a11y per above |
| Network buffers | `NetworkBuffer` + `NetworkTap` on `Network.requestWillBeSent/responseReceived/loadingFailed`; `WsBuffer` on `Network.webSocket*` | `src/page/network.ts:100-155, 277-306, 480-549` | **C** | Playwright `request`/`response`/`requestfailed` events (cross-browser); `page.on('websocket')` `framesent`/`framereceived` (cross-browser); or BiDi `network` module |
| Refs → locators | role/name/testId/cssPath → Playwright `Locator`; refs keyed by content hash, not protocol ids | `src/page/refs.ts:25-35`, `src/page/locator.ts` | **A** | Nothing to do — the ref system itself is protocol-neutral; only `backendDOMNodeId` (bbox/closed-shadow) is CDP-flavored |
| Page-side functions | fixed function literals via `page.evaluate`/`addInitScript`/`exposeBinding` | `docs/ai-context/page-side-functions/pattern.md` | **A** | Playwright abstracts all three cross-browser (see Section 3) |
| Per-page emulation re-apply | `context.on("page")` → `newCDPSession(newPage)` → re-apply locale/tz/UA | `src/server.ts:983, 11682` | **C** | only needed because locale/tz/UA ride CDP; see 1.8 |

### 1.2 Read / observation core (24 tools)

| Tool(s) | Class | Mechanism + evidence | Multi-engine note |
|---|---|---|---|
| `snapshot` | **C** | CDP a11y (`a11y.ts:128`) + CDP DOM-walk (`dom-walk.ts:82`) + CDP bbox; composed in `src/page/compose.ts:87-104` | `includeShadow:"closed"` sub-feature is **D** off-Chromium (server.ts:1464 description documents the CDP `pierce:true` path) |
| `find` | **C** | same substrate (`src/page/find.ts`, `verify.ts:368 composeSnapshot`) + Playwright locator probes | ranking/evidence logic is server-side, ports for free once substrate ports |
| `text_search`, `watch`, `extract` | **C** | a11y-tree consumers (`text_search.ts`, `watch.ts`, `extract.ts` all take `CDPSession`) | extract's field resolution lowers to locators ([A] half) |
| `frames_list` | **A** | Playwright frame tree, stable `fN` ids (`src/page/frames.ts`) | OOPIF transparency is Playwright-provided cross-browser |
| `shadow_trees` | **C/D** | open walk = `Runtime.evaluate` (`shadow.ts:330`, trivially `page.evaluate`); closed walk = `DOM.getDocument({pierce:true})` (`shadow.ts:109`) | closed half **D** on Firefox/WebKit |
| `verify_visible/text/value/count/attribute/predicate` | **A** | Playwright locator assertions (`src/page/verify.ts`); snapshot substrate only for ref context | |
| `screenshot`, `screenshot_region` | **A** | `page.screenshot()` / `locator.screenshot()` (`src/page/screenshot-save.ts`) | |
| `screenshot_marks` | **C** | composeSnapshot + CDP `visibleRect` for mark geometry (`set-of-marks.ts:123,173`) — Playwright bbox fallback already wired (`:166`) | |
| `screenshot_schedule` | **A** | timer + `page.screenshot` (`screenshot-schedule.ts`) | |
| `screenshot_on` | **C** | nav/dialog triggers are Playwright; `trigger:"network-mutation"` uses raw CDP `Network.enable` + `requestWillBeSent/responseReceived` (`server.ts:2844-2846`) | replace with `context.on('response')` |
| `console_read` | **A** | Playwright `page.on('console'/'pageerror')` ring (`src/page/console.ts`) | |
| `network_read` | **C** | `NetworkBuffer` on CDP `Network.*` (`network.ts:480+`) | Playwright request/response events lose some fields (CDP `resourceType` nuance, exact timings) — degrade documented |
| `ws_read` | **C** | `WsBuffer` on CDP `Network.webSocketCreated/FrameSent/FrameReceived` (`network.ts:277-306`) | Playwright `page.on('websocket')` is cross-browser; SSE frames sniffing may degrade |
| `network_body` | **C** | CDP `Network.getResponseBody` (`network.ts:360,397`) | Playwright `response.body()` is cross-browser but must be captured at response time (no after-the-fact fetch); BiDi `network.getData` still maturing in Firefox |
| `inspect`, `overflow_detect`, `point_probe` | **A** | fixed page-side scripts via `page.evaluate` (`inspect.ts`, `overflow-detect.ts`, `point_probe.ts`) | |
| `sample`, `cross_session_sample` | **A** | fixed in-page rAF/interval loop, enum metrics, no agent JS (`sample.ts`) | |
| `generate_locator` | **A** | server-side ref→locator-string lowering | |

### 1.3 Action / navigation core (22 tools)

| Tool(s) | Class | Mechanism + evidence |
|---|---|---|
| `navigate`, `go_back`, `go_forward` | **A** | `page.goto/goBack/goForward` (server.ts:3359, 9327, 9348) |
| `click`, `fill`, `press`, `hover`, `select`, `choose_option`, `fill_form`, `wait_for`, `scroll` | **A** | Playwright locators + keyboard (`src/page/actions.ts`, `fill-form.ts`) |
| `shortcut` | **A** | `page.keyboard` chords; clipboard interplay via `src/page/clipboard.ts` (session-local buffer, OS clipboard touched transactionally) |
| `drag`, `double_click` | **A** | `page.mouse.move/down/up/dblclick` (`gestures.ts:65-83`) |
| `mouse_down/move/up` | **A** | `page.mouse` (`gestures.ts:120-134`) |
| `mouse_wheel` | **C** | CDP `Input.dispatchMouseEvent {type:"mouseWheel"}` at arbitrary coords (`gestures.ts:103`) — port: `page.mouse.move(x,y)` + `page.mouse.wheel(dx,dy)` (cross-browser, semantics ~identical) |
| `upload_file` | **A** | `locator.setInputFiles()` (`upload.ts`) |
| `drop_files` | **A** | one-shot `page.evaluate` builds `File`+`DataTransfer`, dispatches dragenter/dragover/drop (`drop-files.ts:16-30`) |
| `eval_js`, `poll_eval` | **A** | `page.evaluate` (capability `eval`) |

All of the above carry the **envelope caveat** (Section 1.1): `ActionResult.network` / `snapshotDelta` / nav detection are CDP-fed today.

### 1.4 Touch & gesture family (6 tools)

| Tool(s) | Class | Mechanism + evidence | Per-engine path |
|---|---|---|---|
| `touch_start/move/end` | **C** | CDP `Input.dispatchTouchEvent` with `touchPoints[].id` for multi-finger (`gestures.ts:163-200`) | Playwright cross-browser surface has only `touchscreen.tap`. Firefox: WebDriver BiDi `input.performActions` with pointerType `touch` supports multi-pointer — needs a raw-BiDi escape hatch or upstream Playwright support. WebKit: no public touch-sequence injection via Playwright → near-**D** on Safari today |
| `gesture_pinch`, `gesture_swipe` | **C** | composed from `Input.dispatchTouchEvent` sequences (`gestures.ts:204-300`) | same as above |
| `gesture_chain` | **A** | validated step program executed against `page.mouse` (`canvas.ts:707-754`) — pointer-only by design |

### 1.5 Route mocking & network-shaping (6 tools)

| Tool(s) | Class | Mechanism + evidence | Note |
|---|---|---|---|
| `route`, `route_queue`, `unroute` | **A** | Playwright `page.route`/`context.route` (`src/page/routes.ts`) | |
| `act_and_wait_for_network` | **A** | `page.waitForResponse` (server.ts:5395) + pure matcher (`await_network.ts`) | |
| `network_emulate` | **B→C** | CDP `Network.emulateNetworkConditions` (`emulation.ts:205`; tool description names it, server.ts:4480) | No Playwright/BiDi cross-browser throttle. Approximation: route-level `delayMs` (already composes — `emulation.ts:12-13`). True link emulation off-Chromium: **D** until BiDi network throttling lands |
| `cpu_emulate` | **B** | CDP `Emulation.setCPUThrottlingRate` (`emulation.ts:215`; server.ts:4557) | No Firefox/WebKit equivalent exposed by any protocol → effectively **D** off-Chromium |

### 1.6 WebSocket-interactive & workers (8 tools)

| Tool(s) | Class | Mechanism + evidence | Note |
|---|---|---|---|
| `ws_send`, `ws_intercept`, `ws_unintercept` | **A** | page-side `window.WebSocket` wrapper installed eagerly via `context.addInitScript` (`ws-interactive.ts:19-30,113`); server drives via `evaluate` | deliberately page-side because "CDP has no native send-a-frame primitive" — that design choice is what makes it portable |
| `workers_list` (Web-Worker half), `worker_message_send` (WW), `worker_messages_read` (WW) | **A** | page-side `window.Worker` constructor proxy via `addInitScript` (`workers.ts:14-25,253`) | |
| `workers_list` (SW half) | **B** | `ServiceWorker.enable` + `Target.setAutoAttach` (`workers.ts:268-271,323`) | Playwright `context.serviceWorkers()` is Chromium-only/experimental; Firefox BiDi has no SW target attach → SW listing **D** off-Chromium today |
| `worker_message_send` (SW half) | **B** | `Runtime.evaluate` on the SW's attached CDP session (`workers.ts:476`; server.ts:4321) | |
| `sw_intercept_fetch`, `sw_unintercept_fetch` | **B** | `Fetch.enable`/`Fetch.fulfillRequest`/`Fetch.continueRequest` on the SW target session (`workers.ts:359-395,541-568`) | no analogue on other engines → **D** off-Chromium |

### 1.7 Perf / memory / coverage / determinism (15 tools)

| Tool(s) | Class | Exact CDP API | Off-Chromium verdict |
|---|---|---|---|
| `perf_start`, `perf_stop` | **B** | `Tracing.start`/`Tracing.end` + `Tracing.dataCollected` (`perf.ts:140-194`) | Chrome trace-event format is engine-specific. Firefox has the Gecko profiler (different protocol, different format) — a Firefox lane is a **separate implementation**, not an adaptation → treat as **D** for v1 multi-engine |
| `perf_insights` | **B-dependent** | pure parse of the Chromium trace JSON (`perf.ts`) | meaningless without B-produced input |
| `perf_audit` | **B** | `Network.enable` + `Tracing.start/end` (`perf-audit-runner.ts:165-180`) | same |
| `layout_thrash_trace` | **B** | `Tracing.start/end` w/ stack traces (`layout-thrash.ts:93-108`) | same |
| `coverage_start`, `coverage_stop` | **B** | `Profiler.startPreciseCoverage`/`takePreciseCoverage`, `CSS.startRuleUsageTracking`/`stopRuleUsageTracking` (`coverage.ts:124-182`) | V8/Blink-specific; Playwright's own Coverage API is Chromium-only → **D** off-Chromium |
| `heap_snapshot`, `heap_retainers` | **B** | `HeapProfiler.takeHeapSnapshot` + `addHeapSnapshotChunk` (`heap.ts:45-50`) | `.heapsnapshot` is a V8 format; SpiderMonkey/JSC expose nothing comparable over automation protocols → **D** off-Chromium |
| `memory_diff` | **B-dependent** | pure diff of two V8 `.heapsnapshot` files (`memory-diff.ts`) | |
| `clock` | **C** | CDP `Emulation.setVirtualTimePolicy` freeze/advance/release (`clock.ts:189-203`; server.ts:5193) | Playwright `page.clock` (JS shim) is cross-browser but semantically different — no `pauseIfNetworkFetchesPending` coupling; an honest port changes documented behavior |
| `seed_random` | **A** | `context.addInitScript` Mulberry32 (`seed-random.ts:129`) | |
| `flake_check` | **A** | orchestration over action tools (server.ts:12509) | |

### 1.8 Session-level emulation & permissions (13 tools)

| Tool(s) | Class | Mechanism + evidence | Per-engine path |
|---|---|---|---|
| `set_viewport` | **A** | `page.setViewportSize` (server.ts:10601) | |
| `set_locale`, `set_timezone`, `set_user_agent` | **C** | live mutation via CDP `Emulation.setLocaleOverride` / `Emulation.setTimezoneOverride` / `Network.setUserAgentOverride` (`src/session/emulation.ts:98-154`) — module header documents why: Playwright bakes these at context creation | Per-engine: (a) recreate-context-with-options semantics (state loss — needs rebuild machinery like extensions'), or (b) WebDriver-BiDi `emulation.setTimezoneOverride` / `emulation.setLocaleOverride` (Firefox implements; UA override not in BiDi) — partial |
| `set_geolocation` | **A** | `context.setGeolocation()` (`emulation.ts:123-131`; server.ts:10759 notes "no CDP fallback needed") | |
| `set_color_scheme`, `set_reduced_motion` | **A** | `page.emulateMedia` (`emulation.ts:137-143`) | |
| `grant_permissions` | **C** | Playwright `context.grantPermissions` with Chromium permission names (server.ts:10898-10901) | Firefox/WebKit accept only a small subset of names; needs per-engine allowlist + structured refusal |
| `set_permission_policy`, `permission_state` | **C** | two layers: `context.grantPermissions` baseline (`permission.ts:556-594` — deliberately not raw CDP) + init-script wrappers ([A]) | wrapper layer ports as-is; baseline layer inherits grant_permissions' per-engine subset |
| `set_notification_policy` | **A** | init-script wrapper around `new Notification` (`notification.ts`) | |
| `tab_visibility` | **A** | fixed visibility-override scripts + scratch-tab foregrounding (`visibility.ts:14-40`) | already documented best-effort per headless quirks |
| `set_dialog_policy` | **A** | `page.on('dialog')` (`dialog.ts`) | |

### 1.9 Storage family (37 tools) — **all [A]**

`dump_storage_state` / `inject_storage_state` → `context.storageState()` / `setStorageState` (`storage.ts:8-19`); `cookies_{get,list,set,delete,clear}` → `context.cookies/addCookies/clearCookies`; `localstorage_*`/`sessionstorage_*` ×10 → origin-scoped `page.evaluate` (`storage.ts`); `caches_*` ×7 → `page.evaluate` against `window.caches` (`cache-storage.ts:1-8`); `idb_*` ×6 → `page.evaluate` against IndexedDB (`idb-storage.ts:1-6`); `auth_{save,load,list,delete}` → workspace JSON over layer 1; `artifact_{save,get,list}` → server-side fs. Nothing protocol-specific anywhere in this family — the deliberate "page.evaluate because it's origin-scoped" design is engine-portable by construction.

### 1.10 HAR / video / recording / export (10 tools) — **all [A]**

`start_har`/`stop_har` → `context.routeFromHAR({update:true})` + `unrouteAll` (`har.ts:7-30`); `stop_video`/`get_video` → Playwright `recordVideo` context option + `page.video().saveAs` (`video.ts:1-30`); `start_recording`/`end_recording`/`record_annotate` → server-side trace of action calls (`recording.ts`); `export_playwright_script` → server-side lowering to `@playwright/test` (`export-playwright-script.ts` — exported specs are themselves engine-parametric for free); `export_session_report`, `session_metrics` → server-side.

### 1.11 Files / export / archive (10 tools)

| Tool(s) | Class | Mechanism + evidence |
|---|---|---|
| `pdf_save` | **B / D off-Chromium** | `page.pdf()` — module header states it: "**Chromium constraint:** `page.pdf()` is Chromium-only and refuses on attached" (`pdf.ts:19-23`; server.ts:6650). Playwright throws on Firefox/WebKit. No BiDi equivalent. **D** on Firefox/WebKit |
| `page_archive` | **A** | DOM walk + fetch via `page.evaluate` (`archive.ts:22-27`) |
| `dom_export`, `element_export` | **A** | fixed page-side function literals (the canonical page-side-function pattern; `dom-export.ts`, keystone-gated per `docs/ai-context/page-side-functions/dom-export-trap.md`) |
| `asset_export` | **C** | CDP `Network.getResponseBody` for captured responses (`asset-export.ts:274`) — port via Playwright `response.body()` capture-at-time or in-page re-fetch |
| `downloads_capture`, `download_get` | **A** | `context.on("download")` + `acceptDownloads:true` (`downloads.ts`; `managed.ts:51`) |
| `screenshot` file modes, `dump_storage_state` etc. | **A** | workspace-rooted fs writes, protocol-free |

### 1.12 Canvas family (6 tools) — **all [A]**

`canvas_capture` → in-page `toDataURL`/`getImageData`/`gl.readPixels` (`canvas.ts:180-247`); `canvas_diff` → pure RGBA math; `canvas_world_to_screen`/`canvas_screen_to_world` → pure math + heuristic page probes; `canvas_query` → plugin dispatch; `gesture_chain` → `page.mouse` program (`canvas.ts:707-754`).

### 1.13 Extensions family (5 tools) — **[B], D off-Chromium via Playwright**

`extensions_install/list/reload/trigger/uninstall`: Chromium **launch-flag** mechanism — `--load-extension` + `--disable-extensions-except` emitted at `chromium.launchPersistentContext` (`managed.ts:32-40`; `extensions.ts:1-20`: "Chrome extensions … are a LAUNCH-TIME concern … no Playwright API to add/remove on a live context"). Install/reload/uninstall **rebuild the whole browser context** (server.ts:11759), re-wiring every per-session attachment including a fresh `newCDPSession` (server.ts:11682). `extensions_trigger` navigates to `chrome-extension://<id>/<popup>` and reads runtime ids from `context.serviceWorkers()` (server.ts:11886-11890) — all Chromium-shaped. Firefox extension loading exists (web-ext / remote-debugging) but **not through Playwright's API**; WebKit has no extension loading at all → **D** on WebKit, heavy-**C** (separate non-Playwright mechanism) on Firefox.

### 1.14 Device emulation (Web Bluetooth/USB/HID) (4 tools) — **[A] mechanically, [D]-moot by platform**

`emulate_bluetooth`/`emulate_usb`/`emulate_hid`/`device_requests`: pure init-script wrappers around `navigator.{bluetooth,usb,hid}.requestDevice` + an exposeBinding check channel (`device-emu.ts:1-20`; server.ts:10395-10420). The mechanism ports anywhere — but **the platform APIs don't exist on Firefox or Safari** (WebBluetooth/WebUSB/WebHID are Chromium-only web platform features). Off-Chromium these tools are *moot, not broken*: a structured "API absent on this engine" is the correct behavior.

### 1.15 Posture / trust tools (8 tools)

| Tool(s) | Class | Note |
|---|---|---|
| `solve_captcha` | **A** | HTTP delegation to 2Captcha-shaped provider; agent supplies sitekey; token injection via fixed evaluate (`solve-captcha.ts`) — no protocol coupling |
| `register_secret`, `get_totp`, `get_credential` | **A** | server-side registries (`util/secrets.ts`, `util/credentials.ts`) |
| stealth (behavior, no tool) | **C** | `addInitScript` patches (`helper/stealth.ts`) — mechanism [A], but patch *content* is Chromium-fingerprint-specific (`window.chrome`, plugins). Firefox/WebKit need a different (smaller) patch set; `navigator.webdriver` patch applies everywhere |
| `await_human` | **A** | `__browx` bridge: `context.exposeBinding("__browx_send")` + `addInitScript` + DOM-attribute-polling fallback (`helper/bridge.ts:53-71`) |
| `fs_picker_respond`, `set_fs_picker_policy` | **A**-moot | exposeBinding + init-script stubs (`fs-picker.ts:545,605`) — File System Access API is Chromium-only platform API, so off-Chromium: moot |
| `approve_actions`, `list_approvals` | **A** | server-side |

### 1.16 Session lifecycle & coordination (17 tools)

| Tool(s) | Class | Note |
|---|---|---|
| `open_session`, `close_session`, `close_sessions`, `list_sessions` | **C** | semantics are protocol-neutral; implementations hardcode `chromium` (Section 2). `mode:"attached"` is **D-on-Firefox today** (Section 2.3) |
| `profile_snapshot`, `profile_restore` | **C** | pure fs copy (`profile-snapshot.ts`) — but profile *contents* are per-engine; needs engine-namespaced profile dirs |
| `batch`, `plan`, `execute`, `act_and_sample` | **A** | orchestration over other tools (inherit inner tool's class) |
| `act_and_diff` | **C** | diffs pre/post snapshots → rides the a11y substrate |
| `get/set/reset_config`, `diagnostics_note/search/report`, `plugins_list/info`, `name_ref`, `list_named_refs`, `name_region`, `region`, `find_feedback` | **A** | server-side state only |

---

## 2. LAUNCH / ATTACH PATHS

### 2.1 Where `chromium` is hardcoded

| Site | What | Evidence |
|---|---|---|
| `src/session/managed.ts:5,42` | `import { chromium } from "playwright-core"` → `chromium.launchPersistentContext(profileDir, {...})` | Chromium-only **args** baked in: `--disable-web-security --disable-site-isolation-trials` (`:20`), `--disable-extensions-except`/`--load-extension` (`:35`) |
| `src/session/incognito.ts:10,25` | `chromium.launch({headless, args})` + `browser.newContext({...})` | same insecure-args coupling |
| `src/session/byob.ts:7,52` | `chromium.connectOverCDP(url)` | the whole BYOB mode |
| `src/cli/chrome.ts:47-53` | `chromium.executablePath()` + spawn with `--remote-debugging-port=9222 --user-data-dir=…` | BYOB host launcher |
| `src/server.ts:715-752` | lazy `entryFor` → mode dispatch into the three factories; `serverDefaultMode = opts.attachCdp ? "attached" : "persistent"` (`:631-634`) | the single chokepoint a `browserType` option would flow through |

**What a `browserType` abstraction touches:** the three factory files, the `StartOptions`/`SessionOptions` shape (`server.ts:313`, `session/types.ts:21-70`), the `entryFor` lazy-open path, `cli/doctor.ts` (install checks), and the per-engine translation of: launch args (web-security-off is `firefoxUserPrefs`/not-available-on-WebKit), `launchPersistentContext` (supported on Firefox; **not** on WebKit — persistent mode is **D** on WebKit, incognito-only), `acceptDownloads` (portable), `recordHar`/`recordVideo` (portable), device presets (`session/device.ts` uses `playwright-core` `devices` — portable, but mobile presets emulating Safari-on-Chromium vs real WebKit differ behaviorally).

### 2.2 The eager-CDP assumption

All three factories end with `context.newCDPSession(page)` and return `cdp: () => cdp` (`managed.ts:68`, `incognito.ts:52`, `byob.ts:55`); `BrowserSession.cdp()` is non-optional (`types.ts:76`). On `playwright-firefox`/`webkit`, `newCDPSession` throws — **today the server cannot even open a session on another engine.** First multi-engine commit is making `cdp()` optional/lazy and gating every consumer. Also CDP-flavored: per-new-page `newCDPSession` for emulation re-apply (`server.ts:983,11682`), and teardown ordering ("stop in-flight perf trace BEFORE closing CDP", `server.ts:~1058`).

### 2.3 BYOB attach semantics and the Firefox analogue

- **Loopback-only allowlist** `127.0.0.1 / localhost / ::1` with the stated reason "CDP port is unauthenticated" (`byob.ts:11-27`). A Firefox analogue (`--remote-debugging-port` speaks BiDi/CDP-ish on Firefox; the BiDi WebSocket is equally unauthenticated) keeps the same posture — the check is protocol-neutral and reusable.
- **Not-owned semantics**: detach without closing, never reset storage (`byob.ts:101-113`); `recordVideo`/`recordHar`/`storageState` refused/ignored on attached (`server.ts:697,742`; `types.ts:38-57`). All protocol-neutral policy — ports as-is.
- **Viewport-zero workaround** uses raw `Page.getLayoutMetrics` + `Runtime.evaluate` + `Emulation.setDeviceMetricsOverride` (`byob.ts:69-93`) — would need a BiDi/evaluate-based equivalent.
- **The hard fact:** Playwright has **no public `connectOverBiDi`** — `firefox.connect()` requires a Playwright-launched server on the far end, not a user's running Firefox. BYOB-Firefox therefore means either (a) waiting for upstream Playwright BiDi attach support, or (b) embedding a raw WebDriver-BiDi client and re-implementing the Page/Locator surface over it — i.e., not an adaptation of `byob.ts` but a second product. Mark `mode:"attached"` as **Chromium-only for the foreseeable architecture**, with `BROWX_ATTACH_BIDI` reserved as a name.
- BYOB multi-attach already has a documented Playwright bug workaround (exposeBinding clobbering, Playwright #34359 → DOM-attribute polling fallback, `bridge.ts:10-12,67`) — evidence that attach-mode is where protocol assumptions leak hardest.

### 2.4 Context-lifecycle assumptions that are CDP/Chromium-flavored

- Extensions rebuild-the-context flow re-wires ~15 per-session attachments and mints fresh CDP sessions (`server.ts:11630-11700`) — any engine port must re-run this re-wire list, which is the de-facto inventory of all init-script/binding state.
- `clock`/`network_emulate`/`cpu_emulate` re-apply on `framenavigated` because "CDP may drop overrides on a renderer swap" (`emulation.ts:7-11`, `clock.ts:16-18`) — re-apply machinery is reusable; the appliers are the per-engine part.
- Persistent-profile semantics (`setStorageState` clears profile, `managed.ts:69-82`) are Playwright-level, portable to Firefox; WebKit has no persistent context at all.

---

## 3. PAGE-SIDE INFRASTRUCTURE

Reference: `docs/ai-context/page-side-functions/pattern.md` — the house rule: **server-owned fixed TypeScript function literals only**, passed to `page.evaluate`/`locator.evaluate`; agent JS only via gated `eval_js`. The doc's reasoning is CDP-phrased ("CDP can't serialize functions") but the discipline itself is protocol-neutral and **keystone-gated** (every evaluate-calling tool must have a real-Chromium keystone; ESLint rule `no-stringified-arrow-in-evaluate` as backstop).

Three mechanisms, by portability:

1. **Init scripts** (`context.addInitScript`) — Playwright-abstracted, cross-browser. Users: ws-interactive wrapper (`ws-interactive.ts:113`), workers wrapper (`workers.ts:253`), seed-random (`seed-random.ts:129`), stealth (`stealth.ts:88`), overlay-hide (`overlay-hide.ts:51`), `__browx` page script (`browx-page.ts`), permission/notification/fs-picker/device-emu wrappers. All install **eagerly at session creation** because "addInitScript only fires on the NEXT nav" (`server.ts:1009-1021`) — that timing assumption holds on all engines. **[A]**
2. **Exposed bindings** (`context.exposeBinding`) — Playwright-abstracted, cross-browser. Users: `__browx_send` bridge (`bridge.ts:53`), `__browx_fs_picker_check`/`__browx_fs_picker_write` (`fs-picker.ts:545,605`), device-emu check binding. The bridge already ships a **DOM-attribute-polling fallback** for when bindings fail (`bridge.ts:10,67`) — useful resilience on less-tested engine paths. **[A]**
3. **Raw-CDP page-side bypasses** — the only places browxai goes around Playwright to reach the page: `Runtime.evaluate` in dom-walk (`dom-walk.ts:82`), shadow open-walk (`shadow.ts:330`), BYOB viewport probe (`byob.ts:74`); `Runtime.callFunctionOn`+`DOM.resolveNode` in bbox (`bbox.ts:82-90`); `DOM.getDocument({pierce:true})` closed-shadow (`shadow.ts:109`). The first group is mechanically `page.evaluate`-replaceable (the frame-scoped dom-walk variant already is, `dom-walk.ts:94-101`); bbox already has the Playwright fallback; closed-shadow is the one true **[D]**. **No isolated-world usage found** — browxai runs its fixed scripts in the main world by design (the wrappers must patch page-visible globals).

**Plugin runtime & SDK are protocol-clean:** `PluginApi` exposes only `registerTool`/`callTool`/`log` (`plugin/types.ts:27-77`) — no page, no CDP handle; shipped plugins (figma/tldraw/excalidraw) compose `eval_js` and core tools (`packages/plugins/tldraw/src/index.ts:5`). The SDK (`src/sdk/*`) is transport-only (in-process / socket / stdio-child). Plugins and SDK inherit multi-engine support for free.

---

## 4. TEST / KEYSTONE COVERAGE ASSUMPTIONS

- **Keystone lane = the only real-browser gate**, and it is Chromium-only by construction: `vitest.keystone.config.ts` (single-fork, 120s timeouts) over `test/keystone/**` — 19 files (`headless`, `touch`, `workers`, `ws-interactive`, `canvas`, `device-emu`, `fs-picker`, `dom-export`, `element-export`, `page-archive`, `perf-audit`, `cache-idb`, `idb-put-fidelity`, `overflow-detect`, `drop-files`, `diagnostics`, `plugin-runtime`, `sdk`, + `fixture.ts`).
- The fixture (`test/keystone/fixture.ts`) is a zero-dependency Node `http` server with a self-contained page — **fully engine-neutral**; nothing to change there.
- Tests start the server via `createServer({headless, workspace})` after stripping all `BROWX_*` env (`headless.keystone.test.ts:58-71`) — the engine choice is implicit in the factories; there is no `browserType` knob to parametrize on today.
- The page-side-function discipline explicitly designates keystone as the regression gate for evaluate-serialization bugs (`pattern.md` §"Keystone is the regression gate") — a Firefox lane is therefore *mandatory* for any [A]/[C] tool promoted to Firefox support, since mocked unit tests pass regardless of engine.
- **What a `firefox` keystone lane needs:** (1) a `browserType` option through `createServer`→factories; (2) a per-engine expectation matrix — of the 19 files: `touch` (CDP touch), `device-emu` (platform API absent), `perf-audit` (Tracing), parts of `workers` (SW half) must skip/assert-structured-refusal on Firefox; `headless`, `ws-interactive`, `canvas`, `dom-export`, `element-export`, `page-archive`, `cache-idb`, `idb-put-fidelity`, `overflow-detect`, `drop-files`, `fs-picker` (stub side), `diagnostics`, `plugin-runtime`, `sdk` should pass once the snapshot/network substrates are ported; (3) CI matrix axis + a `browxai doctor` engine-install check.

---

## 5. SIZING THE TIERS

### 5.1 Tool counts (198 total)

| Class | Count | Share | Composition |
|---|---|---|---|
| **A** — engine-agnostic today | **139** | ~70% | all storage (37), actions/nav (18), server-side/coordination (33), files/export minus pdf/asset (7), HAR/video (4), verify (6), canvas (6), WS-interactive (3), routes (4), screenshots (3), read-misc (10), emulation-A (4), policies (4), seed_random, tab_visibility, solve_captcha, credentials (2), … |
| **C** — adaptable, per-engine work | **36** | ~18% | snapshot/find/extract/text_search/watch/act_and_diff/screenshot_marks/screenshot_on (8), network_read/ws_read/network_body/asset_export (4), touch×3+pinch+swipe (5), workers WW/SW split (3), locale/tz/UA (3), permissions (3), session lifecycle (4), profile×2, mouse_wheel, clock, network_emulate, shadow_trees |
| **B** — Chromium/CDP-hard | **19** | ~10% | perf×4 + layout_thrash (5), coverage (2), heap×2 + memory_diff (3), cpu_emulate, sw_intercept×2, extensions (5), pdf_save |
| **D** — impossible/moot on some engine | **4** (+3 feature-level) | ~2% | emulate_bluetooth/usb/hid + device_requests (platform API absent on Firefox/WebKit); feature-level: closed-shadow piercing, BYOB-attach-on-Firefox, persistent-mode-on-WebKit |

Honest caveats on the headline "70% A": (i) every [A] tool is currently **unreachable** off-Chromium because session open itself throws (`newCDPSession`); (ii) every [A] *action* tool's envelope is [C]; (iii) most [B] tools are correctly understood as "Chromium-only forever, gate them" rather than "port them" — they don't block a multi-engine ship, they shape its capability matrix.

### 5.2 The 20% of code causing 80% of the multi-engine work

1. **`src/session/{managed,incognito,byob,types}.ts` + the `entryFor`/rebuild paths in `server.ts`** (~700 lines) — `browserType` injection, optional `cdp()`, per-engine launch-arg translation, engine-namespaced profiles. Blocks *everything*.
2. **The snapshot substrate: `src/page/{a11y,dom-walk,bbox,compose,shadow}.ts`** (~1,800 lines) — feeds `snapshot`, `find`, `extract`, `text_search`, `watch`, `set-of-marks`, ref minting, and every `ActionResult.snapshotDelta`. One ported substrate un-gates ~30 tools at once. Decision needed: `ariaSnapshot()` (loses `backendDOMNodeId`-keyed bbox; refs survive — they're content-hashed) vs. a page-side ARIA walker.
3. **The network substrate: `src/page/network.ts` + `actionresult.ts` window wiring** (~900 lines) — `NetworkTap`/`NetworkBuffer`/`WsBuffer` → Playwright request/response/websocket events (or BiDi network module). Un-gates `network_read`, `ws_read`, `screenshot_on`, and the `ActionResult.network` slice on every action.
4. **`src/session/emulation.ts` locale/tz/UA appliers** (~60 lines of CDP, large blast radius) — pick recreate-context vs. BiDi-emulation per engine.
5. **`src/page/gestures.ts` touch half** — BiDi `input.performActions` adapter for Firefox; structured refusal on WebKit.
6. **Capability/doctor/keystone matrix** — per-engine tool gating (the existing capability-gate machinery in `util/capabilities.ts` + `gateCheck` is the right place to hang an engine dimension), `doctor` engine checks, Firefox keystone lane.

Everything else — the 19 [B] tools — is correctly handled by the existing structured-refusal pattern browxai already uses for `pdf_save`-on-BYOB and `extensions`-on-incognito: refuse with a hint naming the engine, don't port.
