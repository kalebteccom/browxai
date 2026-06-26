# The `BrowserEngine` engine-adapter seam

The seam beneath the session layer that lets browxai drive engines other than
Chromium without rewriting the ~139 tools that already speak only Playwright's
cross-browser surface. This is dependency inversion at the engine boundary: the
session layer (and the tools above it) depend on the port; the port depends on
an adapter; the adapter depends on Playwright. Dependencies point inward — never
back out toward Playwright/CDP from a tool.

The seam realizes the engine lanes of
[`docs/rfcs/0002-multi-engine-bidi.md`](../../rfcs/0002-multi-engine-bidi.md)
(decision D1: strangler-fig, minimal-first, shaped for growth; D2/D3/D6 for the
Firefox lane; D4/D5 for the substrates; D7 for WebKit; D3/D8 for Android) against
the file:line evidence in
[`references/03-browxai-coupling-audit.md`](../../rfcs/references/03-browxai-coupling-audit.md).
The `BrowserEngine` port is the inward-pointing contract; each engine
(chromium, firefox, webkit, android, safari) is an adapter behind it. Read both
the RFC and the audit for the rulings and the coupling map; this doc is the
standing contract for the code that lives behind the port.

## Why the seam is proven (not speculative)

The [architecture doctrine](architecture-principles.md) forbids ports without a
second real implementation or a committed near-term need. This one qualifies:
multiple real engines run behind the port today, and Firefox 141 removed CDP
entirely — the only forward path is BiDi/Marionette, so a Chromium-only product
is a dead end for the owner's directive. The coupling audit names every seam a
second engine touches. The port is the cheap, safe boundary that lets each new
engine land as an adapter rather than a rewrite.

## The port (`src/engine/`)

```
EngineKind = "chromium" | "firefox" | "webkit" | "android" | "safari"   // engines the RFC commits to
//   safari: REAL Safari.app over safaridriver — the FIRST non-Playwright engine
//   (no Playwright Page, no CDP). page() THROWS; a curated subset works via the
//   Safari-native handle. See the "Safari" section below.

BrowserEngine (port)                              // capability-segregated
├── Lifecycle    launch / attach / contexts / close
├── Navigation   goto / waitForLoad / frames
├── Snapshot     a11y + DOM-walk substrate (ref minting)        ← hybrid per engine
├── Input        click / fill / press / gestures
├── Network      request/response/ws tap + ActionResult envelope ← hybrid per engine
├── Storage      cookies / localStorage / IDB / caches
├── Script       evaluate / exposeBinding / preload scripts
├── Emulation    viewport / locale / UA / network conditions / clock
├── Capture      screenshot / pdf / video
└── Deep (CDP)   coverage / heap / perf / virtual-authenticator / extensions  ← capability-gated
```

The nine cross-browser sub-interfaces are named on `EngineSubInterface`; the
`Deep` escape hatch is the `cdp` capability. **The live port surface is
intentionally thin** — the session layer is the only consumer, so the port
exposes the lifecycle handles the rest of the server builds on (`page()`,
`context()`, optional `cdp()`). The sub-interface names are the typed map of
where each engine-specific behavior lives; they are **declared** on
`EngineCapabilities`, not split into separate method bundles. Splitting them
beyond what an adapter actually needs would be the speculative generality the
doctrine forbids — the audit derives the exact method set from what the session
layer + tools call, and that set is satisfied by the handles above.

### Files

| File                                  | Role                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                            | `EngineKind`, the sub-interface names, `EngineCapabilities`, `EngineSession` shapes.                                               |
| `select.ts`                           | `resolveBrowserType(engine)` → Playwright `BrowserType`; `EngineNotYetSupportedError`.                                             |
| `capabilities.ts`                     | Per-engine capability declarations. Chromium + Android declare everything (incl. `deep`); Firefox + WebKit drop `deep`.            |
| `session-cdp.ts`                      | `requireCdp(session)` — asserts the optional `cdp()` is present.                                                                   |
| `tool-gate.ts`                        | `assertEngineSupports(tool, engine)` — the engine-dimension refusal for the CDP-deep tools.                                        |
| `adapters/playwright-chromium.ts`     | `PlaywrightChromiumAdapter` — wraps the Chromium/CDP launch.                                                                       |
| `adapters/playwright-firefox.ts`      | `PlaywrightFirefoxAdapter` — Juggler Firefox, no CDP; `firefoxChannelFromEnv` (moz-firefox).                                       |
| `adapters/playwright-webkit.ts`       | `PlaywrightWebKitAdapter` — bundled WebKit build, no CDP (the WebKit-engine lane, RFC D7).                                         |
| `adapters/android-cdp.ts`             | `AndroidCdpAdapter` — real Chrome-on-Android over adb + CDP; attach-only, `deep: true` (RFC D3/D8).                                |
| `adapters/adb.ts`                     | adb plumbing — device listing/parse, socket forward, `/json/version` → wsUrl, port mgmt, cleanup, structured errors.               |
| `adapters/safaridriver-hybrid.ts`     | `SafaridriverHybridAdapter` — REAL Safari over safaridriver, WebDriver Classic + experimental BiDi; first non-Playwright.          |
| `adapters/safari/webdriver-client.ts` | `SafariWebDriverClient` — WebDriver-Classic HTTP client (the workhorse: navigate/screenshot/element/cookies/execute).              |
| `adapters/safari/bidi-client.ts`      | `SafariBidiClient` — BiDi WebSocket client (additive: console/nav events, script), gated behind `safari:experimentalWebSocketUrl`. |
| `adapters/safari/launch.ts`           | safaridriver spawn + readiness poll + teardown; `safari-unavailable` / `-remote-automation-disabled` / launch-timeout errors.      |

## The capability dimension

`EngineCapabilities` is the **engine dimension** that composes with the
per-tool capability system (`src/util/capabilities.ts`, 181 mapped entries). An
adapter declares which sub-interfaces it implements and whether it exposes
`deep` (raw CDP). A tool that needs `deep` (the ~19 CDP-hard audit class-B tools:
perf / coverage / heap / CPU throttle / SW interception / extensions / pdf) is
refused on an engine that lacks it through the structured-refusal-with-hint
pattern — not by throwing a vague error mid-call.

Chromium declares everything (all nine sub-interfaces + `deep`); Firefox and
WebKit declare the nine cross-browser sub-interfaces and drop `deep`; Android
declares everything. Behavior on Chromium is byte-identical to a single-engine
build — nothing on Chromium is newly gated.

## `cdp()` is optional — a capability, not a mandatory member

`BrowserSession.cdp()` is `cdp?()` — optional. It is present and fully functional
on engines that speak CDP (chromium, android). Consumers that need the raw handle
(the network tap, the a11y substrate, the ~19 CDP-hard tools, teardown ordering)
route through `requireCdp(session)`, which returns the handle on an engine that
has it and throws a structured, engine-naming error on one that doesn't. On the
CDP hot path `requireCdp` is a single truthiness check and a direct delegate —
no allocation, no indirection on the per-action envelope path.

Because `cdp()` is a capability rather than a mandatory member, opening a session
on a CDP-absent engine never trips an eager `context.newCDPSession(page)`, which
throws off-Chromium. The session factories mint a CDP session only on engines
whose capability declaration includes `deep`.

## Engine selection — no silent fallback

`resolveBrowserType(engine)` maps an `EngineKind` to `playwright[browserType]`.
Chromium, firefox, and webkit are reachable; a declared engine without an adapter
throws `EngineNotYetSupportedError` naming the RFC. Per the doctrine's
no-silent-no-op rule, an unsupported engine fails loudly — it never quietly falls
back to Chromium.

`browserType` threads as a default-`"chromium"` option through the three session
factories (`managed` / `incognito` / `byob`) and the server-level engine
resolution in `server.ts` (`StartOptions.browserType`). Default chromium
everywhere yields byte-identical behavior. The BYOB attach path's loopback /
not-owned policy is protocol-neutral (per the audit) and shared verbatim; only
the transport hop (`connectOverCDP` for chromium) is engine-specific and lives in
the adapter.

## Operator engine selection — `BROWX_ENGINE` / `--engine`

`BROWX_ENGINE=<kind>` (env) or `--engine <kind>` (CLI flag) selects the engine
for every session the server opens. Both resolve through one pure function,
`resolveEngineSelection(argv, env)` (`src/engine/select.ts`), with precedence:

```
explicit --engine flag   >   BROWX_ENGINE env   >   default chromium
```

- `--engine firefox`, `--engine=webkit`, `BROWX_ENGINE=android`, `--engine=safari` — all valid.
- Resolves to `undefined` when neither is set, so `cli.ts` omits `browserType`
  and `server.ts` applies its own `?? "chromium"` default — **byte-identical** for
  anyone not setting the var. Default stays chromium.
- The value is validated against `IMPLEMENTED_ENGINES` (the real list:
  `chromium, firefox, webkit, android, safari`). An unknown value (a typo, an
  unsupported browser) throws `UnknownEngineError` — a **structured** message
  listing the implemented engines (the fix is in the error), printed to stderr
  with `exit 2`. Never a stack trace, never a silent fallback to chromium. A bare
  `--engine` with no value is likewise a loud error.
- This mirrors the inline env/flag idiom (`BROWX_HEADLESS`, `BROWX_ATTACH_CDP`),
  lifted into a function so the precedence + validation are unit-testable without
  a browser (`src/engine/select-operator.test.ts`).

**Composition with the per-engine sub-selectors.** `BROWX_ENGINE` is the
**top-level** switch; the engine-specific knobs compose beneath it:

| Compose                                                      | Effect                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `BROWX_ENGINE=firefox` + `BROWX_FIREFOX_CHANNEL=moz-firefox` | Firefox engine on the experimental stock-Firefox WebDriver-BiDi channel (`firefoxChannelFromEnv`) instead of bundled Juggler. |
| `BROWX_ENGINE=android` + `BROWX_ANDROID_SERIAL=<serial>`     | Android engine, disambiguating **which** connected device when several are USB-attached.                                      |

`BROWX_ENGINE=android` **implies attach-mode** — `server.ts` defaults the android
engine to `mode:"attached"` (the endpoint is **discovered over adb**, not
configured), so **no separate `BROWX_ATTACH_CDP` is needed** (and none applies —
adb publishes the `localabstract:chrome_devtools_remote` socket). Selecting
firefox/webkit with no installed binary, or android with no reachable device,
surfaces the structured engine error at session open (a missing firefox binary,
`no-device`, `chrome-socket-unreachable`, …) — the selection path reaches it
cleanly; it does not duplicate the check.

**Doctor.** `browxai doctor` resolves the selected engine the **same way** the
server does (`resolveEngineSelection(process.argv.slice(2))`) and its `engine`
row reports the **selected** engine (not a hardcoded `chromium`), pointing at the
matching per-engine availability row above it (`chromium` / `firefox` / `webkit` /
`android` — those checks always run, so the selected engine's readiness — binary
present / device reachable — is visible in one glance). An invalid selection
shows as a ✗ with the same implemented-engines message the server prints.

## Engine-support matrix

Each engine runs behind the port today. What each supports is live fact, keyed on
its capability declaration:

| Engine                | CDP / `deep`  | Attach (BYOB)                                   | Read + action core (snapshot/find/click)      | Network tap           |
| --------------------- | :-----------: | ----------------------------------------------- | --------------------------------------------- | --------------------- |
| chromium              | `deep: true`  | connectOverCDP                                  | CDP substrate                                 | CDP tap               |
| android (adb+CDP)     | `deep: true`  | attach-only (adb-discovered socket)             | CDP substrate                                 | CDP tap               |
| firefox (Juggler)     | `deep: false` | structured refusal (BiDi-launch model)          | page-side walker substrate                    | Playwright-event tap  |
| webkit (bundled)      | `deep: false` | structured refusal (no attach client)           | page-side walker substrate                    | Playwright-event tap  |
| safari (safaridriver) | `deep: false` | structured refusal (isolated automation window) | WebDriver DOM-walk substrate (curated subset) | no protocol-level tap |

The seam is correct by construction: all Chromium tests pass — the unit suite and
the Chromium keystone lane — because the 139 class-A tools route through the
adapter transparently with no behavior change. A keystone assertion confirms the
active engine reports through the seam (`list_sessions` → `session.engine`).

**Committed but not yet shipped** (tracked in the RFC): the stock-Firefox
`moz-firefox` WebDriver-BiDi adapter row, and a real-Safari-BiDi engine row when
Safari ships BiDi upstream. Both ride the same port; see
[`docs/rfcs/0002-multi-engine-bidi.md`](../../rfcs/0002-multi-engine-bidi.md).

## Firefox (the second engine)

`adapters/playwright-firefox.ts` (`PlaywrightFirefoxAdapter`) implements the
managed + ephemeral launch shapes over `resolveBrowserType("firefox")`
(Playwright's bundled Juggler Firefox, the supported v1 lane per RFC D2). It
mints **no eager CDP session** — `newCDPSession` throws on Firefox (measured),
and `FIREFOX_CAPABILITIES` declares `deep: false`. The session factories
(`managed` / `incognito` / `byob`) dispatch by `browserType`: the Firefox path
constructs the session with `cdp` absent, and the network/WS buffers are
constructed un-attached until the substrate selectors route them to the
Playwright-event path.

**The capability gate.** `tool-gate.ts`'s `assertEngineSupports(tool, engine)` is
the engine dimension. It refuses the CDP-deep tools (audit class B + the live-CDP
class-C tools) on an engine with `deep: false`, returning the same `{error, hint}`
refusal envelope `assertPdfSupported` uses. `server.ts` calls it as
`engineGate(tool, e)` right after the per-tool `gateCheck` and `entryFor` — so a
Firefox session refuses `perf_start` / `pdf_save` / `cpu_emulate` / … with
`engine:"firefox"` + a hint, never an opaque `requireCdp` crash mid-call.

**Two-track per D2.** The default lane is bundled Juggler (the tested keystone
lane). The experimental stock-Firefox `moz-firefox` WebDriver-BiDi channel rides
behind `BROWX_FIREFOX_CHANNEL=moz-firefox` (`firefoxChannelFromEnv`), spliced
onto the Playwright `channel` launch option. It is **un-gated by the keystone**
(Mozilla-M20 streaming gaps per the research); an unknown channel value is
rejected loudly.

**Firefox BYOB** is a structured refusal (`firefox-attach-not-supported`,
RFC D3): Firefox removed CDP in v141, and Playwright has no `connectOverBiDi`
for a user's running Firefox. The Firefox attach model is a glass-box BiDi
**launch** of the real profile (`--remote-debugging-port`, profile-lock-bound),
not a CDP-attach; `BROWX_ATTACH_BIDI` is the reserved name.

## The snapshot/a11y substrate (RFC D4 — hybrid behind one interface)

The read core (`snapshot` / `find` / `extract` / `text_search` / `set-of-marks` /
`plan`) and the action-window pre/post `snapshotDelta` mint refs from **one**
`SnapshotSubstrate` interface (`src/page/snapshot-substrate.ts`), not a raw
`CDPSession`. This is what un-gates `navigate` / `click` / `fill` / `snapshot` /
`find` on the CDP-absent engines. The seam is dependency direction made concrete:
tools → `SnapshotSubstrate` → implementation → CDP / Playwright. The engine handle
is captured at substrate construction, so the per-call method surface carries no
engine type — that is the line that decouples the read/action core from CDP.

Two methods, derived from what the tools call (no speculative members):

| Method                            | Callers                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `compose(refs, testAttrs, opts?)` | snapshot / find / extract / text_search / set-of-marks / plan / shadow_trees ref-resolve |
| `a11yTree(refs, testAttrs)`       | the action window's pre/post `snapshotDelta`; `watch`'s region sampling                  |

Two implementations (hybrid per D4):

- **`CdpSnapshotSubstrate` (chromium / android)** — delegates to `composeSnapshot`
  / `getA11yTree` over the captured `CDPSession`. Byte-identical to the
  single-engine CDP path: the chromium keystones + unit tests pass unchanged.
- **`PlaywrightSnapshotSubstrate` (firefox / webkit)** — the page-side ARIA/DOM
  walker over `frame.evaluate` (main world), the same `PAGE_SCRIPT` the portable
  `composeSnapshotForFrame` runs, generalized to the main frame. It mints the
  same content-hashed ref (`elementKey` over role/name/path/testId), so a ref is
  stable across substrates and across re-snapshots.

Selection is the engine's, declared by whether it exposes the raw-CDP handle
(`snapshotSubstrateFor(session)` — `src/page/snapshot-substrate-select.ts`): CDP
present → the CDP substrate; absent → the walker. No engine-name check scattered
through the tools. Wired once per session entry (`SessionEntry.snapshotSubstrate`)
so the hot snapshot/find path is a captured-handle delegate — a sub-nanosecond
dispatch hop, ~7 orders of magnitude below the millisecond CDP/DOM-walk roundtrip
it wraps; no per-call allocation (doctrine: hot path measured, not guessed).

**Why the walker, not `locator.ariaSnapshot()` (RFC D4 open input #3 —
benchmarked):** `ariaSnapshot()` carries no test attributes, so on a testid-
tagged page it produced 0 testId-bearing nodes vs the walker's 9, hit 0/5 find
targets vs the walker's 4/5, and ran ~10× slower (104 ms vs 10 ms). `find` scores
+5 on a testId hit and `elementKey` hashes testId into the ref, so an ariaSnapshot
substrate degrades both ranking and ref stability. The walker also emits exactly
the `DomWalkEntry` shape the merge path consumes, so the Firefox tree is
byte-shape-identical to the chromium DOM-walk leaves.

**The off-Chromium fidelity tradeoff (a property of the protocol, not a
regression):** Firefox has no `Accessibility.getFullAXTree`, so the walker tree is
a synthetic `WebArea` root with the interactive / test-attr-bearing elements as
leaf children — the same flat shape `composeSnapshotForFrame` produces. The deep
AX structural nesting chromium emits is not present, but `find` / `text_search` /
`extract` walk flat and the ref-minting + ranking signal (role / name / testId /
cssPath) is all there. bbox off-Chromium rides the portable `locatorBoundingBox`
fallback (the walker mints no `backendDOMNodeId`, so the CDP visible-rect path is
skipped). The one true loss is closed-shadow piercing (`shadow_trees`), which
needs CDP `DOM.getDocument({pierce:true})` — gated off Chromium.

The action window's network slice mints its per-action tap from the
`NetworkSubstrate` (below), so it is real on every engine. The a11y delta,
navigation (`page.on('framenavigated')`, cross-browser), console, dialogs, and
element probe build on every engine.

## The network substrate (RFC D5 — hybrid behind one interface)

The network tools (`network_read` / `ws_read` / `network_body`), `asset_export`'s
ring iteration, and the action-window / watch network slice read from **one**
`NetworkSubstrate` interface (`src/page/network-substrate.ts`), not a raw
`CDPSession`. This is what un-gates the network slice on the CDP-absent engines.
Same doctrine as the snapshot substrate: tools → `NetworkSubstrate` →
implementation → CDP / Playwright events; the engine handle is captured at
substrate construction, so the per-call surface carries no engine type. Selection
is the engine's, declared by whether it exposes the raw-CDP handle
(`networkSubstrateFor(session)` — `src/page/network-substrate-select.ts`,
mirroring `snapshotSubstrateFor`): CDP present → the CDP substrate; absent → the
Playwright-event substrate. Wired once per session entry
(`SessionEntry.networkSubstrate`); the session-wide rings
(`SessionEntry.network` / `.ws`) ARE this substrate's rings, attached once.

Two implementations (hybrid per D5):

- **`CdpNetworkSubstrate` (chromium / android)** — owns the `NetworkBuffer` /
  `WsBuffer` / `NetworkTap` / `fetchResponseBody` CDP path. Buffers and per-action
  tap are byte-identical to the single-engine CDP path: the chromium keystones +
  unit tests pass unchanged. Chromium stays on CDP deliberately (see the benchmark
  below).
- **`PlaywrightNetworkSubstrate` (firefox / webkit)** — `PlaywrightNetworkBuffer`
  fed by `context.on('request'|'response'|'requestfailed'|'requestfinished')`,
  `PlaywrightWsBuffer` fed by `page.on('websocket')` `framesent`/`framereceived`,
  and `PlaywrightNetworkTap` for the per-action window. Produces the same
  `NetworkEntry` / `NetworkSummary` / `MutationEntry` / `WsFrame` shapes (the same
  noise-fold via `foldInteresting`, the same secrets masking), so every consumer
  above the seam is engine-blind.

**Why chromium stays on CDP — the envelope benchmark (RFC D5 open input #4,
measured).** The per-action envelope is browxai's hottest path, so keeping
chromium on CDP rather than moving everything to the portable event path is gated
on a measurement (`scripts/bench-network-envelope.ts`, real headless Chromium,
60 iterations against `/perf-audit-page`). Result: full per-action envelope
**CDP 228.40 ms vs event 228.45 ms (Δ 0.02 %, within noise)** — both dominated by
`goto`+settle; pure tap `open()`+`close()` overhead **CDP 0.22 ms vs event
0.32 ms**. The event path adds **no measurable hot-path cost**; chromium already
has a byte-identical CDP path with no upside to swapping it, so the hybrid keeps
chromium on CDP and routes the event path to firefox/webkit only.

**The off-Chromium fidelity tradeoff (a property of the protocol, not a
regression):**

- **resourceType nuance** — Playwright `request.resourceType()` is lowercase and a
  slightly coarser taxonomy; `cdpTypeFromPlaywright` maps it onto the
  CDP-capitalised bucket names so the noise-fold (`NOISE_TYPES`) + `byType` summary
  stay identical in shape. CDP-only types (`Ping`, `CSPViolationReport`, …) fold to
  `Other`.
- **timing precision** — `ms` is wall-clock (request-seen → response-seen), the
  same approximation the CDP tap uses; no high-resolution `timing()` deltas.
- **body availability** — there is no off-Chromium analogue of CDP
  `Network.getResponseBody`'s after-the-fact fetch, so `PlaywrightNetworkBuffer`
  captures bodies at response time into a bounded LRU (default 50) keyed by a
  synthetic request id. `network_body` resolves that id; a body that predates the
  window (or was evicted) reports "not available" — the same best-effort contract
  as the CDP renderer-discard behaviour.
- **SSE** — Server-Sent-Events arrive as a long-lived `eventsource` response, not
  a discrete Playwright event, so the SSE half of `ws_read` degrades off Chromium
  (WS frames are full-fidelity via `page.on('websocket')`).

**`sw_intercept_fetch` stays gated** off Chromium: it rides CDP `Fetch.*` on the
service-worker target, which has no Playwright-event equivalent — it remains in
`DEEP_TOOLS` and structured-refuses on Firefox. The read-side network tools do
not.

## WebKit (the third engine)

`adapters/playwright-webkit.ts` (`PlaywrightWebKitAdapter`) implements the managed

- ephemeral launch shapes over `resolveBrowserType("webkit")` (Playwright's bundled
  WebKit build — the **WebKit-ENGINE correctness lane** per RFC D7, **not** Safari;
  a real-Safari surface is a separate, tiered companion product, never a browxai
  engine adapter). It mirrors `PlaywrightFirefoxAdapter` and mints **no eager CDP
  session** — WebKit has no CDP at all (measured: `newCDPSession` throws "CDP session
  is only available in Chromium"). `WEBKIT_CAPABILITIES` declares all nine
  cross-browser sub-interfaces + `deep: false`, and `webkit` is in
  `IMPLEMENTED_ENGINES`. The three session factories (`managed` / `incognito` /
  `byob`) dispatch the webkit path alongside the firefox one.

**The gate is capability-based — the open/closed law.** `tool-gate.ts`'s
`assertEngineSupports` keys on the `deep` capability (`caps.deep`), not an engine
name. A new engine that drops `deep` is gated by its capability declaration alone,
with no gate edit. WebKit (`deep: false`) is the proof: it reuses the same gate as
Firefox to refuse the CDP-deep tools. This is the open/closed-correct design the
doctrine asks for: a new engine = a new adapter + a capability row, not a gate
edit.

**Substrate selection keys on CDP presence, not engine name.**
`snapshotSubstrateFor` and `networkSubstrateFor` select the page-side walker +
Playwright-event substrates whenever CDP is absent, so any CDP-absent engine rides
them without per-tool code. WebKit is the live example: it gets `snapshot` /
`find` / `navigate` / `click` / `fill` / `text_search` / `extract` /
`set_of_marks` / `plan` from `PlaywrightSnapshotSubstrate`, and `network_read` /
`ws_read` / `network_body` + the action envelope's network slice from
`PlaywrightNetworkSubstrate`, exactly as on Firefox — with no substrate code
change.

**WebKit BYOB** is a structured refusal (`webkit-attach-not-supported`, RFC D7):
WebKit has no CDP attach client and Safari has not shipped BiDi (June 2026), and
safaridriver hard-isolates automation into a clean ephemeral window — attach-to-
the-live-session is impossible by design.

**Persistent mode works** (measured: `webkit.launchPersistentContext` succeeds in
the installed Playwright build), so managed WebKit sessions are real. The RFC D7
"persistent-mode-on-WebKit is a known loss" caveat is about real-Safari, not the
WebKit engine build; the reserved `webkit-persistent-not-supported` reason
surfaces only if a future Playwright/WebKit build drops persistent-context
support.

## Android (the fourth engine — real Chrome-on-Android over adb + CDP)

`adapters/android-cdp.ts` (`AndroidCdpAdapter`) attaches to the user's **real
Chrome-on-Android** over `adb` + CDP (RFC 0002 D3/D8). This is the surviving
full-fidelity real-profile BYOB lane — the **one place** attach-to-a-real-profile
works post-Chrome-136 (see the Chrome-136 finding below).

**Android is `deep: true`.** Unlike firefox/webkit, Android Chrome speaks **full
CDP**, so `ANDROID_CAPABILITIES` declares all nine cross-browser sub-interfaces
**plus `deep`**. Three consequences, all of which mean **no new substrate code**:

- the substrate selectors (`snapshotSubstrateFor` / `networkSubstrateFor`) key on
  CDP presence, so Android falls into the **same `CdpSnapshotSubstrate` /
  `CdpNetworkSubstrate` path as desktop Chromium** — verbatim, automatically;
- the capability-based engine gate **auto-ALLOWS every tool** (it refuses only on
  `deep: false`), so the CDP-deep tools (perf / coverage / heap / cpu / clock /
  CDP input / closed-shadow) **all work** on Android — the exact tools
  firefox/webkit refuse;
- the eager CDP session is minted on attach, exactly like the Chromium adapter.

Android is therefore the **smallest, lowest-risk adapter**: the only genuinely new
code is the adb plumbing (`adapters/adb.ts`), not a substrate.

**connectOverCDP, not `playwright._android`.** Both reach the same CDP. The
adapter uses `chromium.connectOverCDP(<ws-from-adb-forwarded-socket>)` because it
returns the exact `Browser` + `newCDPSession` handles the desktop BYOB path wires
(`attachOverCdp` in `playwright-chromium.ts`), so the substrate selectors, the
network tap, the a11y substrate, and teardown all work **unchanged**.
`playwright._android` is a separate experimental **device** API
(`_android.devices()` → `AndroidDevice`) that owns its own adb orchestration and
returns a device-shaped object, not the `Browser`/`CDPSession` pair the rest of
browxai is built on — adopting it would fork the session model. The adb
orchestration stays explicit in `adb.ts` (the most existing-code reuse) and
`android` resolves to the `chromium` `BrowserType` for the transport hop.
(Measured against Playwright 1.60: `chromium.connectOverCDP` is a function;
`_android` is the device API, not a `connectOverCDP` substitute.)

**The attach path** (`AndroidCdpAdapter.attach`):

1. `adb [-s <serial>] devices` → parse → select the ready device
   (`BROWX_ANDROID_SERIAL` picks one when several are connected);
2. `adb [-s <serial>] forward tcp:<freePort> localabstract:chrome_devtools_remote`
   (the abstract-namespace socket Chrome-on-Android publishes; the forward is
   **loopback** by construction → byob.ts's loopback / not-owned policy applies);
3. `GET http://127.0.0.1:<freePort>/json/version` → `webSocketDebuggerUrl`;
4. `chromium.connectOverCDP(wsUrl)` → the real device's Chrome.

On any failure after the forward is established, the forward is removed before the
error propagates (no leaked adb forwards). Session close detaches CDP **and**
removes the adb forward; it never closes the browser (not-owned — it's the user's
phone Chrome).

**LAUNCH is attach-only.** Managed / ephemeral launch means "spawn a browser
process we own", which is not a thing on a phone the user controls. The adapter's
`launch()` returns a structured `android-launch-not-supported`; the managed +
incognito factories surface it before trying to launch a local chromium.

**Structured errors (no crashes).** `adb.ts` names every requirement:
`adb-missing` (platform-tools not on PATH), `no-device` (none connected, or all
unauthorized/offline — names the on-device RSA-prompt / re-plug fix),
`ambiguous-device` (several ready → set `BROWX_ANDROID_SERIAL`),
`chrome-socket-unreachable` (Chrome closed / web-debugging off).

**Chrome-136 finding.** The Chrome-136 anti-infostealer block targets the desktop
`--remote-debugging-port` / `--remote-debugging-pipe` switches combined with the
default `--user-data-dir` (the switches now require a non-standard data dir).
Android does **not** use that switch at all: the DevTools endpoint is published by
the OS as an abstract-namespace unix socket
(`localabstract:chrome_devtools_remote`), reachable only after the user enables
USB debugging + on-device USB web-debugging — a fundamentally different,
user-gated, Google-sanctioned mechanism. The Chrome-136 block does **not** apply
to the Android localabstract path, so full-fidelity BYOB-to-the-real-profile holds
on Android. Sources: `developer.chrome.com/blog/remote-debugging-port`
(desktop-only, no Android mention) and
`developer.chrome.com/docs/devtools/remote-debugging` (the Android adb path is
gated by USB debugging, not a profile flag).

**Doctor** gains an Android-availability check (informational — never fails
doctor): it reports how far the adb + CDP chain reaches (adb present → device
ready → Chrome socket reachable), forwarding the socket + probing `/json/version`
then removing the forward, without opening a session.

**Device-gated keystone** (`test/keystone/android.keystone.test.ts`): the **same
honest device-gate** the firefox/webkit keystones use for their binaries — it
`describe.skip`s cleanly when no Android device is connected (so the lane is green
in CI / on this machine), and when a device IS present it attaches, asserts the
engine tag is `android`, runs navigate → snapshot → find on the real device, AND
runs a deep tool (`coverage_start`) to prove `deep: true` (the exact tool
firefox/webkit refuse). It is **not** a silently-passing mock — mocks cannot prove
the adb forward → `/json/version` → `connectOverCDP` chain reaches a real phone.

### Per-engine capability matrix (RFC task #24)

Tool family × engine. **works** = runs through the cross-browser surface;
**gated** = structured-refused with a hint (the engine lacks the substrate).
Firefox and WebKit run the snapshot/a11y read + action core and the network/WS tap

- response-body fetch through the engine-agnostic walker + network substrates and
  the capability-based gate. **Android is the standout: every row is `works`,
  including the deep rows** — Android Chrome speaks full CDP (`deep: true`), so the
  CDP substrates serve it verbatim and the gate auto-allows everything. The only
  Android-specific limit is launch-shape: managed/ephemeral launch refuses
  (`android-launch-not-supported`) — Android is attach-only.

| Tool family                                                           | Chromium |         Firefox (Juggler)         |           WebKit           |         Android (adb+CDP)         |
| --------------------------------------------------------------------- | :------: | :-------------------------------: | :------------------------: | :-------------------------------: |
| Session lifecycle (open/close/list); engine tag                       |  works   |               works               |           works            |        works (attach-only)        |
| Storage — cookies / localStorage / sessionStorage / IDB / caches      |  works   |               works               |           works            |               works               |
| `dump_storage_state` / `inject_storage_state` / `auth_*`              |  works   |               works               |           works            |               works               |
| `screenshot` / `screenshot_region` / `screenshot_schedule`            |  works   |               works               |           works            |               works               |
| `set_geolocation` / `set_color_scheme` / `set_reduced_motion`         |  works   |               works               |           works            |               works               |
| HAR / video / route mocking / WS-interactive / canvas                 |  works   |               works               |           works            |               works               |
| `navigate` / `click` / `fill` / `snapshot` / `find` (a11y substrate)  |  works   |        **works** (walker)         |     **works** (walker)     |     **works** (CDP substrate)     |
| `text_search` / `extract` / `screenshot_marks` / `plan` (a11y)        |  works   |        **works** (walker)         |     **works** (walker)     |     **works** (CDP substrate)     |
| `network_read` / `ws_read` / `network_body` (hybrid tap)              |  works   |     **works** (PW-event tap)      |    **works** (PW-event)    |   **works** (CDP tap, verbatim)   |
| `shadow_trees` — closed-shadow pierce (CDP `DOM.getDocument`)         |  works   |             **gated**             |         **gated**          |       **works** (full CDP)        |
| perf (`perf_*`, `layout_thrash_trace`) — CDP `Tracing.*`              |  works   |             **gated**             |         **gated**          |       **works** (full CDP)        |
| coverage (`coverage_*`) — CDP `Profiler`/`CSS`                        |  works   |             **gated**             |         **gated**          |       **works** (full CDP)        |
| heap (`heap_snapshot` / `heap_retainers`) — CDP `HeapProfiler`        |  works   |             **gated**             |         **gated**          |       **works** (full CDP)        |
| `cpu_emulate` (CDP CPU throttle); `clock` (virtual time)              |  works   |             **gated**             |         **gated**          |       **works** (full CDP)        |
| `network_emulate` (link throttle)                                     |  works   |    **gated** (refuse-pending)     | **gated** (refuse-pending) |       **works** (full CDP)        |
| SW fetch interception (`sw_intercept_fetch` / `sw_unintercept_fetch`) |  works   |             **gated**             |         **gated**          |       **works** (full CDP)        |
| extensions (`extensions_*`) — Chromium launch flags                   |  works   |             **gated**             |         **gated**          | n/a (attach-only — launch flags)  |
| `pdf_save` — `page.pdf()` (Headless-Chromium-only)                    |  works   | **gated** (Firefox-specific hint) |         **gated**          |   works (CDP `Page.printToPDF`)   |
| `set_locale` / `set_timezone` — live CDP `Emulation.*`                |  works   |   **gated** (bake at creation)    |         **gated**          |       **works** (full CDP)        |
| `set_user_agent` — live CDP UA override                               |  works   | **gated** (no live PW UA setter)  |         **gated**          |       **works** (full CDP)        |
| touch / multi-touch / `mouse_wheel` — CDP `Input.dispatch*`           |  works   |             **gated**             |         **gated**          | **works** (full CDP — real touch) |
| device emulation (`emulate_bluetooth`/`usb`/`hid`) — platform API     |  works   |  moot (API absent off-Chromium)   |            moot            |    moot (real device hardware)    |

`perf_insights` / `heap_retainers` / `memory_diff` are pure file parsers over a
Chromium-produced trace/heapsnapshot — they are **not** engine-gated (the data
already exists; an agent can parse it from any session). The Firefox + WebKit
keystones each assert the **works** rows on the real engine (cookies /
storageState / screenshot; navigate → snapshot → find → fill → click via the
walker substrate; `network_read` surfacing a real Script subresource record +
`network_body` resolving its requestId) and a sample of the **gated** rows. The
WebKit column is identical to Firefox by construction: WebKit rides the **same**
engine-agnostic walker + network substrates and the same capability-based gate
(`deep: false`), so no per-tool work brings it online — only the adapter + the
capability row. **The Android column is the inverse of WebKit's: it is identical to
_Chromium_ by construction** — Android declares `deep: true`, so the CDP substrates

- the capability-based gate route it through the exact Chromium path with no
  per-tool work, only the adapter + the adb plumbing + the capability row. The
  device-gated keystone asserts the engine tag, navigate → snapshot → find, AND a
  deep tool (`coverage_start`) running — the proof of `deep: true` — on a real
  connected device (skips cleanly otherwise). The attach-only `n/a` for
  `extensions_*` is launch-shape, not a CDP limit: extension loading is a Chromium
  **launch-flag** concern, and Android is attach-only.

### Safari — the curated subset (first non-Playwright engine)

Safari is the odd one out and gets a prose row rather than a table column: it has
**no Playwright Page and no CDP**, so `session.page()` THROWS (`safari-no-playwright-page`)
and the cross-browser Playwright surface the table assumes does not exist. Real
Safari.app is driven over `safaridriver` (WebDriver Classic, the workhorse) + the
experimental BiDi socket (gated behind `safari:experimentalWebSocketUrl` — console

- nav events + script). The capability declaration is a **subset**
  (`lifecycle/navigation/snapshot/input/storage/script/capture`, `deep: false`; no
  `network`, no full `emulation`). Per-family status:

* **works:** session lifecycle (engine tag `safari`); `navigate` (routed through
  `safariNavigate` → WebDriver Classic, NOT the Playwright action envelope);
  `snapshot` / `find` / `text_search` / `extract` (the `SafariClassicSnapshotSubstrate`
  runs browxai's DOM-walk over WebDriver `execute/sync` — spike-confirmed identical
  to `frame.evaluate`; refs are content-hashed + stable; `find` ranks from the tree
  without locator bbox/actionability).
* **gated (page()-throw; an action substrate over WebDriver element interaction is
  the committed follow-up):** `click` / `fill` / `press` / `hover` / `select` and
  the rest of the Playwright action envelope; `screenshot` / `cookies_*` /
  `eval_js` (each needs a small safari handler branch — follow-up).
* **gated (engine gate, `deep: false`):** the whole CDP-deep family (perf / coverage
  / heap / cpu / clock / SW-interception / shadow_trees / touch / pdf / live
  locale-timezone-UA) — refuses with `engine: "safari"`, no per-tool edit.
* **gated (no substrate at all):** `network_read` / `ws_read` / `network_body` — Safari
  has no protocol-level network tap (the `SafariNoopNetworkSubstrate` reports empty +
  a structured `network_body` refusal).

Non-BYOB: every Safari session is an isolated automation window (no real-profile
cookies/storage/history) — `incognito` and `byob`/attach both structured-refuse
(`safari-incognito-not-supported` / `safari-attach-not-supported`). There is no
headless Safari. The real-Safari keystone (`test/keystone/safari.keystone.test.ts`,
skips off-mac) asserts open → `engine:safari` → navigate → snapshot → find + the
deep-tool refusal on a real Safari. Full design + follow-ups:
[`../../rfcs/references/07-safari-adapter-implementation-plan.md`](../../rfcs/references/07-safari-adapter-implementation-plan.md).

## Related

- [`architecture-principles.md`](architecture-principles.md) — the doctrine this conforms to (dependency direction, proven-seam test, performance at the core).
- [`capability-posture-map.md`](capability-posture-map.md) — the per-tool capability lattice the engine dimension composes with.
- [`../../rfcs/0002-multi-engine-bidi.md`](../../rfcs/0002-multi-engine-bidi.md) — the rulings (D1–D8) and phasing.
- [`../../rfcs/references/03-browxai-coupling-audit.md`](../../rfcs/references/03-browxai-coupling-audit.md) — the file:line coupling evidence.
