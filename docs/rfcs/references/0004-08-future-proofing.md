# RFC 0004 / Reference 08 — Future-proofing & the evolutionary-architecture stance

**Parent:** [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) · **Siblings:** [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md), [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md), [`0004-07-prior-art-and-references.md`](0004-07-prior-art-and-references.md)

This reference closes the RFC 0004 suite with the forward-looking claim the hardening exists to earn: that browxai's *next five years of growth* land **add-only** at the seams the refactor (decisions [D1](../0004-architecture-hardening.md#d1)–[D12](../0004-architecture-hardening.md#d12)) closes, and that the fitness functions ([0004-05](0004-05-fitness-functions-and-guardrails.md)) let the architecture *evolve safely* rather than ossify. It is not a feature roadmap — it is an enumeration of the **expected axes of change**, a proof for each that the hardened seam absorbs it without a core edit, and the fitness function that keeps that promise honest. It ends with the discipline that prevents the opposite failure — speculative bloat — and the **maintainability ratchet** that makes the codebase trend strictly more maintainable over time.

---

## 1. The stance: future-proof by seams + fitness functions, not by prediction

The seductive wrong model of "future-proofing" is *prediction* — guess every feature and build the abstraction for it now. The doctrine forbids exactly this. [`architecture-principles.md` §1](../../ai-context/architecture/architecture-principles.md) ("abstract only at a proven seam") is unambiguous: *"A port you do not need is tech debt, the same as a missing one. Speculative generality is the more seductive failure because it looks like good architecture."* The proven-seam test — **"is there a second real implementation today, or a committed near-term need?"** — is the gate. RFC 0004 does not relax it; it *operationalizes* it.

The correct model, from *Building Evolutionary Architectures* (Ford, Parsons, Kua, 2017; full citation in [0004-07 §evolutionary-architecture](0004-07-prior-art-and-references.md)), is that an architecture is future-proof when two conditions hold:

1. **The expected axes of change are add-only.** A new engine, a new transport, a new tool, a new capability class — each is a *new file at a known extension point*, never an edit that ripples through the core. This is OCP made physical, and it is precisely what RFC 0004's registries (the `EngineRegistry` of [D1](../0004-architecture-hardening.md#d1), the metadata-at-registration of [D2](../0004-architecture-hardening.md#d2), the `TransportFactory`/analyser/mode registries of [D6](../0004-architecture-hardening.md#d6)) deliver.
2. **A fitness function guards every characteristic you care about** — so the architecture can *move* (be refactored, extended, re-laid-out) with mechanical proof that the characteristic it must preserve still holds. Evolution without fitness functions is drift; that drift is exactly the 80 findings of [0004-01](0004-01-current-state-audit.md). Evolution *with* them is what lets browxai grow at agent velocity without re-accruing the debt this RFC pays down.

The two conditions are inseparable. Add-only seams without fitness functions decay (the seam erodes the first time an agent takes a hardcoded shortcut and the gate stays green — the literal history of the triplicated `if (engine === …)` chains at `src/session/managed.ts:109-128`, `src/session/incognito.ts:89-112`, `src/session/byob.ts:154-196`). Fitness functions without add-only seams just *document* the pain of each extension without removing it. RFC 0004 lands both, and this reference shows that pairing carrying the future.

**The proven-seam test still gates every future below.** For each anticipated pressure, the question is not "could we build the abstraction now?" but "is the second implementation *real or committed*?" Where it is (a sixth engine on the RFC 0002 roadmap, a fourth transport, a third canvas adapter), the seam is built and the future is add-only *today*. Where it is not (a raw-BiDi client, multi-tenancy), [§8](#8-what-we-deliberately-do-not-build-yet) keeps the concrete code and defers the seam — on purpose, with a trigger condition written down.

A note on terminology used throughout: an **EngineEntry** is the per-engine record the [D1](../0004-architecture-hardening.md#d1) `EngineRegistry` keys on (`{ kind, capabilities, makeAdapter, makeSubstrates, postWire }`, specified in full in [0004-03](0004-03-ocp-registry-patterns.md)); the **engine-adapter-contract keystone** is the [L1](../0004-architecture-hardening.md#4-the-standard-in-ten-laws) fitness function that instantiates a synthetic sixth engine and asserts it works with **zero core edits**. Both are the load-bearing machinery of this reference.

---

## 2. Extension pressure: more engines

**What lands.** The RFC 0002 roadmap is explicit and already half-realized. Five engines are wired today — `chromium`, `firefox`, `webkit`, `android`, `safari` (`EngineKind`, `src/engine/types.ts:25`; `IMPLEMENTED_ENGINES`, `src/engine/select.ts:31-37`). The committed and credible-next engines, from [RFC 0002 §Phasing](../0002-multi-engine-bidi.md) and its open inputs:

| Future engine | Source / status | Launch shape | `deep`? | New substrate? |
|---|---|---|---|---|
| **stock-Firefox BiDi** (`moz-firefox`) | RFC 0002 P3 (remaining), D2 — behind `BROWX_FIREFOX_CHANNEL` today | BiDi over the `moz-firefox` channel | `false` | reuses the page-side walker (`PlaywrightSnapshotSubstrate`) + Playwright-event network substrate |
| **real-Safari hybrid** (Classic + experimental BiDi) | RFC 0002 P4, D7 — adapter `src/engine/adapters/safaridriver-hybrid.ts` exists | safaridriver, non-BYOB isolated windows | `false` | Safari-native, no Playwright `Page` — the no-Page seam ([D5](../0004-architecture-hardening.md#d5)) |
| **raw-BiDi attach** adapter | RFC 0002 D1 — *deferred until BYOB-Firefox is committed* | a BiDi `connectOverBiDi` socket | `false` | a new BiDi snapshot/network substrate pair |
| **Appium-bridged mobile contexts** | RFC 0002 D8 — native/hybrid app contexts, *product call* | Appium server → per-platform driver | `false` | a new context substrate |
| **WebDriver-classic engines** | beyond the roadmap — any classic-only driver | WebDriver Classic | `false` | a classic substrate |

**How the hardened seam absorbs it add-only.** Today, RFC 0002's own headline claim — *"a new engine = a new adapter"* ([architecture-principles §4](../../ai-context/architecture/architecture-principles.md)) — is **false at the wiring level**, which is the central finding of [0004-01](0004-01-current-state-audit.md). The engine-adapters audit ([0004-01], engine-adapters subsystem) costed a sixth engine at **5–6 file edits plus 17 inline guards**:

> *Add a 6th engine: edit `src/session/managed.ts` (add if-else branch for launch), `src/session/incognito.ts`, `src/session/byob.ts`, `src/tools/session-registry.ts` (add 17 guards for post-creation bookkeeping if non-Playwright), `src/engine/select.ts`, `src/engine/capabilities.ts`. Verdict: poor.*

After [D1](../0004-architecture-hardening.md#d1), the sixth engine is **one new file plus one registration line**. The triplicated factory chains, the 17 scattered Safari guards in `session-registry`, and the five `*For(e)` substrate selectors collapse into a single `EngineRegistry`; the factories, selectors, and `postWire` become data-driven lookups keyed by `session.engine`. The `EngineEntry` is the whole contract a new engine satisfies:

```ts
// What a sixth engine costs after D1 — one new file + one registration line.
// The BIDI_FIREFOX_* / bidi-* symbols below are this engine's OWN new artifacts
// (its adapter, capability row, and substrates) — illustrative names a real
// BiDi-Firefox engine would introduce, not existing src/ today. The one type-level
// touch is the `kind` member on the EngineKind union (types.ts:25): the type-level
// half of the single sanctioned engine-name declaration (0004-02 §3 L1), not a
// scattered `if (engine === …)` — which is what L1 actually forbids.
// src/engine/registry/bidi-firefox.ts
import type { EngineEntry } from "./engine-registry.js";
import { BIDI_FIREFOX_CAPABILITIES } from "../capabilities.js";
import { connectBidiFirefox } from "../adapters/bidi-firefox.js";
import { bidiSnapshotSubstrate, bidiNetworkSubstrate } from "../../page/bidi-substrates.js";
import { playwrightDeepFalseSubstrates } from "../../page/substrate-bundles.js";

export const bidiFirefox: EngineEntry = {
  kind: "bidi-firefox", // one new member on the EngineKind union (types.ts:25)
  capabilities: BIDI_FIREFOX_CAPABILITIES, // declares subInterfaces + deep:false ONCE
  makeAdapter: (opts) => connectBidiFirefox(opts), // Promise<BrowserSession>, mirrors buildSafariSession
  makeSubstrates: () => ({
    // The full 7-field SubstrateBundle (0004-03 §1): the cross-engine deep:false
    // substrates (page-side walker + Playwright-event) for actions/capture/storage/
    // script/emulation, overridden with the BiDi-specific snapshot/network.
    ...playwrightDeepFalseSubstrates("bidi-firefox"),
    snapshot: (e) => bidiSnapshotSubstrate(e),
    network: (e) => bidiNetworkSubstrate(e),
  }),
  // The 17 Safari guards become per-definition postWire — bookkeeping the engine
  // needs (or skips) is declared by the engine, not branched on by the registry.
  postWire: (entry) => { /* attach console/HAR/video iff the engine has a Page */ },
};
// src/engine/registry/index.ts — the one registration line:
registerEngine(bidiFirefox);
```

Post-[D1](../0004-architecture-hardening.md#d1), every engine-specific surface that the audit flagged keys on a **capability**, not an engine name — so a sixth engine needs *zero* edits to the gate and the selectors. The one residual that [D1](../0004-architecture-hardening.md#d1) closes is named explicitly below: the two `*-substrate-select.ts` files still branch on `engine === "safari"` *today* (`snapshot-substrate-select.ts:44`, `network-substrate-select.ts:44`), and D1 folds that branch into `EngineEntry.makeSubstrates`. With that fold done:

- The **tool gate** refuses CDP-deep tools on `deep: false` engines, never on an engine literal. RFC 0002 P2c proved this: WebKit landed and `DEEP_TOOLS` (`src/engine/tool-gate.ts:38-88`) was **not edited** — the gate keys on `capabilities.deep`, so a new `deep: false` engine auto-gates the 31 CDP-deep tools. ([D2](../0004-architecture-hardening.md#d2) finishes the job by moving the `DEEP_TOOLS` set itself from a hand-list to a derived map — see [§5](#5-extension-pressure-new-capability-classes).)
- The **substrate selectors** route by CDP presence (`snapshotSubstrateFor` / `networkSubstrateFor`), so a `deep: true` engine (Android proved this) reuses `CdpSnapshotSubstrate`/`CdpNetworkSubstrate` verbatim and a `deep: false` engine reuses the page-side walker + Playwright-event substrate — both with no selector edit once the two `engine === "safari"` branches at `src/page/snapshot-substrate-select.ts:44` and `src/page/network-substrate-select.ts:44` fold into the `EngineEntry.makeSubstrates` (the five `host-build.ts` substrate selectors already key on the `safari?.()` capability probe, not an engine literal — they need no fold).
- The **no-Page seam** ([D5](../0004-architecture-hardening.md#d5)) makes `page()` a *declared capability* (`session.page` present only when the engine has one), so the real-Safari adapter — which has no Playwright `Page` (`src/engine/adapters/safaridriver-hybrid.ts`'s `SafariSessionHandle` exposes *no* `page()` at all; the LSP violation is the `page()` on `BrowserSession`, documented as throwing at `src/session/types.ts:95` and actually throwing at `src/session/safari-session.ts:35`) — slots in without leaking 17 defensive guards. The raw-BiDi and Appium adapters inherit this for free: they too declare which sub-interfaces they have via `EngineCapabilities` (`src/engine/capabilities.ts`), and callers narrow rather than branch.

The reason a sixth engine needs no gate edit is that *capability declaration* already carries the whole works-vs-gated story as data. The five live engines declare their surface in `src/engine/capabilities.ts`, and the keystone asserts the gate honors it — a matrix the sixth engine extends by adding one row, never by editing a consumer:

| Engine | `subInterfaces` | `deep` | CDP-deep tools (perf/heap/coverage/clock/extensions) | network tools | emulation tools | Evidence |
|---|---|---|---|---|---|---|
| `chromium` | all 9 | `true` | **work** | work | work | `CHROMIUM_CAPABILITIES`, `src/engine/capabilities.ts:36-40` |
| `firefox` | all 9 | `false` | **gated** (hint) | work (Playwright-event) | work | `FIREFOX_CAPABILITIES`, `:49-53` |
| `webkit` | all 9 | `false` | **gated** (auto, zero gate edit) | work | work | `WEBKIT_CAPABILITIES`, `:64-68` |
| `android` | all 9 | `true` | **work** (full CDP) | work | work | `ANDROID_CAPABILITIES`, `:83-87` |
| `safari` | 7 (no network, no emulation) | `false` | **gated** | **refused** (no tap at all) | **refused** | `SAFARI_CAPABILITIES`, `:100-112` |

The asymmetry in the last row is the proof that the seam is capability-driven, not engine-name-driven: Safari *refuses* network/emulation (the sub-interface is absent from its `subInterfaces` set) where Firefox/WebKit *serve* them — and no consumer branches on `engine === "safari"` to make that happen; the gate reads `capabilities.subInterfaces` and `capabilities.deep`. A sixth engine declares its row and the matrix — and every tool's availability on it — follows.

**The fitness function that keeps it honest.** The **engine-adapter-contract keystone** ([L1](../0004-architecture-hardening.md#4-the-standard-in-ten-laws), spec in [0004-05](0004-05-fitness-functions-and-guardrails.md)) registers a synthetic engine through the real `registerEngine` path and asserts the full session lifecycle, substrate selection, and gate behavior work **with no edit to any file above the engine seam.** It is the executable form of architecture-principles §4. Two companions back it:

- `no-engine-literal-branches` (the [L1](../0004-architecture-hardening.md#4-the-standard-in-ten-laws) lint rule, [0004-05]) fails any `if (session.engine === "…")` / `=== 'safari'` outside the registry — directly closing guardrail-gap #0 from the harness-and-docs audit (*"No ESLint rule prevents engine literal dispatch inside handlers"*).
- The **engine↔capability↔keystone traceability test** ([L9](../0004-architecture-hardening.md#4-the-standard-in-ten-laws), [0004-05]) asserts every `EngineKind` member has a `capabilitiesFor` declaration and a keystone lane — closing guardrail-gap #2 (*"No unit test validates that all engines in EngineKind have a corresponding CAPABILITIES entry"*) and gap #9 (the per-engine works-vs-gated matrix). A seventh engine added without its capability row or its keystone lane is a red test, in the same change.

The net: the engine axis — the single highest-volume axis of future change for a *multi-engine* browser-control server — becomes the cheapest. The roadmap's stock-Firefox, real-Safari, raw-BiDi, and Appium adapters are each, post-[D1](../0004-architecture-hardening.md#d1), one `EngineEntry` and one keystone lane.

---

## 3. Extension pressure: plugin-ecosystem growth

**What lands.** More canvas-app adapters (the `canvas_query({adapter, op, args})` substrate already names tldraw/excalidraw as real adapters — [architecture-principles §1](../../ai-context/architecture/architecture-principles.md)), more first-party plugins, and third-party plugins shipped as external packages. The plugin runtime is already a *proven* seam: the workspace plugins (`example`, `figma`, `tldraw`, `excalidraw`) are real second-and-beyond implementations of `register(api)`.

**How the hardened seam absorbs it add-only.** A plugin extends the surface through the dependency-inverted `PluginApi` port (`src/plugin/types.ts:27`) and never reaches into browxai internals — `registerTool(name, def, handler)` (`src/plugin/types.ts:49-53`) and `callTool` (`:64`) are the whole contract. The hardening adds two things that make a plugin *auto-participate* in the cross-cutting machinery instead of being a second-class citizen:

- **Metadata-at-registration ([D2](../0004-architecture-hardening.md#d2)) unifies core and plugin tools.** Today a core tool must be hand-added to up to five disjoint central lists (`TOOL_CAPABILITY`, `BATCH_ALLOWED_TOOLS`, `DEEP_TOOLS`, the SDK types, the docs) and every miss is silent. After [D2](../0004-architecture-hardening.md#d2), a tool *declares* `{ capability, batchable, deep }` at registration and the central maps are *derived*. A plugin's `registerTool` carries the same metadata shape, so a plugin tool participates in capability gating, batch eligibility, and the derived type surface **the moment it registers** — no edit to any central list, for core or plugin tools alike. The `PluginApi.registerTool` `def` already mirrors the host's `inputSchema` shape (`src/plugin/types.ts:51`); [D2](../0004-architecture-hardening.md#d2) extends that shape with the same metadata fields `ToolHost.register` (`src/tools/host.ts:60-64`) gains.
- **Capability gating already fires on plugin calls.** `PluginApi.callTool`'s contract is explicit: *"Capability gates fire as if the call came in from MCP — a plugin cannot call a tool whose capability isn't enabled on the host"* (`src/plugin/types.ts:60-63`). The hardening's [L6](../0004-architecture-hardening.md#4-the-standard-in-ten-laws) (validate at the edge) makes the plugin boundary a *first-class* validation edge alongside the MCP wire and the config parser — a plugin's untyped `args` (`PluginToolHandler = (args: unknown)`, `src/plugin/types.ts:20`) is narrowed once at the boundary and trusted within.

The colocation is what makes a third-party plugin a *first-class* participant rather than a special case. A plugin that declares its metadata at registration is gated, batchable, and typed by the same derivation that governs core tools:

```ts
// A third-party plugin tool after D2 — metadata-at-registration; the host derives
// the gates. No central list edited; the plugin auto-participates.
import { z } from "zod"; // PluginApi exposes no `.z`; a plugin imports zod itself

export function register(api: PluginApi): void {
  api.registerTool(
    "acme.export_invoice",
    {
      description: "Export the focused invoice as a signed PDF.",
      inputSchema: { invoiceId: z.string() },
      capability: "file-io", // ← declared once; the DERIVED TOOL_CAPABILITY map picks it up
      batchable: true, //        ← derived BATCH_ALLOWED_TOOLS picks it up
      deep: false, //            ← gated on no engine it does not need CDP for
    },
    async (args) => { /* args is narrowed at the boundary; trusted within */ },
  );
}
```

The plugin author writes the declaration the host already requires of its own tools; the completeness fitness test (below) then *forces* the declaration, because an undeclared world-touching plugin tool is a red test the same as an undeclared core one. The old failure mode — a plugin tool silently defaulting to the `human` capability because no one remembered the central-list edit — becomes impossible, because there is no central list to forget.

**The fitness function that keeps it honest.** The **plugin-tool completeness test** ([L2](../0004-architecture-hardening.md#4-the-standard-in-ten-laws)/[L9](../0004-architecture-hardening.md#4-the-standard-in-ten-laws), [0004-05]) asserts that every registered tool — core *or* plugin — appears in the derived capability map and (if `batchable`) the derived batch allow-set, so a plugin cannot register a world-touching tool that escapes the gate. This is the same completeness invariant that closes harness-gap #6 (*"No test validates tool-capability mapping completeness"*), generalized to the plugin surface. A new canvas adapter behind `canvas_query`'s inner-`op` dispatch is governed identically — it is a substrate seam with real adapters, the exact exception architecture-principles §1 carves out, and its `op` registry gets the same derived-map completeness check.

---

## 4. Extension pressure: new transports

**What lands.** Remote and networked transports beyond today's three — a WebSocket transport, an HTTP transport, a remote-daemon attach (the remotxai-style daemon model). Three transports already conform to the `SdkTransport` port (`src/sdk/transport.ts:22-27`): `InProcessTransport`, `StdioChildTransport`, `SocketTransport`. The `Transport` abstraction is the doctrine's canonical *proven* seam ([architecture-principles §1](../../ai-context/architecture/architecture-principles.md): *"browxai's `Transport` abstraction is proven: three transports conform to it today"*).

**How the hardened seam absorbs it add-only.** The port is already right — the defect [D6](../0004-architecture-hardening.md#d6) names is the **selection `switch`** at `src/sdk/index.ts:206-231`, which hand-branches `case "in-process"` / `case "stdio-child"` / `case "socket"` and ends in a `default: throw new Error("unknown transport")`. A fourth transport edits that switch — an OCP violation with multiple real cases today, the textbook proven-seam-but-closed-dispatch shape. [D6](../0004-architecture-hardening.md#d6) replaces it with a `TransportFactory` registry — a `Map<TransportMode, (opts) => Promise<SdkTransport>>` registered add-only:

```ts
// After D6 — the transport switch becomes a registry; a 4th transport is one line.
const TRANSPORT_FACTORIES: ReadonlyMap<TransportMode, TransportFactory> = new Map([
  ["in-process", (o) => openInProcessTransport({ attachCdp: o.attachCdp, headless: o.headless })],
  ["stdio-child", (o) => openStdioChildTransport({ command: o.command, args: o.args, env: o.env })],
  ["socket", (o) => requireEndpoint(o, openSocketTransport)],
  ["websocket", (o) => openWebSocketTransport({ url: requireUrl(o) })], // ← the add-only future
]);
const make = TRANSPORT_FACTORIES.get(mode);
if (!make) throw new UnknownTransportError(mode, [...TRANSPORT_FACTORIES.keys()]);
const transport = await make(opts);
```

The new transport implements the one-method `SdkTransport` contract (`dispatch` + idempotent `close`) and registers; nothing in `client.ts` (which already depends on `SdkTransport`, never a concrete transport — `src/sdk/client.ts:7,15`) changes. The **SDK type-gen** ([D7](../0004-architecture-hardening.md#d7)) covers the new transport's option surface the same way it covers tool types: generated from the registration, never hand-mirrored, so the `sdk/tool-types.ts` drift the audit flagged cannot reappear on the transport axis either.

**The fitness function that keeps it honest.** The same **no-unhandled-default registry pattern** [L1](../0004-architecture-hardening.md#4-the-standard-in-ten-laws) enforces for engines applies: the `TransportFactory` map *is* the source of truth, the `UnknownTransportError` lists the live keys (the [select.ts](../../../src/engine/select.ts) `UnknownEngineError` pattern at `src/engine/select.ts:78-87` generalized), and the **dependency-cruiser layering rule** ([D10](../0004-architecture-hardening.md#d10), closing harness-gap #4) forbids `sdk/*` from importing handler internals — so a remote transport cannot smuggle a core dependency inward. A fourth transport that fails to register, or that reaches around the port, is a red graph check.

---

## 5. Extension pressure: new capability classes

**What lands.** A genuinely new *world-touching posture* — not a new tool inside an existing capability, but a new capability class. The most credible candidate is a **vision/OCR capability** *if and only if* the BYO-vision line ever moves: today browxai is BYO-vision by design ([architecture-principles §1](../../ai-context/architecture/architecture-principles.md): *"browxai is BYO-vision by design. It does not bundle OCR or a hosted vision API … understanding the pixels is the host agent's multimodal call"*). Other candidates: new device classes (beyond the `emulate_{bluetooth,usb,hid}` family), a clipboard-write-broadening posture, a new file-io class. Each is, by definition, posture-broadening.

Each candidate maps cleanly to the existing gated-capability shape — the seam is the gate, not a new subsystem:

| Candidate capability class | Posture it broadens | Add-only landing | Engine-dimension interaction |
|---|---|---|---|
| **vision / OCR** (only if BYO-vision moves) | reading pixels as text | one gated tool declaring `capability: "vision"` + a keystone denial lane | declares `deep` only if it reaches CDP screenshot internals; else engine-blind |
| **new device class** (beyond bluetooth/usb/hid) | emulating a hardware device | one gated tool declaring the device capability | composes with `subInterfaces` — refused on engines lacking the emulation surface |
| **clipboard-write broadening** | writing the OS clipboard | a new gated capability above the session-local clipboard buffer | engine-agnostic (page-side) — no `deep` |
| **new file-io class** (e.g. directory export) | touching more of the filesystem | one gated tool declaring `capability: "file-io"` (or a finer class) | engine-agnostic |

**How the hardened seam absorbs it add-only.** [architecture-principles §4](../../ai-context/architecture/architecture-principles.md) already prescribes the shape: *"New capability = a new gated interface. Anything posture-broadening … lands off-by-default behind a declared capability, with a per-tool keystone test asserting the gate blocks when not granted — in the same diff that adds it."* The hardening makes that prescription *mechanical* rather than a review checkbox. Under [D2](../0004-architecture-hardening.md#d2), a new capability class is a new value in the capability metadata model, declared once at the registering tool; the `TOOL_CAPABILITY` map (181 entries today, `src/util/capabilities.ts`) is *derived* from the declarations, not hand-edited — so a new capability class cannot be added *silently* (the audit's failure mode: an unmapped tool defaulting to `human`). The new class composes with the engine dimension automatically: a vision tool that needs CDP screenshot internals would declare `deep`, and the [tool-gate](../../../src/engine/tool-gate.ts) refuses it on `deep: false` engines with the existing structured-refusal-with-hint pattern — zero gate edits.

**The fitness function that keeps it honest.** This is the purest expression of the **keystone-denial traceability law ([L9](../0004-architecture-hardening.md#4-the-standard-in-ten-laws))**: *every world-touching tool ⇒ a capability declaration ⇒ a keystone denial test, in the same change.* The traceability fitness test ([0004-05]) walks the registered tools, and any tool that touches the world without a capability declaration *and* a keystone denial lane is a red test — not a missed review comment. So a new capability class is **add-only-with-a-test by construction**: the test that would fail is the forcing function that makes the denial lane part of the same diff. This closes the gap [0004-01]'s harness audit named (gap #5, *"No ESLint rule flags capability gate bypass inside handlers"*) and is verified by the existing keystone discipline ([architecture-principles §4](../../ai-context/architecture/architecture-principles.md), [`capability-posture-map.md`](../../ai-context/architecture/capability-posture-map.md)).

The discipline note: the seam here is the *capability-gate seam*, which is already proven (dozens of capability classes, dozens of gated tools). We do **not** build a vision *adapter* or bundle OCR speculatively — that would violate the BYO-vision boundary and the proven-seam test. We build only the gate slot, and only when a real vision tool lands. See [§8](#8-what-we-deliberately-do-not-build-yet).

---

## 6. Extension pressure: scale, concurrency, and multi-tenancy

**What lands.** Higher concurrent-session counts, bounded fan-out across sessions, and — further out — a daemon model serving multiple clients (the remotxai-style daemon, RFC 0002 open input #7: *"BiDi session model — one-session-per-browser vs browxai's concurrent-session registry"*; and the distributed/remote-session question). browxai is **already concurrent at the session granularity**: the `SessionRegistry` holds one isolated `SessionEntry` per session id (`src/session/registry.ts:48`, *"Per-session state. Everything here was a server-singleton pre-multi-session; one of these exists per live session id"*), and `cross_session_sample` already reads across sessions.

**How the hardened seam absorbs it.** Two laws scale the runtime:

- **The bounded-resource law ([L7](../0004-architecture-hardening.md#4-the-standard-in-ten-laws): "bounded everything").** Every loop, buffer, ring, recursion, and wait has an explicit, tested bound — the same discipline already in the codebase (`canvas_capture` capped at 16384×16384 px, `gesture_chain` `move` floored at 5 ms / `wait` clamped at 5000 ms, the bounded-window `watch` poll, the session-wide network/WS rings on `SessionEntry`, `src/session/registry.ts:76-78`). Scaling to N sessions multiplies *bounded* per-session state, never unbounded fan-out — the doctrine's *"Where concurrency exists, it is bounded with backpressure (deadlines, step caps, poll windows), never unbounded fan-out"* ([architecture-principles §4](../../ai-context/architecture/architecture-principles.md)). The hardening makes this a **fitness function** rather than a convention: the bounded-resource lint rule ([0004-05]) + budget tests on the rings, deadlines, and depth caps fail any new unbounded slurp or fan-out. Multi-tenancy that tried to share an unbounded buffer across tenants is a red test.
- **The determinism law ([L10](../0004-architecture-hardening.md#4-the-standard-in-ten-laws): "deterministic & observable").** The replay/recorder path and the diagnostics recorder are keystone-verified, not asserted ([architecture-principles §3](../../ai-context/architecture/architecture-principles.md)). Scaling preserves determinism *per session* because the `SessionEntry` is the isolation boundary — the seeded-random override, the virtual clock, the per-session refs are all session-local (`src/session/registry.ts`). A daemon serving multiple clients inherits this: each client's sessions are independently deterministic and observable.

**The open question, kept open.** Distributed/remote sessions — a session whose browser lives on a different host than the server — is **not** a proven seam today: there is one session-locality model (in-process registry) and no second real implementation. The `SocketTransport` already attaches to an *already-running* server over a Unix socket (`src/sdk/transport.ts:14-17`), which is the nearest existing precedent, but cross-host session migration is speculative. Per the proven-seam test, we keep the concrete concurrent-session registry and **defer the distributed seam** until a second real deployment shape (a daemon serving remote clients) is committed — see [§8](#8-what-we-deliberately-do-not-build-yet). The bounded-resource and determinism laws are the *fitness functions that will let that seam land safely when it is real*: a distributed session model that breaks per-session determinism or introduces unbounded cross-host fan-out is caught by the existing gates.

---

## 7. Extension pressure: new content/result types, harness adapters, config layers

**What lands.** New MCP content/result types (beyond `TextItem` / `ImageItem`, `src/tools/host.ts:24-26`); new harness adapters (the remotxai-style `adapter-contract` model — a Claude-Code/Codex/Pi harness building against one schema source of truth, [architecture-principles §1](../../ai-context/architecture/architecture-principles.md)); new config layers (beyond the layered `ConfigStore` the host already exposes, `src/tools/host.ts:138-144`).

**How the hardened seam absorbs it add-only.** Each maps to a **registry or derived-map from [D2](../0004-architecture-hardening.md#d2)/[D6](../0004-architecture-hardening.md#d6)**:

- **Content/result types** — a new content item kind is a new variant in the `ToolResponse` union (`src/tools/host.ts:21-26`), and the [D7](../0004-architecture-hardening.md#d7) SDK type-gen emits the corresponding SDK type from the same source — no hand-mirroring, so the `sdk/tool-types.ts` drift (673 LOC hand-mirrored, [0004-01]) cannot recur on this axis. The `parseEnvelope` chokepoint (`src/sdk/transport.ts:30-45`) is the single place a new content type is decoded.
- **Harness adapters** — the remotxai pattern is the model: *"`packages/adapter-contract` is the single Zod-schema source of truth that every harness adapter … and the daemon build against"* ([architecture-principles §1](../../ai-context/architecture/architecture-principles.md)). A new harness adapter conforms to the contract; the derived-map discipline ([L2](../0004-architecture-hardening.md#4-the-standard-in-ten-laws)) means the contract is declared once and every adapter derives from it.
- **Config layers** — the `ConfigStore` is already a layered, re-resolvable store (`ResolvedConfig`, `src/tools/host.ts:138-144`). A new layer (a remote/policy layer, say) is a new entry in the precedence order, a registry of layers, not a new branch in every consumer. The [D6](../0004-architecture-hardening.md#d6) registry-over-switch ruling applies: layer precedence is data, not control flow.
- **Perf analysers** — the `perf_audit` analyser registry (`ANALYSERS`, `src/page/perf-audit.ts:88-97`) is the doctrine's *cited* OCP exemplar ([architecture-principles §2](../../ai-context/architecture/architecture-principles.md)). It is already a `Record<AuditCategory, AuditCategoryAnalyser>` with the comment *"future .x additions are a one-liner change"* (`src/page/perf-audit.ts:86-87`). A new analyser category is one map entry; [D6](../0004-architecture-hardening.md#d6) makes the *keying* fully data-driven so the exemplar is exemplary in implementation, not just intent.

**The fitness function that keeps it honest.** The **derived-map completeness tests** ([L2](../0004-architecture-hardening.md#4-the-standard-in-ten-laws), [0004-05]) cover each of these registries uniformly: every declared content type appears in the generated SDK types; every analyser category in `ANALYSERS` has a result shape; every config layer in the precedence registry resolves. A new entry that skips its derived counterpart is a red test. This is the single mechanism — declare-once, derive-everywhere, test-the-derivation — applied across every minor extension axis, which is why these are listed together: they share one hardened seam.

---

## 8. What we deliberately do NOT build yet

Future-proofing's failure mode is the *mirror image* of unenforced drift: speculative bloat — a port for every imagined future, each adding *"an indirection, a file, and a lie ('this is swappable') for no payoff"* ([architecture-principles §1](../../ai-context/architecture/architecture-principles.md)). The proven-seam test gates the future as strictly as it gates the present. The following are *deliberately deferred*, each with the trigger condition that flips it from speculative to proven:

| Deferred seam | Why not now | Trigger that makes it proven |
|---|---|---|
| **Raw-BiDi client** (reimplementing the Locator surface) | RFC 0002 D1 is explicit: *"Do not build a raw-BiDi client that reimplements the Locator surface — the audit is explicit that this is 'a second product, not an adaptation.'"* No second real implementation today. | A committed stock-Firefox-BiDi or BYOB-Firefox attach that *cannot* ride Playwright — then the `BidiFirefoxAdapter` lands as one `EngineEntry` ([§2](#2-extension-pressure-more-engines)). |
| **Multi-tenancy / cross-host distributed sessions** | One session-locality model today (in-process registry); no second deployment shape. Building tenant isolation now is the speculative port the doctrine forbids. | A second real tenant or a daemon serving remote clients ([§6](#6-extension-pressure-scale-concurrency-and-multi-tenancy)). The bounded-resource + determinism laws are already the fitness functions that will gate it safely. |
| **Vision/OCR adapter** | BYO-vision is a *boundary*, not a gap ([architecture-principles §1](../../ai-context/architecture/architecture-principles.md)). Bundling OCR speculatively imports a model dependency the core refuses. | A real first-party vision tool with a committed need — then it lands as a gated capability slot ([§5](#5-extension-pressure-new-capability-classes)), not a bundled provider. |
| **Appium native-app contexts** | RFC 0002 D8 / open input #5: native-app contexts are *"a product call the owner makes."* Mobile *browsers* are proven (Android via adb+CDP, landed); native contexts are not. | The owner's product call + a real native-context need. |
| **Per-sub-interface method bundles** on the engine port | `src/engine/types.ts:46-50` is explicit: the sub-interface *names* are the typed map, but *"splitting before the second adapter exists would be the speculative generality the doctrine forbids."* | A second non-Playwright adapter (real-Safari) that needs a genuinely different method bundle — the split lands with it, not before. |

The discipline is the same one that makes the *positive* futures cheap: build the seam **when the second implementation is real**, and not one commit before. The cost asymmetry the doctrine names is the justification — *"Extracting a port from working code is a cheap, safe refactor; deleting a speculative port that the codebase has grown around is not"* ([architecture-principles §1](../../ai-context/architecture/architecture-principles.md)). Every row above is a port we can extract cheaply the day its trigger fires, and a liability if we build it today.

---

## 9. The maintainability ratchet

A future-proof architecture must trend **strictly more maintainable over time**, never less. RFC 0004's budgets ([D11](../0004-architecture-hardening.md#d11): *"Budgets, not vibes"*) are sized from the *current healthy* modules — but the god-modules are paid down over the phases ([0004-04]), and as a split lands the budget that allowed the god-module **must tighten** to lock in the gain. This is the **maintainability ratchet**: a one-way mechanism that lets the budget step *down* (tighter) as debt is paid, and *physically forbids* it stepping back up.

**Worked example — the tool-module budget.** The god-modules today are `read-observe-tools.ts` (1965 LOC, 20 tools), `capture-report-tools.ts` (1514), `emulation-config-tools.ts` (1107), `deep-tools.ts` (1033) ([0004-01], [D3](../0004-architecture-hardening.md#d3)). The [L3](../0004-architecture-hardening.md#4-the-standard-in-ten-laws) tool-module budget lands at **450 LOC** in P0 as a *warn* — **below** all four god-modules (which blow through it by 2–4×), so it is non-blocking *only* because it is `warn`: it makes the debt visible without forcing the split before [D3](../0004-architecture-hardening.md#d3) is ready. After [D3](../0004-architecture-hardening.md#d3) splits them to one-family-per-module in P3, the healthy modules sit well under 350; the budget then **steps from 450 → 350** as `error`. The same step happens to `server.ts` (the composition root, 382 LOC today — already healthy, budgeted at a hard 400 ceiling) and to the function-length / complexity / interface-member budgets ([L3](../0004-architecture-hardening.md#4-the-standard-in-ten-laws)/[L4](../0004-architecture-hardening.md#4-the-standard-in-ten-laws)) as `ToolHost` (35 members, `src/tools/host.ts:54-189`) and `SessionEntry` (40 fields, `src/session/registry.ts:48`) are segregated into à-la-carte sub-ports.

**The ratchet is itself a fitness function.** The danger is that a future budget step is *loosened* — an agent under deadline bumps `max-lines` back to 450 to land a fat module. The ratchet test asserts the budget only moves one way:

```ts
// test/architecture/maintainability-ratchet.test.ts — the budget is monotone non-increasing.
import { readBudgets } from "./budget-config.js";
import { RATCHET_FLOOR } from "./ratchet-floor.js"; // committed, only ever lowered by RFC amendment

it("no budget regresses — the ratchet only tightens", () => {
  const live = readBudgets(); // the eslint max-lines / complexity / max-members config in force
  for (const [rule, limit] of Object.entries(live)) {
    expect(limit).toBeLessThanOrEqual(RATCHET_FLOOR[rule]); // raising a budget fails CI
  }
});
```

`RATCHET_FLOOR` is the committed high-water mark — the *loosest a budget has ever been allowed to be*. A change that raises a live budget above its floor is a red test; a change that *lowers* the floor (after a split lands) is the intended, reviewed tightening, gated — per the [L-meta rule](../0004-architecture-hardening.md#8-risks-and-mitigations) — to *"an RFC amendment with rationale, never an inline disable."* This is the same norm the just-landed `no-unsafe-*` enforcement established (the [L6](../0004-architecture-hardening.md#4-the-standard-in-ten-laws) rules are `error`, relaxed only by amendment). The ratchet generalizes it from a fixed bar to a *monotonically tightening* one.

The consequence is the architectural claim this RFC exists to make good on: **the codebase cannot decay on the budgeted axes, and it provably improves on them.** Every paid-down god-module is locked in by a tighter floor. Future agents inherit a strictly smaller maintainability envelope than the one before them — future-proofing not as a prediction, but as a one-way mechanism. This closes the harness audit's headline meta-gap (gap #3, *"No file-size budget or import-depth check prevents business logic creeping into src/server.ts"*) and converts it into a guarantee that strengthens over time.

---

## 10. Closing: the stance restated

browxai is future-proof not because RFC 0004 predicts its features, but because:

1. **The expected axes of change are add-only** — a sixth engine ([§2](#2-extension-pressure-more-engines)) is one `EngineEntry`; a third canvas plugin ([§3](#3-extension-pressure-plugin-ecosystem-growth)) is one `register(api)`; a fourth transport ([§4](#4-extension-pressure-new-transports)) is one `TransportFactory` entry; a new capability class ([§5](#5-extension-pressure-new-capability-classes)) is one gated declaration; a new content type or config layer ([§7](#7-extension-pressure-new-contentresult-types-harness-adapters-config-layers)) is one derived-map entry — each at a known extension point, none editing the core.
2. **A fitness function guards every one of those axes** — the engine-adapter-contract keystone, the traceability tests, the derived-map completeness tests, the bounded-resource and determinism gates, the dependency-cruiser layering — so the architecture *evolves safely*, with mechanical proof that each extension preserves the invariant it must.
3. **The proven-seam test gates the speculative futures out** ([§8](#8-what-we-deliberately-do-not-build-yet)) — no raw-BiDi client, no multi-tenancy, no vision adapter until the second implementation is real — so the architecture stays the *simplest design that honors the proven seams*, never the maximal one.
4. **The maintainability ratchet ([§9](#9-the-maintainability-ratchet)) makes the trend strictly one-way** — every paid-down god-module locks in a tighter budget, so the codebase grows more maintainable as it grows larger.

That is what "future-proof" means under this doctrine: not a guess about what lands, but a *guarantee about how it lands* — add-only, fitness-gated, and monotonically more maintainable. The seams the hardening closes are the seams the future walks through.

---

## Related

- [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) — the parent RFC: the thesis, the ten laws ([L1](../0004-architecture-hardening.md#4-the-standard-in-ten-laws)–[L10](../0004-architecture-hardening.md#4-the-standard-in-ten-laws)), and the twelve decisions ([D1](../0004-architecture-hardening.md#d1)–[D12](../0004-architecture-hardening.md#d12)) this reference's futures rest on.
- [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md) — the `EngineRegistry` / `EngineEntry`, metadata-at-registration, derived-map, and `TransportFactory` patterns each future above lands on.
- [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md) — the executable form of every fitness function cited here (engine-adapter-contract keystone, traceability tests, completeness tests, the bounded-resource and ratchet checks).
- [`0004-07-prior-art-and-references.md`](0004-07-prior-art-and-references.md) — *Building Evolutionary Architectures* and the fitness-function literature this stance imports.
- [`../0002-multi-engine-bidi.md`](../0002-multi-engine-bidi.md) — the engine roadmap (stock-Firefox P3, real-Safari P4, raw-BiDi/Appium beyond) that §2 absorbs add-only.
- [`../../ai-context/architecture/architecture-principles.md`](../../ai-context/architecture/architecture-principles.md) — the proven-seam test (§1) and the scalability-seam doctrine (§4) this reference extends, never restates.
