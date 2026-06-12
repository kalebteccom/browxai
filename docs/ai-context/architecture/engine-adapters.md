# The `BrowserEngine` engine-adapter seam

The seam beneath the session layer that lets browxai drive engines other than
Chromium without rewriting the ~139 tools that already speak only Playwright's
cross-browser surface. This is dependency inversion at the engine boundary: the
session layer (and the tools above it) depend on the port; the port depends on
an adapter; the adapter depends on Playwright. Dependencies point inward — never
back out toward Playwright/CDP from a tool.

It implements **P0** of [`docs/rfcs/0002-multi-engine-bidi.md`](../../rfcs/0002-multi-engine-bidi.md)
(decision D1: strangler-fig, minimal-first, shaped for growth) against the
file:line evidence in
[`references/03-browxai-coupling-audit.md`](../../rfcs/references/03-browxai-coupling-audit.md).
Read both for the rulings and the coupling map; this doc is the contract for the
code that landed.

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

| File                              | Role                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `types.ts`                        | `EngineKind`, the sub-interface names, `EngineCapabilities`, `EngineSession` shapes.   |
| `select.ts`                       | `resolveBrowserType(engine)` → Playwright `BrowserType`; `EngineNotYetSupportedError`. |
| `capabilities.ts`                 | Per-engine capability declarations. Chromium declares everything.                      |
| `session-cdp.ts`                  | `requireCdp(session)` — asserts the now-optional `cdp()` is present.                   |
| `adapters/playwright-chromium.ts` | `PlaywrightChromiumAdapter` — wraps today's Chromium/CDP launch verbatim.              |

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
Only chromium is reachable in P0; firefox/webkit throw
`EngineNotYetSupportedError` naming the RFC. Per the doctrine's no-silent-no-op
rule, an unsupported engine fails loudly — it never quietly falls back to
Chromium.

`browserType` threads as a default-`"chromium"` option through the three session
factories (`managed` / `incognito` / `byob`) and the server-level engine
resolution in `server.ts` (`StartOptions.browserType`). Default chromium
everywhere → byte-identical behavior. The BYOB attach path's loopback /
not-owned policy is protocol-neutral (per the audit) and reused verbatim; only
the transport hop (`connectOverCDP` today) is engine-specific and lives in the
adapter.

## Strangler-fig migration state

| State                                                              | P0 (this) |
| ------------------------------------------------------------------ | :-------: |
| Port defined; chromium behavior extracted into an adapter          |    ✅     |
| `cdp()` optional; consumers route through `requireCdp`             |    ✅     |
| `browserType` threaded (default chromium); not-yet-supported error |    ✅     |
| Engine dimension on the capability system (chromium = everything)  |    ✅     |
| Doctor reports the active engine                                   |    ✅     |
| Firefox Juggler adapter + Firefox keystone lane + engine gating    |    P1     |
| playwright-webkit adapter; snapshot/network hybrid substrates      |    P2     |
| stock-Firefox `moz-firefox` BiDi adapter; Android adb+CDP adapter  |    P3     |
| real-Safari lane; Safari-BiDi engine row when upstream ships       |    P4     |

The proof P0 is correct is that **all existing tests pass unchanged** — the
~1637 unit tests and the keystone lane. The seam was added without changing a
single tool's behavior; the 139 class-A tools route through the adapter
transparently. One keystone assertion was added: the active engine reports
chromium through the new seam (`list_sessions` → `session.engine`).

## How P1 Firefox slots in

A new `adapters/playwright-firefox.ts` implementing the same launch shapes over
`resolveBrowserType("firefox")` (Playwright's bundled Juggler Firefox). It
declares an `EngineCapabilities` that drops `deep` (no CDP) and the sub-
interfaces Firefox can't serve at full fidelity (the audit's per-engine paths:
CDP touch, the SW-interception half of workers, Tracing-based perf, the platform
APIs absent off-Chromium). The engine-dimension capability gate then refuses the
CDP-hard tools on Firefox with a hint, and the snapshot/network substrates move
behind their interfaces (P2) onto Playwright-portable mechanisms
(`locator.ariaSnapshot()` / context `request`/`response` events). The session
factories already thread `browserType`; the launch path already rejects firefox
today — flipping it on is adding the adapter + its capability declaration, not a
core rewrite. **No tool changes.**

## Related

- [`architecture-principles.md`](architecture-principles.md) — the doctrine this conforms to (dependency direction, proven-seam test, performance at the core).
- [`capability-posture-map.md`](capability-posture-map.md) — the per-tool capability lattice the engine dimension composes with.
- [`../../rfcs/0002-multi-engine-bidi.md`](../../rfcs/0002-multi-engine-bidi.md) — the rulings (D1–D8) and phasing.
- [`../../rfcs/references/03-browxai-coupling-audit.md`](../../rfcs/references/03-browxai-coupling-audit.md) — the file:line coupling evidence.
