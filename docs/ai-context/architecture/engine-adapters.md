# The `BrowserEngine` engine-adapter seam

The seam beneath the session layer that lets browxai drive engines other than
Chromium without rewriting the ~139 tools that already speak only Playwright's
cross-browser surface. This is dependency inversion at the engine boundary: the
session layer (and the tools above it) depend on the port; the port depends on
an adapter; the adapter depends on Playwright. Dependencies point inward — never
back out toward Playwright/CDP from a tool.

It implements **P0 + P1** of [`docs/rfcs/0002-multi-engine-bidi.md`](../../rfcs/0002-multi-engine-bidi.md)
(decision D1: strangler-fig, minimal-first, shaped for growth; D2/D3/D6 for the
Firefox lane) against the file:line evidence in
[`references/03-browxai-coupling-audit.md`](../../rfcs/references/03-browxai-coupling-audit.md).
P0 extracted the port + the Chromium adapter (zero behavior change); P1 landed
Firefox as the second engine + the engine-dimension capability gate. Read both
for the rulings and the coupling map; this doc is the contract for the code that
landed.

## Why the seam is proven (not speculative)

The [architecture doctrine](architecture-principles.md) forbids ports without a
second real implementation or a committed near-term need. This one qualifies:
the RFC commits to Firefox and WebKit (Firefox 141 removed CDP entirely — the
only forward path is BiDi/Marionette, so a Chromium-only product is a dead end
for the owner's directive), and the coupling audit names every seam the second
engine touches. Firefox is the proven second implementation on the horizon; the
port is the cheap, safe refactor that lets it land as an adapter rather than a
rewrite.

## The port (`src/engine/`)

```
EngineKind = "chromium" | "firefox" | "webkit"   // engines the RFC commits to

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
`Deep` escape hatch is the `cdp` capability. **In P0 the live port surface is
intentionally thin** — the session layer is the only consumer, so the port
exposes the lifecycle handles the rest of the server already builds on
(`page()`, `context()`, optional `cdp()`). The sub-interface names are the typed
map of where each engine-specific behavior lives as adapters grow; they are
**declared** on `EngineCapabilities`, not yet split into separate method bundles.
Splitting them before the second adapter exists would be the speculative
generality the doctrine forbids — the audit derives the exact method set from
what the session layer + tools actually call today, and that set is satisfied by
the handles above.

### Files

| File                              | Role                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `types.ts`                        | `EngineKind`, the sub-interface names, `EngineCapabilities`, `EngineSession` shapes.         |
| `select.ts`                       | `resolveBrowserType(engine)` → Playwright `BrowserType`; `EngineNotYetSupportedError`.       |
| `capabilities.ts`                 | Per-engine capability declarations. Chromium declares everything; Firefox drops `deep`.      |
| `session-cdp.ts`                  | `requireCdp(session)` — asserts the now-optional `cdp()` is present.                         |
| `tool-gate.ts`                    | `assertEngineSupports(tool, engine)` — the engine-dimension refusal for the CDP-deep tools.  |
| `adapters/playwright-chromium.ts` | `PlaywrightChromiumAdapter` — wraps today's Chromium/CDP launch verbatim.                    |
| `adapters/playwright-firefox.ts`  | `PlaywrightFirefoxAdapter` — Juggler Firefox, no CDP; `firefoxChannelFromEnv` (moz-firefox). |

## The capability dimension

`EngineCapabilities` is the **engine dimension** that composes with the existing
per-tool capability system (`src/util/capabilities.ts`, 181 mapped entries). An
adapter declares which sub-interfaces it implements and whether it exposes
`deep` (raw CDP). A tool that needs `deep` (the ~19 CDP-hard audit class-B tools:
perf / coverage / heap / CPU throttle / SW interception / extensions / pdf) is
refused on an engine that lacks it through the already-shipped structured-
refusal-with-hint pattern — not by throwing a vague error mid-call.

**In P0, Chromium declares everything** (all nine sub-interfaces + `deep`), so
nothing is newly gated and behavior is byte-identical. Firefox/WebKit
declarations land with their adapters and drop what they can't support.

## `cdp()` is now a capability, not a mandatory member

`BrowserSession.cdp()` used to be a mandatory interface member. That single line
hard-gated multi-engine: all three session factories mint a `CDPSession` eagerly
at open via `context.newCDPSession(page)`, which **throws** off-Chromium — the
server couldn't even open a session on another engine.

`cdp()` is now `cdp?()` — optional. It stays present and fully functional on
Chromium (the only engine wired today). Consumers that need the raw handle (the
network tap, the a11y substrate, the ~19 CDP-hard tools, teardown ordering)
route through `requireCdp(session)`, which returns the handle on an engine that
has it and throws a structured, engine-naming error on one that doesn't. On the
Chromium hot path `requireCdp` is a single truthiness check and a direct
delegate — no allocation, no indirection on the per-action envelope path.

## Engine selection — no silent fallback

`resolveBrowserType(engine)` maps an `EngineKind` to `playwright[browserType]`.
Chromium + firefox are reachable; webkit throws `EngineNotYetSupportedError`
naming the RFC. Per the doctrine's no-silent-no-op rule, an unsupported engine
fails loudly — it never quietly falls back to Chromium.

`browserType` threads as a default-`"chromium"` option through the three session
factories (`managed` / `incognito` / `byob`) and the server-level engine
resolution in `server.ts` (`StartOptions.browserType`). Default chromium
everywhere → byte-identical behavior. The BYOB attach path's loopback /
not-owned policy is protocol-neutral (per the audit) and reused verbatim; only
the transport hop (`connectOverCDP` today) is engine-specific and lives in the
adapter.

## Strangler-fig migration state

| State                                                              | Status |
| ------------------------------------------------------------------ | :----: |
| Port defined; chromium behavior extracted into an adapter          |   ✅   |
| `cdp()` optional; consumers route through `requireCdp`             |   ✅   |
| `browserType` threaded (default chromium); not-yet-supported error |   ✅   |
| Engine dimension on the capability system (chromium = everything)  |   ✅   |
| Doctor reports the active engine                                   |   ✅   |
| Firefox Juggler adapter + Firefox keystone lane + engine gating    |   ✅   |
| Firefox-availability doctor check + `moz-firefox` channel flag     |   ✅   |
| playwright-webkit adapter; snapshot/network hybrid substrates      |   P2   |
| stock-Firefox `moz-firefox` BiDi adapter; Android adb+CDP adapter  |   P3   |
| real-Safari lane; Safari-BiDi engine row when upstream ships       |   P4   |

The proof the seam is correct is that **all existing Chromium tests pass
unchanged** — the unit suite and the Chromium keystone lane. The seam was added
without changing a single tool's behavior; the 139 class-A tools route through
the adapter transparently. A keystone assertion confirms the active engine
reports through the new seam (`list_sessions` → `session.engine`).

## P1: Firefox (the second engine)

`adapters/playwright-firefox.ts` (`PlaywrightFirefoxAdapter`) implements the
managed + ephemeral launch shapes over `resolveBrowserType("firefox")`
(Playwright's bundled Juggler Firefox, the supported v1 lane per RFC D2). It
mints **no eager CDP session** — `newCDPSession` throws on Firefox (measured),
and `FIREFOX_CAPABILITIES` declares `deep: false`. The session factories
(`managed` / `incognito` / `byob`) dispatch by `browserType`: the Firefox path
constructs the session with `cdp` absent, and the CDP-fed network/WS buffers are
constructed un-attached (they no-op until the substrate ports in P2).

**The capability gate (the headline).** `tool-gate.ts`'s
`assertEngineSupports(tool, engine)` is the engine dimension. It refuses the
CDP-deep tools (audit class B + the live-CDP class-C tools) on an engine with
`deep: false`, returning the same `{error, hint}` refusal envelope
`assertPdfSupported` uses. `server.ts` calls it as `engineGate(tool, e)` right
after the per-tool `gateCheck` and `entryFor` — so a Firefox session refuses
`perf_start` / `pdf_save` / `cpu_emulate` / … with `engine:"firefox"` + a hint,
never an opaque `requireCdp` crash mid-call.

**Two-track per D2.** The default lane is bundled Juggler (the tested keystone
lane). The experimental stock-Firefox `moz-firefox` WebDriver-BiDi channel rides
behind `BROWX_FIREFOX_CHANNEL=moz-firefox` (`firefoxChannelFromEnv`), spliced
onto the Playwright `channel` launch option. It is **un-gated by the keystone**
(Mozilla-M20 streaming gaps per the research); an unknown channel value is
rejected loudly.

**Firefox BYOB** is a structured refusal today (`firefox-attach-not-supported`,
RFC D3): Firefox removed CDP in v141, and Playwright has no `connectOverBiDi`
for a user's running Firefox. The Firefox attach model is a glass-box BiDi
**launch** of the real profile (`--remote-debugging-port`, profile-lock-bound),
not a CDP-attach; `BROWX_ATTACH_BIDI` is the reserved name.

### Per-engine capability matrix (RFC task #24)

Tool family × engine. **works** = runs through the cross-browser surface;
**gated** = structured-refused with a hint (the engine lacks the substrate);
**P2** = will work once the snapshot/network CDP substrate ports onto Playwright
events. WebKit's adapter is P2 (column shown for the shape only).

| Tool family                                                           | Chromium |           Firefox (Juggler)            | WebKit |
| --------------------------------------------------------------------- | :------: | :------------------------------------: | :----: |
| Session lifecycle (open/close/list); engine tag                       |  works   |                 works                  |   P2   |
| Storage — cookies / localStorage / sessionStorage / IDB / caches      |  works   |                 works                  |   P2   |
| `dump_storage_state` / `inject_storage_state` / `auth_*`              |  works   |                 works                  |   P2   |
| `screenshot` / `screenshot_region` / `screenshot_schedule`            |  works   |                 works                  |   P2   |
| `set_geolocation` / `set_color_scheme` / `set_reduced_motion`         |  works   |                 works                  |   P2   |
| HAR / video / route mocking / WS-interactive / canvas                 |  works   |                 works                  |   P2   |
| `navigate` / `click` / `fill` / `snapshot` / `find` (CDP envelope)    |  works   | **P2** (a11y + network substrate port) |   P2   |
| `network_read` / `ws_read` / `network_body` (CDP tap)                 |  works   |     **P2** (Playwright-event tap)      |   P2   |
| perf (`perf_*`, `layout_thrash_trace`) — CDP `Tracing.*`              |  works   |               **gated**                |   P2   |
| coverage (`coverage_*`) — CDP `Profiler`/`CSS`                        |  works   |               **gated**                |   P2   |
| heap (`heap_snapshot` / `heap_retainers`) — CDP `HeapProfiler`        |  works   |               **gated**                |   P2   |
| `cpu_emulate` (CDP CPU throttle); `clock` (virtual time)              |  works   |               **gated**                |   P2   |
| `network_emulate` (link throttle)                                     |  works   |       **gated** (refuse-pending)       |   P2   |
| SW fetch interception (`sw_intercept_fetch` / `sw_unintercept_fetch`) |  works   |               **gated**                |   P2   |
| extensions (`extensions_*`) — Chromium launch flags                   |  works   |               **gated**                |   P2   |
| `pdf_save` — `page.pdf()` (Headless-Chromium-only)                    |  works   |   **gated** (Firefox-specific hint)    |   P2   |
| `set_locale` / `set_timezone` — live CDP `Emulation.*`                |  works   |      **gated** (bake at creation)      |   P2   |
| `set_user_agent` — live CDP UA override                               |  works   |    **gated** (no live PW UA setter)    |   P2   |
| touch / multi-touch / `mouse_wheel` — CDP `Input.dispatch*`           |  works   |               **gated**                |   P2   |
| device emulation (`emulate_bluetooth`/`usb`/`hid`) — platform API     |  works   |     moot (API absent off-Chromium)     |  moot  |

`perf_insights` / `heap_retainers` / `memory_diff` are pure file parsers over a
Chromium-produced trace/heapsnapshot — they are **not** engine-gated (the data
already exists; an agent can parse it from any session). The Firefox keystone
asserts the **works** rows (cookies / storageState / screenshot) and a sample of
the **gated** rows on real Firefox; the **P2** rows skip on Firefox until the
substrate ports.

## Related

- [`architecture-principles.md`](architecture-principles.md) — the doctrine this conforms to (dependency direction, proven-seam test, performance at the core).
- [`capability-posture-map.md`](capability-posture-map.md) — the per-tool capability lattice the engine dimension composes with.
- [`../../rfcs/0002-multi-engine-bidi.md`](../../rfcs/0002-multi-engine-bidi.md) — the rulings (D1–D8) and phasing.
- [`../../rfcs/references/03-browxai-coupling-audit.md`](../../rfcs/references/03-browxai-coupling-audit.md) — the file:line coupling evidence.
