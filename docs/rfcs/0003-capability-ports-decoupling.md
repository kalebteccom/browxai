# RFC 0003 — Engine-blind tool surface via capability ports

**Date:** 2026-06-13
**Status:** Draft — **P1 (`ActionSubstrate`) LANDED & gate-green** (1785 unit + the 5-engine keystones; server.ts no longer imports the Playwright `actions` module — the whole action capability is behind the port, and the `if (engine === "safari")` action branches are deleted). P2–P5 remain. **Author:** Claude (architecture).
**Trigger:** Owner directive — the MCP server (`src/server.ts`) and the page tools are hard-coupled to Playwright `Page` / CDP and now carry per-engine `if (engine === "safari")` branches. Make the whole tool surface depend on **capability ports**, not on a concrete engine. Apply SOLID across the project, conforming to [`docs/ai-context/agent-process/code-quality.md`](../ai-context/agent-process/code-quality.md) and [`docs/ai-context/architecture/architecture-principles.md`](../ai-context/architecture/architecture-principles.md).

This extends [RFC 0002](0002-multi-engine-bidi.md): that RFC introduced the `BrowserEngine` port + the `SnapshotSubstrate` / `NetworkSubstrate` capability ports and proved the strangler-fig migration with five engines. This RFC generalises that **proven** pattern to **every** capability family so no tool handler — and ultimately no module above the engine seam — names Playwright, CDP, or an engine.

## The problem (measured)

`src/server.ts` is 13,247 lines and is supposed to be **registry composition only** (per code-quality.md §SRP). It is not:

- **135** direct `sess.page()` / `.context()` calls in tool handlers — every one a hard dependency on a Playwright `Page`.
- **15** `ctxFor(e)` sites build an `ActionContext { page, … }` and hand it to `actions.*` — the action path is Playwright-typed end to end.
- **11** `if (engine === "safari")` / `sess.safari?.()` branches (added landing Safari, the first non-Playwright engine) — a handler that branches on engine is an **open/closed violation**: a sixth engine means editing every branched handler again.
- **32** `requireCdp()` sites — these are the **correctly-gated** CDP-deep tools (perf/coverage/heap/…); they genuinely require CDP and refuse on engines without it. That is the honest-gating pattern, **not** a coupling smell, and is out of scope here.

The smell is concentrated in the **capability families that have NO port yet**: action, capture, storage, script, input, emulation. Snapshot and network already have ports (RFC 0002 P2a/P2b) and are engine-blind today.

## The principle — dependency inversion at the capability boundary

A tool handler must depend on **what it needs done** (an abstract capability), never on **who does it** (Playwright / CDP / WebDriver). The dependency arrow points inward: `tool handler → capability port (interface) → engine adapter → Playwright | CDP | safaridriver`. No arrow ever points back out toward a concrete engine from a handler.

This is already true for snapshot (`ctx.snapshotSubstrate.compose(...)`) and network (`ctx.networkSubstrate.openActionTap()`). The target is that it is true for **all** capabilities.

## The target port surface

Each capability family is a segregated port (interface segregation — a handler asks for the one capability it needs). Engines declare which they implement via the existing `EngineCapabilities`; a tool whose capability the engine lacks structured-refuses through the existing gate, never crashes.

| Port                   | Methods (representative)                                                                                  | Status                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `SnapshotSubstrate`    | `compose`, `a11yTree`                                                                                     | ✅ exists (RFC 0002 P2a)                                                 |
| `NetworkSubstrate`     | `http`/`ws` rings, `openActionTap`, `fetchBody`                                                           | ✅ exists (RFC 0002 P2b)                                                 |
| **`ActionSubstrate`**  | `navigate`, `click`, `fill`, `press`, `hover`, `select`, `scroll`, `goBack`, `goForward` → `ActionResult` | ⏳ **Phase 1 (this RFC)**                                                |
| **`CaptureSubstrate`** | `screenshot`, `pdf`, `video`                                                                              | ⏳ Phase 2                                                               |
| **`StorageSubstrate`** | `cookies` (get/set/list/delete/clear), `localStorage`, `sessionStorage`, `idb`, `caches`                  | ⏳ Phase 2                                                               |
| **`ScriptSubstrate`**  | `evaluate`, `exposeBinding`, `addInitScript`                                                              | ⏳ Phase 2                                                               |
| `EmulationSubstrate`   | viewport / locale / timezone / UA / geolocation / colour-scheme                                           | ⏳ Phase 3                                                               |
| `InputSubstrate`       | coordinate mouse/touch/wheel/gesture                                                                      | ⏳ Phase 3 (CDP-deep — mostly gated off-Chromium)                        |
| `Deep` (raw CDP)       | perf / coverage / heap / clock / SW-intercept / virtual-authenticator                                     | ✅ already a gated escape hatch (`requireCdp`) — stays gated, NOT ported |

Each port is selected **by capability** at session creation (the engine's declaration), captured once per session, so the hot path is a captured-handle delegate with no per-call allocation — identical to how `snapshotSubstrateFor` / `networkSubstrateFor` work today.

## The engine-blind handler contract

After migration a handler reads:

```ts
register("click", { … }, async (args) => {
  const g = gateCheck("click"); if (g) return g;
  const e = await entryFor(args.session);
  const c = await confirmByobAction("click", confirmCtxFor(e)); if (!c.ok) return denyContent("click", c);
  return asActionResultText(actionsFor(e).click(asTarget(args, "click", e.refs), opts(args)));
});
```

No `sess.page()`, no `ctxFor`, no `if (engine === …)`. `actionsFor(e)` returns the engine's `ActionSubstrate` (the same selector-by-capability shape as `snapshotSubstrateFor(e.session)`). `server.ts` is back to registry composition + gate composition only; the engine specifics live in the adapters.

## Phasing (strangler-fig — gate green every step, the RFC 0002-proven discipline)

Each phase introduces ONE port, ports BOTH the existing Playwright/CDP behaviour (byte-identical for the four Playwright engines — verified by their keystones) AND the Safari behaviour (the branches added in the Safari landing collapse INTO the Safari adapter), then deletes the now-dead handler branches. No phase changes external behaviour; the engine keystones (chromium/firefox/webkit/android/safari) are the regression gate.

- **P1 — `ActionSubstrate`** (the hottest, most-coupled path; the 15 `ctxFor` sites + the 8 Safari action branches). `PlaywrightActionSubstrate` wraps today's `actions.*` verbatim; `SafariActionSubstrate` wraps `safari-actions.*` verbatim; `actionsFor(e)` selects. Handlers lose `ctxFor` + the safari branches.
- **P2 — `CaptureSubstrate` + `StorageSubstrate` + `ScriptSubstrate`** (screenshot / cookies+web-storage / eval). Collapses the remaining Safari handler branches (screenshot/cookies/eval) + the page() leakage in those families.
- **P3 — `EmulationSubstrate` + `InputSubstrate`** (viewport/locale/UA/…, coordinate input). Most are CDP-deep and already gate off-Chromium; the port makes the gating declarative instead of per-handler.
- **P4 — residual `sess.page()` sweep** — the long tail (frames, workers, downloads, dialogs, …). Each either moves behind an existing port or is honestly gated. Target: **zero** `sess.page()` in `server.ts`.
- **P5 — project-wide application** — apply the same dependency-inversion review to `src/session/`, `src/policy/`, `src/plugin/` (the plugin runtime is already DI'd via `PluginApi`), `src/sdk/` (already on a `Transport` abstraction). Document the per-module port boundaries in `docs/ai-context/architecture/`.

## SOLID mapping

- **SRP** — `server.ts` returns to registry-composition-only; capability logic lives in its port impl, one family per module.
- **Open/closed** — a new engine adds adapters, never edits a handler. The `if (engine === "safari")` branches (an OCP violation) are deleted.
- **Liskov** — every adapter returns the universal `ActionResult` / substrate shapes; an adapter that returns a partial shape is a bug the keystone catches.
- **Interface segregation** — segregated per-capability ports; a handler depends only on the family it uses.
- **Dependency inversion** — handlers depend on the port interfaces; adapters depend on Playwright/CDP/WebDriver. The arrow never reverses.

## Scope + non-goals

In scope: the capability-port surface for `server.ts` + the page tools + the session layer. Out of scope: the 32 CDP-deep tools (correctly gated already), the `Deep` escape hatch (a deliberate raw-CDP capability, not a leak), and any behaviour change (this is a pure decoupling — outputs are byte-identical per engine).

## References

- [RFC 0002](0002-multi-engine-bidi.md) — the `BrowserEngine` port + the first two capability ports (snapshot, network) + the five-engine proof.
- [`docs/ai-context/architecture/engine-adapters.md`](../ai-context/architecture/engine-adapters.md) — the per-engine capability matrix.
- [`docs/ai-context/agent-process/code-quality.md`](../ai-context/agent-process/code-quality.md) — the SOLID bar this conforms to.
