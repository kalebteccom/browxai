# RFC 0004 / Reference 01 — Current-state architecture audit

**Parent:** [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) — this document is its evidence base.
**Status:** Reference. Read-only audit of `/Users/rowin/Projects/Kalebtec/browxai` @ `main`. No code changed by this document.

This is the citation-heavy floor under RFC 0004's thesis: eight parallel adversarial subsystem reviews surfaced **80 concrete SOLID / spaghetti defects**, and every one of them was committed *through a green gate*. The defects are real, located to `file:line`, and they cluster into six cross-cutting themes that all trace to one meta-cause — the doctrine in [`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md) is **unenforced**. The flagship claim — *"a new engine is a new adapter behind the existing port"* (architecture-principles §4) — is **false today**: a sixth engine requires editing **5–8 existing files**. This document proves that with the source.

A note on numbers: the audit was an automated fan-out, so a handful of its `file:line` ranges and counts were approximate. Every high-severity citation in the tables below was **re-opened against the source and corrected**; corrections are flagged inline with *(audit said X; verified Y)* so a skeptical reader can trust the rest. The voice and structure mirror [`03-browxai-coupling-audit.md`](03-browxai-coupling-audit.md) §0.

---

## 0. Executive architecture summary

The eight subsystems, each in 2–3 sentences. **Health** is "does it ship and is the *internal* design sound," not "does it work for users" — every subsystem ships and passes the keystone suites today. The defect is maintainability under extension, not correctness.

- **tools-and-seam** (`src/tools/*`, `host-build.ts`, the registration seam) — **Poor.** The composition root and tool surface are where the doctrine and the code diverge most: four god-modules (`read-observe-tools.ts` at 1965 LOC, `capture-report-tools.ts` at 1514, `emulation-config-tools.ts` at 1107, `deep-tools.ts` at 1033) each bundle 15–21 unrelated tool families, and the central `BATCH_ALLOWED_TOOLS` set is a 71-entry hand-list. The seam is *correct* (capability substrates, `gateCheck`/`engineGate`) but its *wiring* — the five substrate selectors and the batch list — is copy-paste and hand-maintained.
- **engine-adapters** (`src/engine/**`, the five adapters) — **Strong at the port, acute OCP failure at the call sites.** The five adapter classes are well-isolated; their *instantiation and post-creation wiring* are not. Adapter selection is triplicated `if (engine === …)` across `managed.ts`/`incognito.ts`/`byob.ts`, and the deep-tool gate (`DEEP_TOOLS`) is a hand-maintained set with no metadata-driven declaration and no regression test.
- **page-core substrates** (`src/page/*-substrate*.ts`, the RFC 0003 ports + selectors) — **Sound pattern, degrades under extension.** The capability-port idea is right and mostly capability-driven, but two selectors hardcode `engine === "safari"` by name (contradicting their own doc comments), the `ActionSubstrate` interface is too fat for Safari (8 of 12 methods refuse at runtime), and `host-build.ts` repeats an identical 5-line substrate-selection closure five times.
- **page-features** (`network.ts`, `sample.ts`, `extract.ts`, `perf-audit.ts`, `element-export.ts`, `canvas.ts`, `verify.ts`, ~35 more) — **Significant duplication debt.** Copy-paste families dominate: `sample.ts` duplicates a 10-case metric switch across two samplers (self-admitted), `network.ts` reimplements its `foldInteresting` fold inline in three places, `extract.ts` has two near-duplicate tree-scanners, and the perf `ANALYSERS` registry is stringly-typed with a four-site edit fan-out per category.
- **session** (`src/session/*.ts` + `src/tools/session-registry.ts`) — **Architecturally fragmented.** The worst single concentration: five policy classes share an identical buffer+record pattern with zero extraction; the mode/engine factory is a string-literal `if-else` chain; Safari's `page()` throwing forces **17** scattered `engine !== "safari"` guards through a 620-line registry; and `SessionEntry` is a 40-field god object every tool depends on.
- **policy-util** (`src/util/capabilities.ts`, `config-store.ts`, `secrets.ts`, `credentials.ts`, `diagnostics.ts`) — **Fragile at OCP.** Three hand-maintained registries (`TOOL_CAPABILITY` at 181 entries, `ALL_CAPABILITIES`, `ALL_CONFIRM_HOOKS`) force a central edit per tool/capability; config-layer precedence is a hard-coded sequence of four `apply()` calls; and egress masking (URL-sanitiser + secrets) is composed at the caller's discretion at each sink rather than enforced at a chokepoint.
- **plugin-sdk** (`src/plugin/**`, `src/sdk/**`, `src/cli/**`) — **Moderate; switch-driven extension points.** The plugin runtime itself is well-engineered (cycle detection, capability gating), but CLI subcommand dispatch and SDK transport selection are `switch` statements, `sdk/tool-types.ts` (673 LOC) hand-mirrors the zod schemas it admits are the source of truth, and `plugin/cli.ts` (538 LOC) conflates five concerns.
- **harness-and-docs** (ESLint, tests, CI, agent skills, architecture docs) — **Strong micro-rules, the guardrail vacuum at the macro level.** This is the meta-finding. The harness has good micro-enforcers (`no-tracker-ids-in-comments`, `no-page-eval-stringified-arrow`, keystone discipline) but **zero** architectural fitness functions: no OCP regression test, no engine-literal lint rule, no dependency layering check, no file-size/complexity budget, no capability-completeness test. The OCP claims are documented but unverified, and the coupling-audit reference still cites `server.ts` at 12,889 lines (it is 382).

The throughline: **the subsystems whose *design* is praised (engine ports, capability substrates, capability gate) all fail at their *wiring* — and the wiring fails specifically because no machine watches it.**

### 0.1 The audit by the numbers

| Subsystem | Findings | Critical | High | Worst category | Health |
|---|---|---|---|---|---|
| tools-and-seam | 13 | 1 | 6 | god-modules (SRP) + `BATCH_ALLOWED_TOOLS` (OCP) | Poor |
| engine-adapters | 9 | 0 | 4 | adapter-dispatch (OCP) + Safari `page()` (LSP) | Strong port, poor wiring |
| page-core substrates | 8 | 0 | 2 | name-check selectors (OCP) + fat `ActionSubstrate` (ISP) | Sound pattern, poor extension |
| page-features | 10 | 2 | 3 | self-admitted duplication (`sample`/`network`) | Significant duplication debt |
| session | 10 | 1 | 3 | mode/engine factory (OCP) + 5× policy copy-paste | Fragmented — densest debt |
| policy-util | 10 | 0 | 2 | `TOOL_CAPABILITY` hand-list (OCP) | Fragile at OCP |
| plugin-sdk | 8 | 0 | 2 | CLI/transport switches + `tool-types.ts` (673 LOC) | Moderate |
| harness-and-docs | 12 | 2 | 5 | the guardrail vacuum (meta) | Strong micro, zero macro |
| **Total** | **80** | **6** | **27** | OCP dominates (≈ 30 findings) | — |

Two facts to carry forward. First, **OCP is the dominant category** — roughly 30 of the 80 findings are open-closed violations, and all six "critical" findings except the two self-admitted-duplication ones are OCP or its meta (T7). Second, **the praise and the blame land on the same subsystems**: engine-adapters and page-core are commended for their port design *and* cited for their wiring, which is the whole shape of the RFC — keep the ports, fix the wiring, enforce the result.

---

## 1. tools-and-seam

The composition root (`host-build.ts`, 760 LOC) and the four largest tool modules. The seam is correct; the surface is god-modules and hand-lists.

The headline structural fact here is that the four largest tool modules total **5619 LOC** — more than `src/server.ts`, `host-build.ts`, and the entire `src/engine/` adapter tree combined — and each is a *registration bucket*, not a cohesive unit. `read-observe-tools.ts` registers DOM reads, assertions, extraction, buffer reads, composition, and exports in one 1965-line `register*Tools` function; adding a new observation family forces editing the monolith rather than dropping a file. These modules are an artifact of RFC 0003's line-range decomposition (which split `server.ts` by *line offset*, not by domain) and were flagged "thematically loose" at the time — the audit confirms the looseness has hardened into SRP debt. Independently, the seam's *wiring* is the OCP problem: `BATCH_ALLOWED_TOOLS` is a 71-entry hand-list (every batchable tool is a manual entry, and a plugin tool can never self-declare batchability), and the five substrate selectors at `host-build.ts:288-357` are the same closure copy-pasted five times. The fix is two-pronged — split the buckets (D3) and derive the lists/fold the selectors (D2/D1) — and the two are independent, so they can land in different phases.

| Finding | Category | Severity | Evidence (file:line) | Fix |
|---|---|---|---|---|
| `read-observe-tools.ts` is a 1965-LOC god-module registering 20+ tools (snapshot, find, frames_list, text_search, extract, verify_*, screenshot, console_read, network_read, ws_read, inspect, point_probe, sample, watch, …) | SRP | high | `src/tools/read-observe-tools.ts` (1965 LOC, verified) | Split into ~6 cohesive modules (DOM-read, assertion, extraction, buffer-read, composition, export) |
| `capture-report-tools.ts` bundles ~21 concerns (screenshot, region, sampling, reporting, diagnostics, file-I/O, overflow) | SRP | high | `src/tools/capture-report-tools.ts` (1514 LOC, verified) | Split into ~6 modules by family |
| `emulation-config-tools.ts` bundles 8 unrelated families (device-emulation, live-emulation, config, approvals, secrets, captcha, credentials) | SRP | high | `src/tools/emulation-config-tools.ts` (1107 LOC, verified) | Split by domain into ~5 modules |
| `deep-tools.ts` bundles perf, coverage, layout-thrash, heap, clock, seed_random, compound tools by accident | SRP | high | `src/tools/deep-tools.ts` (1033 LOC, verified) | Split into ~4 modules |
| `forms-recording-tools.ts` bundles 9 independent tools (fill_form, plan, execute, recording, name_ref, find_feedback) | SRP | medium | `src/tools/forms-recording-tools.ts` (503 LOC, verified) | Split into ~5 modules |
| **`BATCH_ALLOWED_TOOLS` is a hand-maintained 71-entry Set** — every new batchable tool edits this list; plugins cannot self-register as batchable | OCP | **critical** | `src/tools/host-build.ts:640-712` (71 entries, verified — *audit said "72"; exact count is 71*) | Tag tools `{batchable:true}` at register; derive the set |
| **The five substrate selectors repeat an identical capability-detect-then-fallback closure** | OCP | high | `src/tools/host-build.ts:288-357` — `actionsFor`/`captureFor`/`storageFor`/`scriptFor`/`emulationFor`, each `const h = e.session.safari?.(); if (h) return new SafariXSubstrate(h); return new PlaywrightXSubstrate(...)` (verified verbatim) | Fold into the `EngineRegistry`; one factory builder |
| Adding a tool family forces edits to `server.ts` + `capabilities.ts` + `host-build.ts`; registration is not composable | OCP | high | cross-file (registration + `TOOL_CAPABILITY` + batch list) | Attach metadata at `host.register`; auto-populate the maps |
| `ToolHost` is a large host-object — handlers destructure 8–12 of its members; adding a helper updates the interface + every destructuring site | ISP | medium | `src/tools/host.ts:54-189` — `export interface ToolHost` (**35** members across register/gate/ctx/substrate/config/registry roles, verified; *audit said "75-member"; exact count is 35 — over-counted, still oversized*) | Segregate into composable sub-ports (`GateHost`, `SessionHost`, `ActionHost`, …) |
| Action tools repeat a 7-step handler pattern ~50× (resolve target → gate → act → envelope → mask → record → return) | duplication | medium | `click`/`fill`/`press`/`shortcut` handlers across `src/tools/*` | Extract an `actionTool()` wrapper |
| Error-handling is inconsistent — some handlers wrap, some omit try/catch | error-handling | medium | `src/tools/*` (mixed) | Wrap all handlers in a catch-all decorator |
| Substrate-selection closures are copy-pasted; only the class names differ | spaghetti | medium | `src/tools/host-build.ts:288-357` | Same as the OCP fold above |
| Module names obscure contents (`emulation-config` contains `register_secret`, `solve_captcha`) | naming | low | `src/tools/emulation-config-tools.ts` | Rename to actual domains after the SRP split |

**OCP extension scenarios — tools-and-seam:**

| Scenario | Files to edit today | Count | Verdict |
|---|---|---|---|
| Add a new browser engine | `engine/index.ts`, `engine/adapters/new.ts`, `tools/host-build.ts` (5 closures) | 3 (+ session factories) | **Poor.** With the registry: one adapter file. |
| Add a new observation tool | `tools/read-observe-tools.ts`, `util/capabilities.ts`, `tools/host-build.ts` | 3 | **Poor.** With metadata: the module only. |
| Add a new capability | `util/capabilities.ts`, `server.ts`, `tools/new.ts` | 3 | **Poor.** With metadata: types + register. |
| Extend batch support to a tool | `tools/host-build.ts` (`BATCH_ALLOWED_TOOLS`) | 1 | **Poor.** With metadata: register `{batchable:true}`. |

---

## 2. engine-adapters

Strong at the port layer (`EngineKind`, capability declarations, structured `engineGate` refusals); acute OCP failure at the caller sites in the session factories and the deep-tool gate.

This is the subsystem the parent RFC's thesis turns on. The five adapters (`PlaywrightChromiumAdapter`, `PlaywrightFirefoxAdapter`, `PlaywrightWebKitAdapter`, `AndroidCdpAdapter`, `SafaridriverHybridAdapter`) are textbook ports-and-adapters: each is a self-contained class behind a common shape, exactly as architecture-principles §4 prescribes. The failure is that nothing *consumes* them through a registry — the three session factories each re-derive "which adapter for this engine" by hand. `managed.ts` reads `opts.browserType ?? "chromium"` into `engine`, then runs `if (engine === "android")` (refuse), `if (engine === "safari")` (return a `buildSafariSession`), and finally a `firefox`/`webkit`/`else`-chromium chain that does `new PlaywrightFirefoxAdapter(...)`. `incognito.ts` and `byob.ts` repeat the same shape with mode-specific refusals. The adapter classes are add-only; their *call sites* are edit-heavy — and that gap is the literal proof that "a new engine is a new adapter" is false today. Compounding it, the `DEEP_TOOLS` gate is a hand-maintained Set with no tool-side metadata: a CDP-requiring tool that lands without being added to the set passes registration on Firefox and crashes mid-call rather than refusing at the gate. The RFC's `EngineRegistry` (D1) collapses the factory chains, the substrate selectors, and the deep-gate into one registration record per engine.

| Finding | Category | Severity | Evidence (file:line) | Fix |
|---|---|---|---|---|
| **Adapter instantiation is hardcoded `if (engine === …)` in three session factories** — no registry; the dispatch is inline in each caller | OCP | high | `src/session/managed.ts:26,35,109,112,120` (android/safari refusals, then `firefox`/`webkit`/`else`-chromium adapter `new`); `incognito.ts:25,33,89,95,103`; `byob.ts:154,162,178,181,195` (verified — *audit's "109-128" maps to the verified 109-120 Playwright branch*) | `getAdapterFor(engine): EngineAdapter` in `engine/adapters/factory.ts`; factories call it |
| **Session-registry carries 17 Safari-specific guards inline** for post-creation bookkeeping (console, HAR, video, bridge, dialog, permission, notification, fs-picker, downloads, stealth, device-emu, ws-interactive, workers, perf/coverage teardown) | OCP | high | `src/tools/session-registry.ts:266,280,292,301,332,338,349,383,408,441,451,457,479,536,550,584,589` (**17** `sess.engine !== "safari"` guards, verified by grep — *audit said "17+/18+"; exact count is 17*) | Two polymorphic initializers keyed on a `hasPlaywrightPage` capability; guards move into the registry's `postWire` |
| **`DEEP_TOOLS` is a hand-maintained Set with no tool-side metadata** — a new CDP-requiring tool that forgets to register runs on Firefox/WebKit and crashes mid-call instead of refusing at registration | OCP | medium | `src/engine/tool-gate.ts:38-88` (**31** tool names; verified — *audit said "26"; exact count is 31*) + `TOOL_REASON` at `:93-112` | Tools self-declare `deep:true` at register; the gate queries metadata |
| Snapshot/network substrate selectors hardcode `engine === "safari"` instead of capability queries | OCP | medium | `src/page/snapshot-substrate-select.ts:44`; `src/page/network-substrate-select.ts:44` (verified) | Route on a `hasPlaywrightPage()` capability; engine names vanish |
| **Safari `page()` throws unconditionally** — the LSP leak that necessitates the 17 guards | LSP | high | `src/session/safari-session.ts:34-36` (`page: () => { throw new Error(NO_PLAYWRIGHT_PAGE) }`, message at `:18-22`); the contract it breaks is `BrowserSession.page(): Page` in `src/session/types.ts` (verified) | Make `page` a declared capability (present only when the engine has one), or split `PlaywrightSession`/`SafariSession` |
| The 6th-engine call graph (adapter class → managed.ts → incognito.ts → byob.ts → session-registry.ts) touches 4–5 files even though the adapter class is add-only | OCP | high | the three factories above + `session-registry.ts` | The `EngineRegistry` collapses all of it to one registration |
| Incognito error handling inconsistent — Safari refuses inline at the factory, Android refuses inside the adapter | error-handling | medium | `src/session/incognito.ts:33-40` (Safari inline) vs `src/engine/adapters/android-cdp.ts` (Android in-adapter) | Move all engine-limitation refusals into the adapter |
| No automated test prevents `DEEP_TOOLS` _drift_ | spaghetti | medium | `src/engine/tool-gate.ts:38-88`; `tool-gate.test.ts:4-37` _does_ assert every **registered** deep tool refuses on Firefox/WebKit (and runs on Chromium/Android), but nothing asserts a **new** deep tool was added to the hand-list — a forgotten registration is absent from `DEEP_TOOLS`, so iterating the set cannot catch the omission | Tools self-declare `deep:true` at register so the set is _derived_, not hand-maintained — drift becomes impossible |
| Engine-selection error types (`EngineNotYetSupportedError` vs `UnknownEngineError`) require RFC knowledge to distinguish | naming | low | `src/engine/select.ts` | Unify to `UnsupportedEngineError` with a discriminating message |

**OCP extension scenarios — engine-adapters:**

| Scenario | Files to edit today | Count | Verdict |
|---|---|---|---|
| Add a 6th engine (Appium / BiDi-only) | `session/managed.ts`, `session/incognito.ts`, `session/byob.ts`, `tools/session-registry.ts` (+17 guards if non-Playwright), `engine/select.ts`, `engine/capabilities.ts` | 5–6 (+ inline guards) | **Poor.** Adapter class is add-only; integration scatters. |
| Add a CDP-requiring tool | `engine/tool-gate.ts` (`DEEP_TOOLS` + `TOOL_REASON`) | 1–2 | **Poor.** Tool makes no self-declaration; silent runtime risk off-Chromium. |
| Add a new sub-interface capability class | `engine/types.ts`, `engine/capabilities.ts` | 2 | **Good.** Capability declarations are data-driven (add-only at type level). |
| Add a new session mode | `session/byob.ts`, `session/registry.ts`, `tools/session-registry.ts` | 3 | **Poor.** Mode-unique engine logic multiplies the `if-else`. |

---

## 3. page-core substrates

The RFC 0003 capability ports and their selectors. The pattern is right; two selectors hardcode engine names, one interface is too fat for Safari, and the composition root copy-pastes five times.

The substrate layer is the cleanest illustration of "right idea, half-enforced." The selectors were *designed* to route on capability, not engine name — `snapshot-substrate-select.ts:38` even comments "Chromium / Android (CDP present) → the byte-identical CDP substrate" and routes the CDP branch on `session.cdp` (capability-driven, correct). But the Safari branch directly above it checks `session.engine === "safari"` by name (`:44`), which the file's own header comment promises it will not do ("not an engine-name check scattered through the tools"). The doc comment is aspirational; line 44 is the reality. The same split-personality appears in `network-substrate-select.ts:44`. Separately, `ActionSubstrate` is a 12-method interface that Safari can only honor for four (navigate/click/fill/press); the other eight refuse at runtime, which is an ISP violation that pushes error discovery from compile time to call time — and which duplicates the upstream `engineGate` check that *already* refuses unsupported tool/engine pairs. Splitting `ActionSubstrate` into role-specific sub-interfaces (Safari implements only `BaseActionSubstrate`) makes the unsupported methods a compile error, not a runtime refusal.

| Finding | Category | Severity | Evidence (file:line) | Fix |
|---|---|---|---|---|
| **Selectors hardcode `engine === "safari"`** — contradicting their own comment ("a future CDP-bearing engine routes automatically") | OCP | high | `src/page/snapshot-substrate-select.ts:44` (`if (session.engine === "safari" && session.safari)`); `src/page/network-substrate-select.ts:44` (`if (session.engine === "safari") return new SafariNoopNetworkSubstrate()`) (both verified; the CDP branch *is* capability-driven, the Safari branch is not) | Replace the name check with `if (!session.hasPlaywrightPage())` / `if (session.safari?.())` |
| **`ActionSubstrate` forces Safari to implement 8 methods it cannot support** — they refuse at runtime | ISP | high | `src/page/action-substrate.ts` (148 LOC; `ActionSubstrate` declares 12 methods; `SafariActionSubstrate` implements navigate/click/fill/press and refuses hover/select/scroll/goBack/goForward/chooseOption/setViewport/waitFor) | Split into `BaseActionSubstrate` + `Pointer`/`History`/`Wait` sub-interfaces; Safari implements only `Base` |
| **`host-build.ts` substrate factories are identical boilerplate ×5** | SRP | medium | `src/tools/host-build.ts:288-357` (the same `safari?.()` → SafariX else PlaywrightX closure, 5×; verified) | A generic `buildSubstrateFactory<T>(SafariImpl, PlaywrightImpl, …)` called once per substrate |
| `buildHost` imports 10+ concrete substrate classes instead of factory abstractions | DIP | medium | `src/tools/host-build.ts` import block (Playwright/Safari × action/capture/storage/script/emulation) | Each substrate module exports its own `buildX(session)` factory; `buildHost` imports 5 factories |
| Substrate files grow unbounded — interface + every engine impl co-located in one file | coupling | medium | `src/page/action-substrate.ts` (interface + Playwright + Safari in one file) | Reorganize into `substrates/{action,…}/{interface,playwright,safari,index}.ts` |
| Safari substrate refusals duplicate the upstream `engineGate` check at runtime | error-handling | medium | `src/page/action-substrate.ts` (refusals) vs `src/tools/host-build.ts:185` (`engineGate`) | Gate upstream; if the tool passes the gate, the substrate is guaranteed |
| `*-substrate-select.ts` files are named like implementations but contain selectors | naming | low | `src/page/snapshot-substrate-select.ts`, `network-substrate-select.ts` | Rename to `*-substrate-factory.ts` or consolidate to `substrate-builders.ts` |
| `SafariNoopNetworkSubstrate` is a placeholder masking a missing port (network is capability-gated off Safari, so it is never reached) | dead-code | low | `src/page/network-substrate-select.ts:44`, `:20` (import) | Make the network port optional (`undefined`) rather than a fake impl |

**OCP extension scenarios — page-core substrates:**

| Scenario | Files to edit today | Count | Verdict |
|---|---|---|---|
| Add a 6th engine (WebDriver W3C) | both selectors + 5 substrate files + `host-build.ts` | 8 | **Poor.** No add-only path; both selectors must change in lockstep. |
| Add a new capability port (e.g. streaming) | `streaming-substrate.ts` (new) + `host-build.ts` + `host.ts` | 2 existing (+1 new) | **Poor.** No registry auto-discovers a substrate; manual wiring. |
| Add a tool family needing engine-specific substrates | substrate (new) + `host-build.ts` + `host.ts` + tool module (new) | 2 existing (+2 new) | **Poor.** Composition root is the tight coupling point. |

---

## 4. page-features

The 35-plus feature modules. The debt here is duplication and stringly-typed registries, several of which the code itself admits in comments.

What distinguishes this subsystem is that its worst defects are *self-documented*: the developers knew about the duplication and wrote a comment justifying it rather than extracting it. `sample.ts:136-137` says the metric switch "is intentionally duplicated rather than shared via a closure (which wouldn't survive serialization)" — but the constraint (the function must serialize to run in-page) does not actually forbid a shared lookup table inlined as an expression; it only forbids a captured closure, so the duplication is avoidable and the justification is a rationalization. `element-export.ts` carries a comment explicitly anticipating divergence from `archive.ts` "so future tweaks can diverge per consumer" — with no mechanism to detect *accidental* divergence. `network.ts` defines `foldInteresting` and then reimplements its body inline in two other methods. These are the most dangerous kind of debt because the comment signals "this is fine" to the next reader. The two critical-severity findings (the `sample.ts` double switch and the `network.ts` triple fold) are both silent-failure risks: a developer adding a metric or a noise-type edits one site and the other path drifts, with no test catching it. The perf `ANALYSERS` registry is the OCP representative — eight categories, four edit sites per addition, fixable with a single `as const`.

| Finding | Category | Severity | Evidence (file:line) | Fix |
|---|---|---|---|---|
| **`sample.ts` duplicates a 10-case metric switch across two samplers** — the code self-admits the copy-paste | duplication | **critical** | `src/page/sample.ts:144-167` (`elementSampler.read()`) and the parallel `windowSampler.read()`; the admission is at `:136-137` ("metric/loop logic is intentionally duplicated … wouldn't survive serialization") — verified. `ELEMENT_METRICS` is the single authority but the dispatch appears twice. | A stateless `METRIC_READERS` lookup table inlined as an expression (serialization-safe) |
| **`network.ts` reimplements its fold logic in three places** — `foldInteresting` exists but isn't called at two of its sites | duplication | **critical** | `src/page/network.ts` — `foldInteresting` (~`:140`) vs the inline reimplementations in `NetworkTap.close` and `NetworkBuffer.recent`; the "sanitize at egress only" comment doesn't explain the divergence | Have both callers delegate to `foldInteresting` (or a pure `filter+fold` helper) |
| `extract.ts` has two near-duplicate tree-scanners with overlapping matchers | duplication | high | `src/page/extract.ts` — `scanTreeForCollection` (`hay.includes`) vs `scanTreeForBestMatch` (7-tier weighted score); both walk the tree and build matchers | Extract `treeSearch(tree, matcher)`; each scanner passes a different matcher |
| **Stringly-typed perf `ANALYSERS` registry violates OCP** — a category requires four edit sites | OCP | high | `src/page/perf-audit.ts:88-97` (the `ANALYSERS` record, **8** categories — render-blocking / unused-code / oversize-images / layout-thrashing / long-tasks / leak-suspects / cache-opportunities / font-loading; *audit said "9"; the verified count is 8*), plus the `AuditCategory` union at `:23-31` and `ALL_AUDIT_CATEGORIES` at `:33-42` | `const ANALYSERS = {…} as const`; derive the union + array via `keyof typeof` |
| `element-export.ts` and `archive.ts` both carry parallel resource-discovery logic (intentional, undefended divergence) | duplication | high | `src/page/element-export.ts` (`SUBTREE_DISCOVERY_FN`, 5000-element cap) vs `archive.ts::buildFetchScript`; the divergence-comment provides no consistency framework | A shared `discoverResources(root, mode)` walker + a consistency test |
| `canvas.ts` discovery heuristics are hard-wired to three built-ins with no plugin extension point | OCP | medium | `src/page/canvas.ts` (`PAGE_DISCOVER_TRANSFORM_FN` probes Figma/Tldraw/generic in order) | Layer discovery: built-ins, then a plugin `discover()` hook |
| `verify.ts` target-resolution is centralized in `resolveOrFail` (good), but a new `ActionTarget` variant still fans out to every `verify_*` | OCP | medium | `src/page/verify.ts` (`resolveOrFail` + verifyVisible/Text/Value/Count/Attribute) | Keep new variants in `resolveOrFail` only; document the pattern |
| Secrets masking is documented at the egress boundary but not architecturally enforced — `iter()` returns raw, unmasked entries | error-handling | medium | `src/page/network.ts` (`maskedUrl`/`maskedText`; `iter()` returns "raw, read-only snapshot") | Rename to `rawIter()`; add a masked variant; enforce at the tool boundary (see policy-util `EgressSanitiser`) |
| `enforceSummaryBudget` re-estimates tokens in nested loops — O(N²) risk with no hard bound | error-handling | medium | `src/page/perf-audit.ts` (`enforceSummaryBudget`, nested severity + while loops) | Pre-cost each issue linearly; greedy single pass |
| Error codes are hyphenated string literals scattered per-module with no central registry | naming | low | `src/page/canvas.ts`, `extract.ts` (inline `'no-canvas'`, `'invalid-schema'`, …) | A `page/error-codes.ts` const registry |

**OCP extension scenarios — page-features:**

| Scenario | Files to edit today | Count | Verdict |
|---|---|---|---|
| Add a 9th perf-audit category | `perf-audit.ts` (analyseFn + `ANALYSERS` + `AuditCategory` union + `ALL_AUDIT_CATEGORIES`) + test | 4 sites in 1 file | **Poor.** A single `as const` source would make it 1 edit. |
| Add a metric to the sampler | `sample.ts` (`ELEMENT_METRICS` + 2 switch sites) + test | 3 sites in 1 file | **Poor.** Forgetting the window-sampler case is a silent failure. |
| Add a canvas-app discovery shape | `canvas.ts` (transform-probe fn + `CanvasAdapterHint` union) + test | 2 | **Poor.** Every new editor needs a browxai release. |
| Fix a stylesheet-discovery bug | `element-export.ts` + `archive.ts` | 2 | **Poor.** Duplication means fixing one and forgetting the other. |

---

## 5. session

The session subsystem (`src/session/*.ts` + `src/tools/session-registry.ts`, 620 LOC). The single densest concentration of duplication and OCP failure in the codebase.

If any one subsystem is "the spaghetti the owner asked about," it is this one — it carries four of the six cross-cutting themes simultaneously (T1 engine dispatch, T4 copy-paste, T5 LSP leak, T6 switch dispatch). The five policy classes (`dialog`, `permission`, `notification`, `fs-picker`, `device-emu`) each maintain a private `buffer: XRecord[]` with a `cap`, a `record()` that pushes-and-shifts, a `since(ts)`, and a `raisedSince(ts)` — the same five-method shape, copy-pasted five times, so an off-by-one in the cap logic is a five-place fix and a sixth policy will copy it again. The mode/engine factory in `session-registry.ts` is a string-literal `if-else` over `attached`/`incognito`/persistent, and Safari's `page()`-throws contract forces the **17** scattered `engine !== "safari"` guards that make the 620-line registry nearly unreadable and that a new feature will forget (and then crash on Safari). And `SessionEntry` is the codebase's largest god-object — `registry.ts:48` opens an interface with 40 fields (every substrate, every buffer, every policy, plus lifecycle metadata) that every tool transitively depends on. The bright spot, worth citing because it proves the team *can* do this right, is the permission subsystem: adding a supported permission is two focused edits in one file (`SUPPORTED_PERMISSIONS` + the CDP-name map), because that surface is genuinely centralized. The RFC's job is to make the rest of the subsystem look like `permission.ts`.

| Finding | Category | Severity | Evidence (file:line) | Fix |
|---|---|---|---|---|
| **Five policy classes share an identical buffer+cap+record pattern with zero extraction** | duplication | high | `src/session/dialog.ts:62-93`, `permission.ts:134-183`, `notification.ts:113-148`, `fs-picker.ts:148-181`, `device-emu.ts:165-195` (each: `buffer:XRecord[]`, `cap`, `record`, `since`, `raisedSince`) | A generic `PolicyRecordBuffer<T extends {ts:number}>` each class composes |
| **Adding a session mode or engine edits `session-registry.ts` + `managed.ts` + `incognito.ts` + `byob.ts`** | OCP | **critical** | `src/tools/session-registry.ts:177-232` (mode `if-else`), `:575` (mode-specific `launchProfile`), the 17 Safari guards; `src/session/managed.ts:26-42` (engine dispatch) | A `SessionFactoryProvider` registry keyed on `(mode,engine)` |
| **Safari `page()` throws — the LSP contract violation that scatters 17 guards** | LSP | high | `BrowserSession.page(): Page` in `src/session/types.ts`; `src/session/safari-session.ts:34-36` (throws); the guards at `session-registry.ts:266,280,292,301,332,338,349,383,408,441,451,457,479,536,550,584,589` (verified) | Split `PlaywrightSession`/`SafariSession`; compile-time type-guards replace the runtime checks |
| **`SessionEntry` is a 40-field god object** every tool depends on | ISP | high | `src/session/registry.ts:48` (`SessionEntry` interface — session, refs, substrates, frames, console, network, ws, workers, bridge, recorder, …, har, video, secrets, downloads, artifacts, launchProfile; verified the interface opens at :48) | Core interface + capability-keyed sub-objects (`DialogSessionState`, …) |
| Mode dispatch uses string-literal `if-else` instead of a sealed map | OCP | medium | `src/tools/session-registry.ts:177,222,575` | `Map<SessionMode, ModuleFactory>` |
| Engine dispatch in `managed.ts` is an `if-else` chain over `EngineKind` literals (chromium is the implicit `else`) | OCP | medium | `src/session/managed.ts:26-42`, `incognito.ts:21-44`, `byob.ts:148-191` (verified) | An `EngineAdapterRegistry` |
| 17 scattered Safari guards make the registry unreadable and forget-prone | spaghetti | medium | `src/tools/session-registry.ts` (the 17 guard sites above) | A polymorphic `session.initialize()` per engine |
| Policy normalisers duplicated across dialog/permission/notification/fs-picker | duplication | medium | `dialog.ts:127-132`, `permission.ts:198-227`, `notification.ts:160-163`, `fs-picker.ts:234-269` | A generic `makePolicyNormaliser<T>(validModes, …)` |
| `SessionEntry.launchProfile` is set only in persistent mode (conditional-field smell) | ISP | low | `src/session/registry.ts:206`; `session-registry.ts:575` | A `PersistentSessionState` sub-object |
| No central error catalog for policy failure hints | duplication | low | `dialog.ts:52-56`, `permission.ts:115-119`, `notification.ts:102-106`, `fs-picker.ts:136-141` (per-module `UNHANDLED_*_HINT`) | A `session/policy-hints.ts` |

**OCP extension scenarios — session:**

| Scenario | Files to edit today | Count | Verdict |
|---|---|---|---|
| Add a session mode (e.g. ephemeral) | `session-registry.ts` (`if-else` + `launchProfile` cond.), `session/types.ts` (union) + mode-specific logic | 3+ | **Poor.** Audit 17 guards for mode-specific handling. |
| Add a 6th engine | `managed.ts`, `incognito.ts`, `byob.ts`, `engine/adapters/*` (new), `session-registry.ts` (+ guards) | 4–5 | **Poor.** |
| Add a new policy | `storage-policy.ts` (new, copy dialog.ts), `registry.ts` (field), `session-registry.ts` (allocate + guards) | 3+ | **Poor.** Plus the buffer copy-paste. |
| Remove Safari special-casing | `safari-session.ts`, `session-registry.ts` (review all 17 guards), `types.ts` | 17+ edits in registry alone | **Poor.** Guards are scattered, each reviewed individually. |
| Add a supported permission | `permission.ts` (`SUPPORTED_PERMISSIONS` + CDP map + init-script) | 2 in 1 file | **Good.** Permissions are well-centralized. |

---

## 6. policy-util

The capability registry, config layering, secrets/credentials, diagnostics. Fragile at OCP: three hand-maintained registries and a caller-discretion egress chokepoint.

The defining defect is `TOOL_CAPABILITY` (`capabilities.ts:87-524`): a 181-entry hand-maintained `Record<string, Capability>` that maps every tool name to its required capability. It is the *single highest-leverage OCP fix in the codebase* — not because it is the most broken, but because the failure mode is silent and security-relevant. `isToolEnabled` looks the tool up; a tool registered but absent from the map falls back to `human`, which means the capability gate silently no-ops for that tool. So forgetting one line in a 437-line block does not error — it quietly opens a tool the gate was supposed to govern. Deriving the map from a `{capability}` field captured at `host.register` eliminates 181 manual entries and the entire bug category. Two more cross-cutting concerns live here and matter beyond their local severity: config-layer precedence is a hard-coded sequence of four `apply()` calls (one wrong order silently changes which layer wins), and egress masking — the composition of the URL sanitiser with the secrets registry — is left to caller discipline at each output sink (`diagnostics.ts` masks deeply but skips the URL sanitiser). The RFC's `EgressSanitiser` (D4) makes masking a constructor-required argument so a new sink *cannot* forget it.

| Finding | Category | Severity | Evidence (file:line) | Fix |
|---|---|---|---|---|
| **`TOOL_CAPABILITY` must be hand-edited for every new tool** — a miss silently defaults the tool to `human` | OCP | high | `src/util/capabilities.ts:87-524` (181 entries, verified; `isToolEnabled` reads it at `:567,575`) | Derive `TOOL_CAPABILITY` from a `{capability}` field captured at `host.register` |
| **`ALL_CAPABILITIES` + `ALL_CONFIRM_HOOKS` are hand-typed lists** that must mirror the type unions exactly | OCP | high | `src/util/capabilities.ts:36-54` (`ALL_CAPABILITIES`, 17 capabilities), `:589-594` (`ALL_CONFIRM_HOOKS`); the union is at `:17-34` (verified) | A `CAPABILITIES_REGISTRY` const; derive type + array + validation |
| Config-layer precedence is hard-coded as a fixed sequence of `apply()` calls | OCP | medium | `src/util/config-store.ts` (`resolve()` calls `apply()` 4× in fixed order; `getLayer` is a hand-written switch) | Declarative layer-metadata array looped in `resolve()` |
| **Secrets + URL masking is composed at the caller's discretion at each sink** — a forgotten sink leaks | spaghetti | medium | `src/util/secrets.ts` (`composeUrlAndSecretsInText`, optional); `src/util/diagnostics.ts` calls `applyMaskDeep` directly without the URL sanitiser | One `EgressSanitiser` injected into every output sink (compile-time mask guarantee) |
| `ConfigStore` mixes file-I/O + precedence merge + layer mutation | SRP | medium | `src/util/config-store.ts` (load/save/setLayer/resetLayer + `apply`/`resolve`) | A `ConfigStorage` port + a pure `ConfigStore` + a `ConfigManager` |
| Policy-resolution functions have no compositional abstraction | spaghetti | medium | `src/server.ts` calls `resolveCapabilities` + `resolveConfirmHooks` + `resolveOriginPolicy` in sequence (`capabilities.ts`, `policy/origin.ts`) | A `PolicyRegistry.resolveAll(env)` |
| Default values scattered across three modules | duplication | medium | `DEFAULT_CAPABILITIES` (`capabilities.ts:56`), `BUILTIN_DEFAULTS` (`config-store.ts`), `DEFAULT_TEST_ATTRIBUTES` (`config.ts`) | A single `util/defaults.ts` type-checked against `ResolvedConfig` |
| Five credential-provider classes duplicate CLI-wrapper skeletons | duplication | low | `src/util/credentials.ts` (Oathtool/OnePassword/Bitwarden/Lastpass/None + a switch) | A `ShellProvider(config)` driven by a provider registry |
| Batch predicate-lowering is hand-written per field | duplication | low | `src/util/batch.ts` (`evaluateExpect` lowers `BatchExpect` shorthands) | Auto-derive the lowering from a field schema |
| Diagnostics denial accumulator is process-wide mutable state with unclear ownership | DIP | low | `src/util/diagnostics.ts` (`DiagnosticsRecorder.denials` counter) | Move counting into `SessionMetrics`; read-only aggregation on the recorder |

**OCP extension scenarios — policy-util:**

| Scenario | Files to edit today | Count | Verdict |
|---|---|---|---|
| Add a new top-level capability | `util/capabilities.ts` (union + `ALL_CAPABILITIES` + `TOOL_CAPABILITY`), `config-store.ts` (3 edits), `policy/*`, `server.ts`, `threat-model.md` | 5+ (3 in capabilities.ts) | **Poor.** |
| Add a tool family | `tools/print-tools.ts` (new), `util/capabilities.ts` (entries), `server.ts` (register) | 2 existing (+new) | **Poor.** `TOOL_CAPABILITY` edit is non-compositional; a miss silently passes the gate. |
| Add a config layer | `config-store.ts` (5 edits: type + field + defaults + apply-order + getLayer) | 5 in 1 file | **Poor.** One wrong precedence order breaks silently. |
| Add a new policy type | `policy/batch-size.ts` (new), `capabilities.ts`, `server.ts`, `host-build.ts` | 3 existing (+new) | **Poor.** No shared policy interface; each policy is bespoke. |

---

## 7. plugin-sdk

`src/plugin/**`, `src/sdk/**`, `src/cli/**`. The runtime is well-engineered; the extension points are switches and a hand-mirrored type file.

This subsystem is the mildest of the eight — the plugin runtime itself (cycle detection, capability gating, manifest parsing) is genuinely well-built and is not refactor scope. The debt is concentrated in the extension *points*: CLI subcommand dispatch is a `switch` in both `cli.ts` and `plugin/cli.ts`, SDK transport selection is a `switch(mode)` in `sdk/index.ts`, and the plugin package-manager surface hardcodes pnpm/npm in a `PM_VERBS` map. The standout is `sdk/tool-types.ts`: 673 lines of hand-written TypeScript that mirror the zod schemas the file's own header admits are the source of truth. Every schema change is a guaranteed two-place edit, and nothing fails when the mirror drifts — the SDK consumer just gets stale types. Generating the file from the registrations (D7), with a fitness test that fails on divergence, removes 673 LOC of hand-mirroring and the drift class with it. `plugin/cli.ts` (538 LOC) also conflates five concerns (lock I/O, config I/O, PM dispatch, version pinning, CLI) and is a clean SRP split.

| Finding | Category | Severity | Evidence (file:line) | Fix |
|---|---|---|---|---|
| **CLI command dispatch is a hardcoded `switch`** in two places | OCP | high | `src/cli.ts` (`switch(subcommand)` over doctor/chrome/init/serve/plugin; 137 LOC); `src/plugin/cli.ts` (`switch(sub)` over install/remove/list/info/upgrade/sync) | A `Map<string, CommandHandler>` registered add-only |
| **`sdk/tool-types.ts` is 673 LOC hand-mirroring the zod schemas** it admits are the source of truth | duplication | high | `src/sdk/tool-types.ts` (673 LOC, verified; header admits the schemas are authoritative) | Codegen the types from the registrations; a fitness test fails on divergence |
| SDK transport selection is a hardcoded `switch(mode)` | OCP | medium | `src/sdk/index.ts` (234 LOC; `switch(mode)` over in-process/stdio-child/socket) | A `Map<TransportMode, TransportFactory>` |
| Plugin-runtime tool-wrapping is hardcoded in the tool module, asymmetric with the core path | coupling | medium | `src/tools/plugin-runtime.ts` (`registerPluginTool` wraps gates/metrics/diagnostics) | One `ToolRegistration` abstraction shared by both paths |
| Plugin CLI lacks a package-manager abstraction (`PM_VERBS` hardcodes pnpm/npm) | OCP | medium | `src/plugin/cli.ts` (`PM_VERBS` map) | A `PackageManagerAdapter` interface |
| Plugin namespace validation is runtime-only, buried in async load | error-handling | medium | `src/plugin/runtime.ts` (`PluginApi.registerTool` throws on missing namespace) | Validate at manifest parse time |
| **`plugin/cli.ts` conflates five concerns** (lock I/O, config I/O, PM dispatch, version pinning, CLI) | SRP | medium | `src/plugin/cli.ts` (538 LOC, verified) | Split into `LockStore`/`ConfigStore`/`PMAdapter`/`Installer`/CLI |
| Transport interface lacks introspection (`listTools`) | ISP | low | `src/sdk/transport.ts` (`dispatch()`/`close()` only) | Optional `listTools(): Promise<string[]>` |

**OCP extension scenarios — plugin-sdk:**

| Scenario | Files to edit today | Count | Verdict |
|---|---|---|---|
| Add a CLI subcommand | `cli.ts` (switch + import) | 1 existing (+new) | **Poor.** Registry needs only the new file + registration. |
| Add an SDK transport | `sdk/index.ts` (switch) | 1 existing (+new) | **Poor.** Factory registry is add-only. |
| Add a package manager (yarn) | `plugin/cli.ts` (`PM_VERBS` + enum + retest all cmd fns) | 1 file, multiple edits | **Poor.** Adapter pattern needs only a `YarnAdapter`. |

---

## 8. harness-and-docs

The meta-subsystem: ESLint, tests, CI, agent skills, architecture docs. **This is the root cause of the other seven.** Strong micro-rules, zero macro fitness functions.

The diagnosis is precise: the harness enforces *style and safety at the line level* and *nothing at the architecture level*. `eslint.config.js` registers exactly two custom rules under the `browxai-local` plugin — `no-tracker-ids-in-comments` (comment hygiene) and `no-page-eval-stringified-arrow` (a page-eval footgun) — both excellent, both micro. There is no rule for `engine === "literal"` in handlers, no size budget on `server.ts`, no inlined-capability-check rule. The test side mirrors the gap: 22 keystone tests with per-engine lanes that each prove *a specific engine works*, but not one "engine-adapter contract" test that proves *a new engine works without core edits* — which is the only test that would have caught T1. The doctrine exists and is well-written (`architecture-principles.md` §4), but a principle a human reads and a machine ignores is a principle that drifts at agent velocity. This is why every one of the 80 findings landed through a green gate. The supporting evidence is itself a finding: `03-browxai-coupling-audit.md:5` still cites `server.ts` at 12,889 lines (verified now at 382) — the docs went stale because no fitness function checks them either. The RFC's entire D8–D12 layer is the answer to this subsystem.

| Finding | Category | Severity | Evidence (file:line) | Fix |
|---|---|---|---|---|
| **No OCP regression test for engine dispatch** — nothing fails when a future engine must edit the existing factories | OCP | **critical** | `src/session/managed.ts`/`byob.ts`/`incognito.ts` (engine literals); no test enforces architecture-principles §4 | An engine-handler table + a keystone "mock engine, zero core edits" test |
| **No ESLint rule flags engine-literal branches** — the harness has exactly **2** custom rules, neither covering this | OCP | **critical** | `eslint.config.js` — `no-tracker-ids-in-comments` (rule `create` at `:44`) and `no-page-eval-stringified-arrow` (`create` at `:79`), registered under `browxai-local` at `:109-111`, applied `error` at `:148-149` (310 LOC total; verified) | A `no-engine-literal-branches` rule scoped to handlers, whitelisting the substrate selectors |
| No test validates OCP when adding a capability | OCP | high | no `test/unit/capabilities-ocp.test.ts` | A fitness test: register a synthetic capability + tool without touching `capabilities.ts` |
| No keystone proves the engine-adapter OCP property (22 keystone tests, none a "new adapter → tools work" contract) | OCP | high | `test/keystone/` (per-engine lanes, no contract lane) | An `engine-adapter-contract.keystone.test.ts` |
| **No enforcement that `server.ts` stays composition-only** | SRP | high | `src/server.ts` (382 LOC, documented composition-only; `eslint.config.js:289` exempts it from `require-await` but sets no size budget) | A `max-lines` budget + an import-depth guard (`server.ts` ↛ `page/*`) |
| **No dependency-cruiser / layering enforcement** | DIP | high | `.depcheckrc.json` checks unused deps only; `eslint.config.js` has no forbidden-import rules | A `dependency-cruiser` config encoding the doctrine's layering |
| No guardrail prevents capability-gate bypass in handlers | SRP | high | `code-quality.md` forbids inlined gate checks; no lint rule enforces it | A `no-inlined-capability-checks` rule on `src/page/*.ts` |
| No test validates engine-capability declaration completeness | DIP | medium | `src/engine/capabilities.ts` (per-engine `*_CAPABILITIES`; no completeness test) | A test asserting every `EngineKind` has a capabilities row with the expected keys |
| **Stale RFC reference cites `server.ts` at 12,889 lines** — it is 382 | OCP | medium | `docs/rfcs/references/03-browxai-coupling-audit.md:5` ("12,889 lines, all 198 tool registrations") vs verified `src/server.ts` = 382 LOC | Correct the inventory; note the session factories as OCP candidates |
| No test for tool-capability mapping completeness | DIP | medium | `src/util/capabilities.ts` (181 entries; no test asserts every registered tool has one) | A test scanning `host.register` calls vs `TOOL_CAPABILITY` keys |
| Architecture guardrails not consolidated in `code-quality.md` | OCP | medium | `code-quality.md` lists micro-rules + philosophy but not the architectural guardrails | An "Architecture enforcement" section enumerating each guardrail + its check |
| No SRP complexity budget on the cross-cutting `src/util/*` modules | SRP | low | `src/util/*` (capabilities, secrets, config, diagnostics, deadline) | Optional file-size warnings + a one-line responsibility contract per file |

**OCP extension scenarios — harness-and-docs** (these are the *good* cases — proof the doctrine works where the harness already inverts dependencies):

| Scenario | Files to edit today | Count | Verdict |
|---|---|---|---|
| Add a 6th browser engine | `engine/types.ts`, `engine/capabilities.ts`, `engine/adapters/new.ts`, `session/managed.ts`, `session/incognito.ts`, `session/byob.ts`, `engine/select.ts` | 7 | **Poor.** Session factories use hardcoded `if`; the OCP claim is unsupported. |
| Add a new capability | `util/capabilities.ts`, the using tool, `threat-model.md`, `AGENTS.md`, keystone denial test | 4–5 (mostly docs/tests) | **Good.** The gate composition is unchanged (table-driven). |
| Add a tool family | `tools/profiling-tools.ts` (new), `server.ts` (one register line), tests, docs | 1 existing (+new) | **Good.** `server.ts` is a true composition root. |
| Add a harness/agent adapter | `AGENTS.md` (pointer), `harness/adapters/*` (new) | add-only | **Good.** `AGENTS.md` is the single source of truth (dependency-inverted). |

The contrast in this table is the entire RFC in miniature: where the harness already enforces dependency inversion (capability gate, tool registration, multi-harness `AGENTS.md`), extension is add-only and **Good**; where it does not (engine dispatch), extension is **Poor** and the doctrine is a lie. The fix is to make the second column look like the rest.

---

## 9. Cross-cutting themes

The 80 findings collapse into six structural themes plus the meta-theme. Each row gives the number of the eight subsystems it appears in and the aggregate file blast-radius (distinct existing files an extension must touch because of this theme).

| # | Theme | Subsystems hit | Aggregate blast-radius | Worst evidence |
|---|---|---|---|---|
| **T1** | **Engine-dispatch OCP failure** — adapter wiring is hardcoded `if (engine===…)` | 5 (engine, session, page-core, tools, harness) | the 3 session factories + `session-registry.ts` (17 guards) + 5 `host-build.ts` selectors + 2 substrate selectors + `tool-gate.ts` ≈ **11 files / ~40 edit sites** | `session/managed.ts:26-42`; `session-registry.ts` 17 guards; `host-build.ts:288-357` |
| **T2** | **Hand-maintained central lists** — every addition edits a god-list | 4 (tools, policy-util, plugin-sdk, page-features) | `BATCH_ALLOWED_TOOLS` (71) + `TOOL_CAPABILITY` (181) + `ALL_CAPABILITIES` (17) / `ALL_CONFIRM_HOOKS` (~4) + `DEEP_TOOLS` (31) + perf `ANALYSERS` (8) + `sdk/tool-types.ts` (673 LOC) ≈ **6 lists / ~985 hand-mirrored entries+LOC** | `host-build.ts:640-712`; `capabilities.ts:87-524`; `tool-gate.ts:38-88` |
| **T3** | **God-modules / god-objects** (SRP/ISP) | 4 (tools, session, plugin-sdk, policy-util) | 4 tool modules (1965+1514+1107+1033 = **5619 LOC** in four files) + `ToolHost` + `SessionEntry` (40 fields) + `plugin/cli.ts` (538) + `ConfigStore` | `read-observe-tools.ts` (1965); `registry.ts:48` (`SessionEntry`); `host.ts:54-189` (`ToolHost`) |
| **T4** | **Copy-paste families** (DRY) | 4 (session, page-features, page-core, policy-util) | 5 policy classes + 5 substrate selectors + the 7-step action pattern (~50 sites) + `sample.ts` 2× switch + `network.ts` 3× fold + `extract.ts` 2× scan + 5 credential classes ≈ **70+ duplicate sites** | `dialog.ts:62-93` ×5; `sample.ts:144-167`; `network.ts` fold ×3 |
| **T5** | **LSP leak** — Safari `page()` throws | 3 (session, engine, page-core) | the throw site + the 17 registry guards + the 2 substrate selectors ≈ **20 sites** | `safari-session.ts:34-36`; `session-registry.ts` 17 guards |
| **T6** | **Switch / stringly dispatch** (OCP) | 3 (plugin-sdk, page-features, session) | CLI switch ×2 + SDK transport switch + perf `ANALYSERS` + session-mode literals + `PM_VERBS` ≈ **6 switch sites** | `cli.ts`; `sdk/index.ts`; `perf-audit.ts:88-97` |
| **T7** | **The guardrail vacuum** (meta) | 8 (all) | the harness has **2** custom lint rules and **0** architectural fitness functions; no layering check, no size budget, no completeness test | `eslint.config.js` (2 rules at `:44,:79`); `test/keystone/` (no contract lane) |

T7 is the load-bearing finding: **T1–T6 happened because T7 was true.** Every structural defect above was committed through a green gate. The refactor (RFC 0004 D1–D7) repays the debt; the guardrails (D8–D12) ensure it never re-accrues — see [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md).

A theme-by-theme reading of *why each one costs what it costs*:

**T1 — engine-dispatch OCP failure.** This is the most expensive theme because its blast-radius is the widest and its failure is the flagship claim. The cost is not just the eleven files: it is that the eleven are in *four different subsystems* (session factories, the tool registry, the substrate selectors, the engine gate), so a sixth engine forces a contributor to hold all four in their head at once and edit each correctly, with no compiler or test telling them when they missed one. The Safari onboarding is the existence proof — it required the 17 guards precisely because the wiring was not closed for extension. The `EngineRegistry` (D1) is the single intervention that drops the blast-radius from eleven files to one.

**T2 — hand-maintained central lists.** The cost is silent drift. Every one of the six lists fails *quietly* on a miss: `TOOL_CAPABILITY` defaults to `human` (gate no-op), `DEEP_TOOLS` lets a CDP tool crash off-Chromium, `BATCH_ALLOWED_TOOLS` silently makes a tool non-batchable, the SDK types just go stale. None of these are caught at compile time or test time today. The lists hold ~985 entries and LOC that are, in principle, all derivable from the registrations that already exist — they are denormalized copies maintained by discipline. D2/D7 normalize them.

**T3 — god-modules / god-objects.** The cost is cognitive and merge-conflict surface. A 1965-line module is not just hard to read; it is a magnet for unrelated changes that collide, and it defeats the doctrine's one-tool-one-file locality (you cannot find a tool by its filename). `SessionEntry`'s 40 fields mean every tool recompiles when any field changes, and a tool depends — in its type signature — on 39 fields it never reads. The budgets in D11 (≤ ~400 LOC per tool module) are sized from the *healthy* current modules, so the split has a concrete target.

**T4 — copy-paste families.** The cost is N-place bug fixes and self-rationalizing comments. The five policy buffers, the five substrate selectors, the ~50 action handlers, and the `sample.ts`/`network.ts`/`extract.ts` internal duplications all share the property that a fix or an extension must be applied identically in every copy, and the copies have already started to drift (the `extract.ts` finding cites a history of missed edits). The extractions in D4 (`PolicyRecordBuffer`, the substrate-factory builder, `actionTool()`) turn each family into one place.

**T5 — the Safari LSP leak.** The cost is that one Liskov violation leaks into every caller. `BrowserSession.page(): Page` is a contract; Safari breaks it unconditionally; so every caller that might run on Safari must guard — hence the 17 guards, plus the two substrate-selector name-checks, plus the `SafariNoopNetworkSubstrate` placeholder. The leak is not 17 separate bugs; it is one design decision (page() throws instead of being absent-and-typed) replicated 20 times. D5 makes `page` a declared, narrowable capability so the type system carries the constraint the guards carry by hand today.

**T6 — switch / stringly dispatch.** The cheapest theme to fix and the easiest to regress. Six `switch`/literal-map dispatch sites (two CLI, one transport, the perf analysers, the session modes, the package managers) each have multiple real cases *today* — they are proven seams, not speculative ones — so converting each to an add-only `Map<key, factory>` is behavior-preserving and immediately closes the extension point. The perf-audit case is notable because architecture-principles §2 cites the analyser registry as the doctrine's OCP *exemplar* — and the audit found its implementation is stringly-typed with a four-site fan-out. D6 makes the exemplar actually exemplary.

---

## 10. Sizing the work — the 20% of files carrying 80% of the cost

Pareto on the defect mass. Three clusters of files, when fixed, close the overwhelming majority of the edit-fan-out. LOC are `wc -l`-verified; edit-fan-out is "existing files an extension touches because of this cluster."

**Cluster A — the engine-dispatch sites (T1 + T5 + T6 engine half).** Fixing this single cluster makes "a 6th engine is one file" true.

| File | LOC | Role in the cluster | Edit-fan-out per new engine |
|---|---|---|---|
| `src/session/managed.ts` | 162 | adapter `if-else` (android@26, safari@35, firefox@109, webkit@112, chromium@120) | 1 |
| `src/session/incognito.ts` | 133 | adapter `if-else` (same shape, refuses safari/android) | 1 |
| `src/session/byob.ts` | 216 | attach `if-else` (refuses safari/firefox/webkit, attaches chromium) | 1 |
| `src/tools/session-registry.ts` | 620 | 17 Safari `!== "safari"` guards | up to 17 guard reviews |
| `src/tools/host-build.ts` | 760 | 5 substrate selectors (`:288-357`) + `BATCH_ALLOWED_TOOLS` (`:640-712`) | 5 selectors |
| `src/page/snapshot-substrate-select.ts` | 54 | `engine === "safari"` (`:44`) | 1 |
| `src/page/network-substrate-select.ts` | 48 | `engine === "safari"` (`:44`) | 1 |
| `src/engine/tool-gate.ts` | 145 | `DEEP_TOOLS` hand-set (`:38-88`) | 1 per CDP tool |

Cluster total: **~2138 LOC across 8 files; ~28 edit sites per engine addition.** Target after the `EngineRegistry`: **1 new file, 1 registration line.**

**Cluster B — the central lists (T2).** Each is a single source-of-truth violation; deriving them from registrations closes four OCP findings at once.

| List | Location | Size | Edit per addition |
|---|---|---|---|
| `TOOL_CAPABILITY` | `capabilities.ts:87-524` | 181 entries | 1 per tool (silent `human` default on miss) |
| `BATCH_ALLOWED_TOOLS` | `host-build.ts:640-712` | 71 entries | 1 per batchable tool |
| `DEEP_TOOLS` | `tool-gate.ts:38-88` | 31 entries | 1 per CDP tool (silent off-Chromium crash on miss) |
| `ALL_CAPABILITIES` / `ALL_CONFIRM_HOOKS` | `capabilities.ts:36-54,589-594` | 17 / small | 1 per capability/hook |
| perf `ANALYSERS` | `perf-audit.ts:88-97` | 8 categories | 4 sites per category |
| `sdk/tool-types.ts` | whole file | 673 LOC | full parallel update per schema change |

Cluster total: **~985 hand-mirrored entries and LOC** that should be derived. The highest-leverage single fix is deriving `TOOL_CAPABILITY` from registration metadata — it eliminates 181 manual entries and the entire forgetting-to-map bug category.

**Cluster C — the four god-modules (T3).**

| File | LOC | Families bundled | Target after split |
|---|---|---|---|
| `src/tools/read-observe-tools.ts` | 1965 | 20+ | ~6 modules ≤ ~400 LOC |
| `src/tools/capture-report-tools.ts` | 1514 | ~21 | ~6 modules |
| `src/tools/emulation-config-tools.ts` | 1107 | 8 | ~5 modules |
| `src/tools/deep-tools.ts` | 1033 | perf/coverage/heap/clock/compound | ~4 modules |

Cluster total: **5619 LOC in four files** that violate the doctrine's own one-family-per-module rule (these are an artifact of RFC 0003's line-range decomposition, flagged "thematically loose" at the time).

Together, **Clusters A+B+C are ~22 files** — well under 20% of `src/` — and they account for essentially all of the engine-extension fan-out, the central-list maintenance burden, and the SRP debt. The plan in [`0004-04-refactor-plan.md`](0004-04-refactor-plan.md) sequences them A → B → C behind the guardrails.

---

## 11. Method and limitations

**Method.** Eight adversarial Explore auditors ran in parallel, one per subsystem (tools-and-seam, engine-adapters, page-core substrates, page-features, session, policy-util, plugin-sdk, harness-and-docs), each instructed to find SOLID / spaghetti / OCP defects and the guardrail gaps that let them land. Each returned structured findings (`title, category, severity, evidence, problem, fix`), per-subsystem OCP extension scenarios, guardrail gaps, and top refactors. The run was **read-only** — no commits, no behavior change.

**Limitations and how this document handles them.**

- **Some audit citations were approximate.** An automated fan-out occasionally cited a `file:line` range a few lines off, or rounded a count. Every high-severity citation in §§1–8 was re-opened against the source; corrections are flagged inline *(audit said X; verified Y)*. Confirmed-exact examples: `BATCH_ALLOWED_TOOLS` at `host-build.ts:640-712`, the substrate selectors at `host-build.ts:288-357`, the Safari `page()` throw at `safari-session.ts:34-36`, `TOOL_CAPABILITY` at `capabilities.ts:87-524` (181 entries). Corrected examples: the session-registry Safari guards are **17** (not "18+"); the perf `ANALYSERS` registry has **8** categories (not 9); `DEEP_TOOLS` holds **31** tools (not 26); `ToolHost` declares **35** members (the "75-member" figure over-counts). The `server.ts:12,889-lines` citation in `03-browxai-coupling-audit.md:5` is itself **stale** — verified 382 — which is finding harness[8].
- **A few findings are leads, not verdicts.** Where a finding's fix is "document the pattern" or "consider plugin extensibility later" (e.g. `verify.ts` target resolution is *already* centralized; `canvas.ts` discovery is the design intent), the severity is medium/low and the RFC treats them as future-proofing, not refactor scope — see [`0004-08-future-proofing.md`](0004-08-future-proofing.md). They are retained here for completeness, not promoted to the plan.
- **Severity is the auditor's, normalized.** "Critical" is reserved for OCP failures that make the flagship "new engine = new adapter" claim false (T1) and for the central-list and self-admitted-duplication findings; "high" for god-modules, the LSP leak, and copy-paste families; "medium/low" for naming, dead code, and leads.

### 11.1 Verification ledger

The high-severity citations re-opened against `main`, with the verdict. This is the table a skeptical staff engineer should spot-check first.

| Claim | Audit citation | Verified | Verdict |
|---|---|---|---|
| `read-observe-tools.ts` god-module | 1965 LOC | `wc -l` = 1965 | exact |
| `capture-report-tools.ts` god-module | 1514 LOC | `wc -l` = 1514 | exact |
| `emulation-config-tools.ts` god-module | 1107 LOC | `wc -l` = 1107 | exact |
| `deep-tools.ts` god-module | 1033 LOC | `wc -l` = 1033 | exact |
| `BATCH_ALLOWED_TOOLS` hand-list | `host-build.ts:640-712` | Set opens `:640`, closes `:712`, 71 entries | range exact; count corrected → 71 |
| 5 substrate selectors | `host-build.ts:288-357` | `actionsFor`@288 … `emulationFor`@349, all 5 `safari?.()`→Safari else Playwright | exact |
| Safari `page()` throws | `safari-session.ts:34-36` | `page: () => { throw new Error(NO_PLAYWRIGHT_PAGE) }`; msg `:18-22` | exact (file is 44 LOC) |
| session-registry Safari guards | "18+" | grep `!== "safari"` = **17** | corrected → 17 |
| `DEEP_TOOLS` set | "26 names", `tool-gate.ts:38-88` | Set `:38-88`, 31 entries | range exact; count corrected → 31 |
| `TOOL_CAPABILITY` map | `capabilities.ts:87-524`, 181 entries | opens `:87`, closes `:524`, 181 entries | exact |
| `ALL_CAPABILITIES` | `capabilities.ts:36-54` | 17 capabilities, `:36-54` | exact |
| perf `ANALYSERS` | "8" / "9" categories, `:88-97` | record `:88-97`, **8** categories; union `:23-31`; array `:33-42` | corrected → 8 |
| `ToolHost` member count | "75-member" | `host.ts:54-189`, **35** members | corrected → 35 |
| `sample.ts` double switch | self-admitted at `:136-137` | comment verbatim at `:136-137`; switch at `:144-167` | exact |
| managed.ts engine dispatch | "26-42 / 109-128" | android@26, safari@35, firefox@109, webkit@112, chromium@120 | corrected → 109-120 Playwright branch |
| `sdk/tool-types.ts` hand-mirror | 673 LOC | `wc -l` = 673 | exact |
| ESLint custom rules | "2 rules at 108-112" | 2 rules, `create`@44 & @79, registered `:109-111` | exact (rule bodies span wider) |
| stale `server.ts` line count | `03-...-audit.md:5` says 12,889 | actual `server.ts` = 382 | confirmed stale |

Of the ~18 high-value citations, **12 were exact** and **6 were corrected** (the session-registry guard count → 17, the `DEEP_TOOLS` size → 31, the perf category count → 8, the `BATCH_ALLOWED_TOOLS` size → 71, the `ToolHost` member count → 35, and the managed.ts dispatch range) — none of the corrections weakens a finding; each makes it more precise.

This document is the evidence floor. The target patterns are in [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md); the standard those patterns satisfy is in [`0004-02-maintainability-standard.md`](0004-02-maintainability-standard.md); the machines that keep it true are in [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md).

---

## Related

- [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) — the parent RFC: thesis, ten laws (L1–L10), decisions (D1–D12), phasing. This document is its §2 evidence base.
- [`0004-02-maintainability-standard.md`](0004-02-maintainability-standard.md) — the safety-critical standard each defect violates.
- [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md) — the `EngineRegistry`, metadata-at-registration, and extraction patterns that fix T1–T6.
- [`0004-04-refactor-plan.md`](0004-04-refactor-plan.md) — the sequenced, behavior-preserving plan over Clusters A → B → C.
- [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md) — the executable answer to T7.
- [`0004-08-future-proofing.md`](0004-08-future-proofing.md) — where the lead-only findings land.
- [`03-browxai-coupling-audit.md`](03-browxai-coupling-audit.md) — the prior coupling audit this one extends (and whose stale `server.ts` line count it corrects).
- [`../../ai-context/architecture/architecture-principles.md`](../../ai-context/architecture/architecture-principles.md) — the doctrine these findings show is unenforced (§4 "new engine = new adapter").
