# RFC 0004 / Reference 06 — AI documentation & harness hardening

**Parent:** [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) (Decision [D12](../0004-architecture-hardening.md); the standard in §4; the laws L1–L10).
**Scope of this reference:** how the standard becomes **discoverable** by the next agent and **enforced** by the harness. The refactor ([`0004-04-refactor-plan.md`](0004-04-refactor-plan.md)) pays down the debt; the fitness functions ([`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md)) make it executable; **this document wires both into the documents and agents that route every future change** — so a contributor (human or model) *learns* the guardrails from the docs they already read, and a PR-time agent *re-checks* them before merge.

## Abstract

The parent RFC's meta-finding (theme T7) is that browxai's doctrine is excellent and unenforced: the micro rules are mechanized (a `no-tracker-ids-in-comments` ESLint rule, a `tracker-id-auditor` PR agent), the macro rules are not. The harness-and-docs audit is blunt about the second half of the gap — *"strong micro-level guardrails mask weak macro-level architecture enforcement … the architecture is aspirational (well-written principles docs) but unenforced."* A fitness function nobody reads about and no agent runs is a tree falling in an empty forest. This reference specifies the exact, paste-ready edits that close the **documentation** half of the loop: the ten laws land in `architecture-principles.md` with their enforcer column, the guardrails consolidate into a new `code-quality.md` section a contributor actually reads, a new `fitness-functions.md` becomes the single map of "what fails if I drift," the stale source maps are corrected, and a new `architecture-fitness-auditor` agent plus a builder→reviewer workflow gate make the suite *run on every PR*. Nothing here changes `src/` behavior; it changes what the next agent knows and what the harness will not let through.

---

## 1. The shape of the gap (why docs are load-bearing, not decoration)

browxai is an agent-driven, high-velocity codebase. The harness audit's own OCP-scenario table shows the failure mode is *invisible at the unit-test level*: adding a sixth engine touches seven files today, "the OCP claim is unsupported," yet every one of the 80 audited defects "passed review" through a green gate. Two channels, and only two, reach the next agent before it writes code:

1. **The routing docs it is told to read.** `AGENTS.md` (cross-harness source of truth), then `architecture-principles.md` + `code-quality.md` for any boundary change, then `repo-map.md` to navigate. If a guardrail is not named in those, the agent does not know it exists.
2. **The PR-time agents and CI gates that re-check the diff.** `tracker-id-auditor`, `capability-gate-auditor`, `docs-impact-auditor`, and the quality gate (`pnpm test` / `lint` / …). If no agent runs the fitness suite, drift merges.

Today channel 1 is silent on the macro guardrails and channel 2 has no fitness step. The audit is explicit on both: *"A future contributor reading code-quality.md will NOT learn the guardrails"* (the consolidation finding) and *"no automated fitness functions validating that core architectural constraints are NOT being violated"* (the harness finding). This document closes both channels with concrete text. **The principle: a law that is documented but not in `fitness-functions.md`, and not run by an agent, is not part of the standard — it is a wish.**

A guiding constraint throughout: the new docs **extend, never restate**. `architecture-principles.md` already carries the proven-seam test, the dependency-direction rule, and the §7 review checklist; `code-quality.md` already carries SOLID-in-TypeScript and the comment discipline. We add the *enforcement* column and the *guardrail inventory* those docs lack — we do not re-derive SOLID. Cross-reference is the load-bearing move.

---

## 2. `architecture-principles.md` — add the ten laws and their enforcers

The doctrine document states the seams (§1, §4) and lists a §7 review checklist, but every checklist item is a *human judgment* (`[ ] Is the seam proven?`) with no machine behind it. The audit's recommendation: make the macro rules transparent and tie each to its check. We add **one new section (§4a)** immediately after §4 ("Scalability seams"), because the laws are the *mechanization* of the seam claims in §4, and we **extend §7** with the machine-checked items.

### 2.1 New section — insert after §4, before §5

> ## 4a. The ten laws — the seams, mechanized
>
> §4 names the seams the system grows along. A seam the machine does not guard is a
> seam that drifts: the audit behind [RFC 0004](../../rfcs/0004-architecture-hardening.md)
> found the flagship claim of §4 — *"new engine = new adapter behind the existing
> port"* — was **false in practice**, because the adapter *wiring* (not the
> adapters) was hardcoded across the session factories. The fix is not more prose;
> it is an **enforcer per invariant**. The ten laws below are the standard; each is
> backed by a fitness function, a custom lint rule, or a CI gate. **A law with no
> green check is not in the standard.** The full rationale and safety-critical
> lineage (Power-of-Ten, JPL, DO-178C) live in
> [`../../rfcs/references/0004-02-maintainability-standard.md`](../../rfcs/references/0004-02-maintainability-standard.md);
> the executable specs in
> [`../../rfcs/references/0004-05-fitness-functions-and-guardrails.md`](../../rfcs/references/0004-05-fitness-functions-and-guardrails.md);
> the single index of every check in [`fitness-functions.md`](fitness-functions.md).
>
> | Law | Statement | Enforcer (the machine that fails) |
> |-----|-----------|-----------------------------------|
> | **L1 — Closed core** | No module above the engine seam names an engine, a transport, or a concrete adapter. Extension is add-only. | `no-engine-literal-branches` lint rule (handlers) + the `engine-adapter-contract` keystone (a synthetic 6th engine that must work with zero core edits). |
> | **L2 — Single source of truth** | No fact is written twice. Capability, batchability, deep-ness, tool-types are **declared once** at the unit and **derived**. | Completeness fitness tests (every registered tool ∈ derived capability map; tool-types ≡ schemas) + tool-types codegen. |
> | **L3 — One reason to change** | One module, one responsibility. Hard budgets: a tool module ≤ ~400 LOC, `server.ts` ≤ 400, a function ≤ ~70 LOC / complexity ≤ ~15. | `eslint` `max-lines` / `complexity` / `max-lines-per-function` budgets + the composition-root guard. |
> | **L4 — Segregated contracts** | No god-object. Consumers depend on the narrow port they use, not a 75-member bag. | Interface-member budget + dependency-cruiser "host split" rule. |
> | **L5 — Substitutable adapters** | Every adapter honors its port's full contract or **declares the gap as a capability**; no adapter throws where the port promises a value. | The port-conformance contract test, run against every adapter including a synthetic one. |
> | **L6 — Validate at the edge, trust within** | Untyped data is narrowed at the boundary (MCP wire, config, CDP/Playwright edge) and fully typed thereafter. | The five `no-unsafe-*` rules (now `error`) + `no-explicit-any` + the boundary-narrowing test. |
> | **L7 — Bounded everything** | Every loop, buffer, ring, recursion, and wait has an explicit, tested bound. | The bounded-resource lint rule + budget tests on rings / deadlines / depth caps. |
> | **L8 — Assert the invariants** | Internal invariants are asserted, not assumed; a violated invariant surfaces as a structured refusal, never a crash. | An `invariant()` helper + a density check on the load-bearing modules. |
> | **L9 — Traceable** | Every world-touching tool ⇒ a capability declaration ⇒ a keystone denial test, in the same change. Every engine ⇒ a capability row ⇒ a keystone lane. | Traceability fitness tests (tool↔capability↔keystone; engine↔caps↔lane). |
> | **L10 — Deterministic & observable** | The surface is deterministic where it pays (replay, diffing) and self-diagnosing; determinism is keystone-verified. | The existing keystone determinism gates, extended to the new seams. |
>
> The laws are not new doctrine bolted on — they are §1's dependency direction, §2's
> proven-seam test, §3's bounded-buffer rule, and §4's seams, each given the machine
> that §1–§5 always implied but never named. When you change a boundary, you are
> changing the thing one of these laws guards; run `pnpm test:arch` (the fitness
> lane) before you assume your change is add-only.

### 2.2 Extend the §7 review checklist

Append four machine-checked items to the existing checklist. They sit *below* the existing human-judgment items, because the machine items are the ones a reviewer can now stop hand-checking — the gate does it:

> - [ ] **Closed to the core?** (L1) No new `engine === "<literal>"` branch above the
>       engine seam; no handler imports a concrete adapter or transport. The
>       `no-engine-literal-branches` rule and the dependency-cruiser layering gate
>       pass. A new engine still reduces to one adapter file + one registration.
> - [ ] **Declared once, derived everywhere?** (L2) New tool metadata (capability,
>       batchable, deep) is colocated at `host.register`, not hand-added to a central
>       list. The completeness fitness tests pass (no tool missing from the derived
>       capability map; SDK tool-types match the schemas).
> - [ ] **Within budget?** (L3/L4) File-size, function-length, complexity, and
>       interface-member budgets are green. `server.ts` is still composition-only and
>       under its line ceiling.
> - [ ] **Fitness suite green?** (L1–L10) `pnpm test:arch` passes. If a fitness
>       function is *intended* to change (a budget re-baselined, a law amended), that
>       is an RFC amendment with rationale — never an inline disable. See the
>       meta-rule in [`fitness-functions.md`](fitness-functions.md).

### 2.3 Extend the "Related" footer

Add one line to §7's Related list so the doctrine points at the index of its own enforcers:

> - [`fitness-functions.md`](fitness-functions.md) — the index of executable
>   architecture invariants: every fitness function, what it proves, how to run it,
>   and which law it enforces. The machine behind §4a.

---

## 3. `code-quality.md` — add "Architecture enforcement — the automated guardrails"

The audit's consolidation finding is precise: `code-quality.md` has a dedicated "Comments discipline" section and a "SOLID, applied" section *with enforcement notes*, but the **macro** guardrails (no engine literals, no inlined gates, composition-only `server.ts`, dependency layering, OCP fitness) are "implicit in principles docs … A future contributor reading code-quality.md will NOT learn the guardrails." The fix is a new section that makes the *enforcement posture* explicit — every guardrail with the **command that runs it**, so a contributor learns the check, not just the rule.

Insert this section immediately **after** "SOLID, applied to modern TypeScript" and **before** "Workspace plugin discipline":

> ## Architecture enforcement — the automated guardrails
>
> The SOLID section above states the *rules*. This section states the *machines that
> fail when a rule is broken* — the macro guardrails. Micro rules (comments, naming,
> async safety) have always been mechanized; until [RFC 0004](../../rfcs/0004-architecture-hardening.md)
> the macro rules were documented and unenforced, and the codebase drifted exactly
> where no machine watched. Each guardrail below names its check. **If a guardrail
> says "code-review only," that is a known gap, not a free pass.** The single index
> of every fitness function — what each proves, which law it enforces — is
> [`../architecture/fitness-functions.md`](../architecture/fitness-functions.md);
> run the whole architecture lane with `pnpm test:arch`.
>
> | # | Guardrail (the rule) | Law | How it is checked | Command |
> |---|----------------------|-----|-------------------|---------|
> | 1 | **No engine literals in handlers.** No `engine === "<literal>"` branch above the engine seam; dispatch lives in substrates / the engine registry, never a handler. | L1 | `no-engine-literal-branches` custom ESLint rule (whitelists the substrate-select files) | `pnpm lint` |
> | 2 | **No inlined capability gates.** A handler routes capability checks through `ToolHost.gateCheck()`; it never inlines `capabilities.includes(...)`. | L1/SRP | `no-inlined-capability-checks` custom ESLint rule (scoped to `src/page/**`) | `pnpm lint` |
> | 3 | **`server.ts` is composition-only.** No business logic; under the 400-line ceiling; imports `src/tools/*`, never `src/page/*` directly. | L3 | `max-lines` budget on `server.ts` + the composition-root dependency-cruiser rule | `pnpm lint` + `pnpm depgraph` |
> | 4 | **Dependency layering holds.** `server.ts`/`tools/*` ⊥ `sdk/*`; `page/*` ⊥ concrete adapter/transport; `sdk/*` ⊥ handler internals; nothing but the bin imports `cli/*`. | L4/L10/DIP | `dependency-cruiser` forbidden-import rules | `pnpm depgraph` |
> | 5 | **Engines are pluggable (OCP).** A synthetic 6th engine works through core tools with zero edits to `src/session/*` or `src/tools/*`. | L1 | `engine-adapter-contract` keystone + `capabilities-ocp` unit fitness test | `pnpm test:arch` (and `pnpm test:keystone` for the contract lane) |
> | 6 | **Central lists are derived.** Every registered tool has a capability; SDK tool-types match the schemas; every `EngineKind` has a `CAPABILITIES` row. | L2/L9 | completeness + traceability fitness tests | `pnpm test:arch` |
> | 7 | **Budgets, not vibes.** File-size / function-length / complexity / interface-member / duplication budgets. | L3/L4/L7 | `eslint` budget rules + `jscpd` duplication budget | `pnpm lint` |
> | 8 | **Boundary types narrowed.** Untyped wire/config/CDP data is narrowed at the edge; no `any` past it. | L6 | the five `no-unsafe-*` rules + `no-explicit-any` (all `error`) | `pnpm lint` |
>
> **The meta-rule.** A guardrail may be relaxed only through an RFC amendment with
> rationale — never an inline `eslint-disable`, never a one-off budget bump in a
> feature PR. This is the same norm the `no-unsafe-*` enforcement already
> established. Re-baselining a budget *down* (tightening) as modules shrink is
> always welcome and needs no amendment.

A second, small edit to `code-quality.md` ties the new section into the existing PR-agent note. Under "Comments discipline" the doc already names `tracker-id-auditor` as the PR-time backup to its lint rule; add a parallel sentence at the end of the new Architecture-enforcement section:

> A PR-time `architecture-fitness-auditor` agent (see
> `.agents/skills/architecture-fitness-auditor.md`) runs the fitness lane,
> the dependency graph, and the budgets against the diff as a backup to the local
> gate — the macro-rule equivalent of `tracker-id-auditor`.

---

## 4. New doc — `docs/ai-context/architecture/fitness-functions.md`

This is the single map the parent RFC's D12 calls "the index of executable invariants." It exists so an agent can answer one question without reading the whole RFC suite: **"what will fail if I drift, and how do I run it?"** Every row is a real, runnable check; the table is the contract between the standard (§4a laws) and the test suite ([`0004-05`](../../rfcs/references/0004-05-fitness-functions-and-guardrails.md)). The full file:

> # Fitness functions — the executable architecture invariants
>
> An *architectural* characteristic browxai cares about gets an automated test that
> **fails when the characteristic regresses** — the evolutionary-architecture import
> at the heart of [RFC 0004](../../rfcs/0004-architecture-hardening.md). This page is
> the index: every fitness function, what it proves, where it lives, how to run it,
> and which law / decision it enforces. It is the answer to *"what breaks if my
> change is not as add-only as I think it is."* Read this before any change that
> moves a boundary; run `pnpm test:arch` before you assume it didn't.
>
> The architecture lane is **static and fast** — AST / dependency-graph / string
> analysis, no browser — and runs in `pnpm test`, not the keystone lane. The one
> exception is the `engine-adapter-contract` keystone, which exercises a synthetic
> in-memory engine through real core tools and runs in `pnpm test:keystone`.
>
> ## The map
>
> | Fitness function | What it proves | File | How to run | Enforces |
> |------------------|----------------|------|------------|----------|
> | `engine-adapter-contract` | A synthetic 6th engine, registered without editing `src/session/*` or `src/tools/*`, drives `navigate` / `snapshot` / `find` / `click`. A core tool that leaked engine logic fails here. | `test/keystone/engine-adapter-contract.keystone.test.ts` | `pnpm test:keystone` | L1 · [D1](../../rfcs/0004-architecture-hardening.md) |
> | `capabilities-ocp` | A synthetic capability + a tool needing it: the gate blocks when unset, allows when set — **without** touching `src/util/capabilities.ts`. Proves the gate is table-driven, not edit-driven. | `test/architecture/capabilities-ocp.test.ts` | `pnpm test:arch` | L1 · [D2](../../rfcs/0004-architecture-hardening.md) |
> | `tool-capability-completeness` | Every tool registered via `host.register` has an explicit capability (no silent `human` fallback); no stale entries for removed tools. | `test/architecture/capability-completeness.test.ts` | `pnpm test:arch` | L2/L9 · [D2](../../rfcs/0004-architecture-hardening.md) |
> | `engine-capability-completeness` | Every member of `EngineKind` has a `CAPABILITIES` const with the expected `EngineSubInterface` keys. A new engine missing its row fails fast instead of crashing the gate. | `test/architecture/engine-capability-completeness.test.ts` | `pnpm test:arch` | L2/L9 · [D1](../../rfcs/0004-architecture-hardening.md) |
> | `sdk-types-match-schemas` | The committed `sdk/tool-types.ts` equals the codegen output from the live registrations — hand-mirroring drift fails. | `test/architecture/sdk-types-drift.test.ts` | `pnpm test:arch` | L2 · [D7](../../rfcs/0004-architecture-hardening.md) |
> | `port-conformance` | Every substrate adapter (action / capture / storage / script / emulation), including a synthetic one, honors its port — no method throws unconditionally where the port promises a value. | `test/architecture/port-conformance.test.ts` | `pnpm test:arch` | L5 · [D5](../../rfcs/0004-architecture-hardening.md) |
> | `dependency-layering` | The forbidden-import graph holds (`tools/*` ⊥ `sdk/*`; `page/*` ⊥ adapter/transport; `sdk/*` ⊥ handler internals; only the bin imports `cli/*`). | `.dependency-cruiser.cjs` | `pnpm depgraph` | L4/L10 · [D10](../../rfcs/0004-architecture-hardening.md) |
> | `composition-root-guard` | `server.ts` ≤ 400 lines and imports no `src/page/*` directly (must go through `src/tools/*`). | `eslint.config.js` (`max-lines` override) + `.dependency-cruiser.cjs` | `pnpm lint` + `pnpm depgraph` | L3 · [D11](../../rfcs/0004-architecture-hardening.md) |
> | `module-budgets` | No tool module exceeds the size budget; no function exceeds length/complexity; no interface exceeds the member budget; no duplication beyond the `jscpd` threshold. | `eslint.config.js` budgets + `jscpd.json` | `pnpm lint` | L3/L4/L7 · [D11](../../rfcs/0004-architecture-hardening.md) |
> | `no-engine-literal-branches` | No handler branches on an engine literal outside the whitelisted substrate-select files. | `eslint.config.js` (custom rule) | `pnpm lint` | L1 · [D1](../../rfcs/0004-architecture-hardening.md) |
> | `no-inlined-capability-checks` | No handler inlines a capability check around the shared gate. | `eslint.config.js` (custom rule) | `pnpm lint` | L1 · [D2](../../rfcs/0004-architecture-hardening.md) |
> | `bounded-resource` | Every ring buffer, deadline, poll window, and recursion depth has an explicit, tested bound. | `test/architecture/bounded-resource.test.ts` | `pnpm test:arch` | L7 · [D11](../../rfcs/0004-architecture-hardening.md) |
> | `assertion-density` | The load-bearing modules carry the asserted invariants the standard requires (an `invariant()` density floor). | `test/architecture/assertion-density.test.ts` | `pnpm test:arch` | L8 |
>
> ## How to use this map
>
> - **Adding a tool?** `tool-capability-completeness` and `sdk-types-match-schemas`
>   are the two that fail if you forget the capability or let the SDK types drift.
>   You will not get a silent `human` fallback — the test names the missing tool.
> - **Adding an engine?** `engine-capability-completeness` fails fast if you forget
>   the `CAPABILITIES` row; `engine-adapter-contract` proves you did not need to edit
>   a session factory. If you found yourself editing `src/session/managed.ts`, the
>   registry pattern ([`../../rfcs/references/0004-03-ocp-registry-patterns.md`](../../rfcs/references/0004-03-ocp-registry-patterns.md))
>   is the seam you missed.
> - **Moving a boundary?** `dependency-layering` and `composition-root-guard` are the
>   gates. A new cross-layer import fails the graph; the message names the rule.
> - **Adding a substrate adapter?** `port-conformance` runs your adapter against the
>   same contract as every other. A method that throws where the port promises a
>   value (the Safari `page()` lesson) fails here, not in production.
>
> ## The meta-rule
>
> A fitness function is *frozen doctrine*. You do not edit it to make your change
> pass; you change your code. The only legitimate edits are: (a) a new function for a
> new invariant, (b) a budget tightened as modules shrink, (c) an RFC amendment that
> changes a law — with rationale recorded in [`../../rfcs/`](../../rfcs/). An inline
> disable of an architecture check is the one thing this file forbids outright.
>
> ## Related
>
> - [`architecture-principles.md`](architecture-principles.md) — §4a, the ten laws
>   these functions enforce.
> - [`../agent-process/code-quality.md`](../agent-process/code-quality.md) —
>   "Architecture enforcement," the guardrail-to-command table.
> - [`../../rfcs/0004-architecture-hardening.md`](../../rfcs/0004-architecture-hardening.md)
>   and [`references/0004-05-fitness-functions-and-guardrails.md`](../../rfcs/references/0004-05-fitness-functions-and-guardrails.md)
>   — the design record and the executable specs.

> Note on commands: `pnpm test:arch` (the fast architecture lane) and `pnpm depgraph`
> (dependency-cruiser) are introduced by [RFC 0004](../../rfcs/0004-architecture-hardening.md)
> P0 alongside the suite; before then, the lane runs under `pnpm test` and the graph
> under the cruiser binary directly. The script names are fixed here so the docs and
> the harness agree from the first commit.

---

## 5. `repo-map.md` — correct the stale map; add the new layers

The deep repo map predates the `src/tools/` decomposition. It still describes `server.ts` registering tools and lists `src/page/` as "per-tool handlers" with **no `src/tools/` layer at all** — yet the real composition seam is `ToolHost` in `src/tools/host.ts`, the per-family modules are `src/tools/*-tools.ts`, and `server.ts` is 382 lines of composition only. Three precise edits.

### 5.1 Rewrite the `src/server.ts` entry

The current text says a server-level concern "goes in `src/policy/` or `src/util/`." That is incomplete — tool registration goes through `src/tools/`. Replace the `### src/server.ts` block with:

> ### `src/server.ts`
>
> MCP server composition root. **Registry composition only — ~382 lines, no business
> logic.** It builds the shared `ToolHost` (via `src/tools/host-build.ts`) and hands
> it to each `registerXxxTools(host)` module under `src/tools/`. It does not touch
> a `src/page/*` handler directly — that path runs through the tool modules. Its
> 400-line ceiling is enforced (the composition-root guard, see
> [`fitness-functions.md`](fitness-functions.md)); a feature that needs a
> server-level concern adds a tool module or a `src/util/` helper, never inline
> logic here.

### 5.2 Add a new `src/tools/` entry

Insert a new subsection (between `### src/cli/` and `### src/page/`, the registration layer sitting above the handlers):

> ### `src/tools/`
>
> The per-family tool-registration layer and the composition seam between
> `server.ts` and the handlers. `host.ts` declares the `ToolHost` interface — the
> single seam `createServer` builds once and every `registerXxxTools(host)` module
> consumes; `host-build.ts` constructs it (closures, capability gate, the
> engine-selected substrate ports). The `*-tools.ts` modules own the
> `host.register(name, def, handler)` blocks per family
> (`read-observe-tools.ts`, `action-tools.ts`, `capture-report-tools.ts`,
> `storage-tools.ts`, `session-policy-tools.ts`, `gesture-network-tools.ts`,
> `emulation-config-tools.ts`, `deep-tools.ts`, `canvas-tools.ts`,
> `input-tools.ts`, `forms-recording-tools.ts`, `extensions-batch-tools.ts`,
> `plugin-runtime.ts`); `session-registry.ts` owns the `[ref=eN]` / session-entry
> registry. A new tool family is one new `*-tools.ts` module + one
> `registerXxxTools(host)` line in `server.ts` — composition stays one line longer,
> the existing families are untouched.
>
> `ToolHost` is a god-object today (75 members) and the engine-selected substrate
> selectors live in `host-build.ts` — both are targets of RFC 0004's segregation
> work ([D3](../../rfcs/0004-architecture-hardening.md),
> [D1](../../rfcs/0004-architecture-hardening.md)). Until that lands, the host's
> member-count budget is the guardrail that stops it growing further.

### 5.3 Add the engine layer and a fitness-functions pointer

The map has no `src/engine/` entry, yet that is where the multi-engine seam lives. Insert after the `src/session/` block:

> ### `src/engine/`
>
> The engine seam. `types.ts` declares `EngineKind`
> (`"chromium" | "firefox" | "webkit" | "android" | "safari"`) and the
> `EngineSubInterface` capability dimensions; `capabilities.ts` declares the
> per-engine `CAPABILITIES` consts (`CHROMIUM_CAPABILITIES`, …, `SAFARI_CAPABILITIES`)
> and `capabilitiesFor(engine)`; `tool-gate.ts` is the engine-dimension gate;
> `adapters/` holds the five real adapters (`playwright-chromium`, `playwright-firefox`,
> `playwright-webkit`, `android-cdp` + `adb`, `safari/` + `safaridriver-hybrid`).
> **The seam the doctrine grows along** — a new engine is a new adapter file plus a
> `CAPABILITIES` row plus a registry registration. RFC 0004's `EngineRegistry`
> ([D1](../../rfcs/0004-architecture-hardening.md)) collapses the session-factory
> wiring (`src/session/{managed,incognito,byob}.ts`, which today carry
> `if (engine === "<literal>")` chains) into one registration record so this is
> literally true.

And append a pointer to the map's footer (or create one if absent):

> ### Architecture enforcement
>
> The invariants this map's boundaries depend on are executable. See
> [`fitness-functions.md`](fitness-functions.md) for the index of every fitness
> function and `pnpm test:arch` to run the lane. Boundary changes verify against it.

---

## 6. `docs/rfcs/README.md` — register 0004; flag reference 03 as stale

Two edits to the RFC index. First, add the 0004 row to the Status table:

> | [0004](0004-architecture-hardening.md) | Architecture hardening — a safety-critical maintainability standard (SOLID/OCP refactor + fitness-function guardrails + AI-doc/harness enforcement) | Draft — proposal; evidence + specs in [references/](references/) (`0004-01`…`0004-08`). |

Second, the audit found `references/03-browxai-coupling-audit.md` cites `src/server.ts` at **12,889 lines, all 198 tool registrations** — a measurement that predates the `src/tools/` decomposition; `server.ts` is now ~382 lines and the registrations live in `src/tools/*-tools.ts`. We do not rewrite a historical reference (it is a faithful capture at its commit), but we add a correction pointer so a future reader is not misled. Add a note under the Status table:

> ## Reference corrections
>
> - [`references/03-browxai-coupling-audit.md`](references/03-browxai-coupling-audit.md)
>   was captured before the tool-registration decomposition. Its line counts are
>   accurate **as of its commit** but stale now: `src/server.ts` is ~382 lines
>   (composition only), and the 198 tool registrations live in `src/tools/*-tools.ts`
>   behind the `ToolHost` seam. Its coupling *map* (engine-agnostic vs. CDP-hard
>   substrates) remains valid and is the input to
>   [RFC 0004](0004-architecture-hardening.md)'s engine-seam work. For current
>   structure see [`../ai-context/architecture/repo-map.md`](../ai-context/architecture/repo-map.md).

While here, the "Adding an RFC" section should note the references convention 0004 introduced (a numbered RFC may carry a `references/NNNN-NN-*.md` companion suite); add one bullet:

> - A deep RFC may break its evidence, patterns, and specs into a companion suite
>   `references/NNNN-NN-<slug>.md` (see 0004's eight). The spine stays the decision
>   record; the references carry the depth.

---

## 7. `AGENTS.md` — point the cross-harness source of truth at the guardrails

`AGENTS.md` is the file every harness loads, and its "Expert agents" list is the registry every harness auto-discovers. Two edits keep it the single source of truth.

### 7.1 Add the new agent to the Expert-agents list

The current line reads *"Current agents: `tool-author`, … `tracker-id-auditor`."* Extend it:

> Current agents: `tool-author`, `plugin-author`, `keystone-writer`,
> `capability-gate-auditor`, `security-reviewer`, `docs-impact-auditor`,
> `release-engineer`, `tracker-id-auditor`, `architecture-fitness-auditor`.

### 7.2 Add an "Architecture enforcement" subsection after "Tool registration"

`AGENTS.md` already encodes the *tool-registration* contract (the 8-step list) and the *page-side-function pattern*. It should name the macro guardrails the same way — terse, with the command and the pointer — so an agent on any harness learns them from the file it always reads. Insert after the "Tool registration" section:

> ## Architecture enforcement
>
> The doctrine ([`docs/ai-context/architecture/architecture-principles.md`](docs/ai-context/architecture/architecture-principles.md)
> §4a) is **mechanized**: every architectural invariant has a fitness function, a
> custom lint rule, or a CI gate. Before a boundary, world-touching-surface, or
> engine change, the macro guardrails apply:
>
> - **Engines are pluggable.** A new engine is a new adapter + a `CAPABILITIES` row +
>   one registry registration — **never** an edit to `src/session/{managed,incognito,byob}.ts`
>   or a `engine === "<literal>"` branch in a handler. The `no-engine-literal-branches`
>   lint rule and the `engine-adapter-contract` keystone enforce it.
> - **Metadata is declared once.** Capability / batchable / deep live at
>   `host.register`, not in a hand-edited central list. The completeness fitness tests
>   enforce it.
> - **`server.ts` is composition-only**, under 400 lines, importing `src/tools/*` not
>   `src/page/*`. The dependency-cruiser layering gate enforces it.
> - **Run the lane.** `pnpm test:arch` (fast, static) plus `pnpm depgraph`
>   (dependency layering) are part of the quality gate for any boundary change.
>
> The single index of every check is
> [`docs/ai-context/architecture/fitness-functions.md`](docs/ai-context/architecture/fitness-functions.md).
> A guardrail is relaxed only via an RFC amendment, never an inline disable. The
> PR-time `architecture-fitness-auditor` agent re-runs the suite against the diff.

### 7.3 Add `pnpm test:arch` and `pnpm depgraph` to the quality-gate note

The "Quality gate contract" block lists the six gate commands. The architecture lane runs inside `pnpm test`, so the six-command list need not grow — but add a one-line clarification under it so an agent knows the lane exists:

> The architecture fitness lane (`pnpm test:arch`) and the dependency graph
> (`pnpm depgraph`) run inside `pnpm test` / `pnpm lint`; run them directly for fast
> feedback on a boundary change. See
> [`docs/ai-context/architecture/fitness-functions.md`](docs/ai-context/architecture/fitness-functions.md).

---

## 8. New agent skill — `.agents/skills/architecture-fitness-auditor.md`

The audit's diagnosis is that the micro rules have a PR-time backup agent (`tracker-id-auditor`) and the macro rules have none. We add the macro-rule counterpart, mirroring the existing pattern exactly: same frontmatter shape, same Workflow / Success-criteria / What-NOT-to-do skeleton, the cross-harness source of truth under `.agents/skills/` (the `.claude/agents/` and `.codex/agents/` mirrors follow the directory's stated convention). Full file:

```markdown
---
name: architecture-fitness-auditor
description: PR-time backup to the architecture fitness lane — runs the fitness suite, dependency-cruiser, and the size/complexity/duplication budgets against the diff, and reports drift against the ten laws in architecture-principles.md §4a.
model: claude-sonnet-4-7
tools: [Read, Bash, Grep, Glob]
---

# architecture-fitness-auditor

Runs at PR time on any diff that touches a boundary: `src/engine/**`,
`src/session/**`, `src/tools/**`, `src/page/**`, `src/sdk/**`, `src/cli/**`,
`eslint.config.js`, or `.dependency-cruiser.cjs`. The macro-rule counterpart of
`tracker-id-auditor` — it re-checks the architecture the local gate should already
have caught, and reports drift against the ten laws
(`docs/ai-context/architecture/architecture-principles.md` §4a). The full map of
checks is `docs/ai-context/architecture/fitness-functions.md`.

## Workflow

1. **Run the lane.** `pnpm test:arch` (the static fitness suite) and `pnpm depgraph`
   (dependency-cruiser layering). On the engine seam, also `pnpm test:keystone`
   filtered to `engine-adapter-contract`.
2. **Run the budgets.** `pnpm lint` — surface any `max-lines` / `complexity` /
   `max-lines-per-function` / interface-member / `jscpd` budget the diff crosses.
3. **Scan for the two anti-patterns the rules guard.** Confirm no new
   `engine === "<literal>"` branch landed above the engine seam outside the
   whitelisted substrate-select files (L1), and no new inlined capability check
   landed in `src/page/**` (L1/SRP). The lint rules are primary; this is the backup.
4. **Composition-root check.** `src/server.ts` is still ≤ 400 lines and imports no
   `src/page/*` directly.
5. **Completeness check.** Every tool added in the diff has a capability and (post
   tool-types codegen) a matching SDK type; a new `EngineKind` has a `CAPABILITIES`
   row. Report any silent `human` fallback.
6. **Report.** Per finding: the law violated (L1–L10), the failing check, the
   file:line, and the add-only fix (the registry/registration the change should have
   used instead of the edit). Map each to its row in `fitness-functions.md`.
7. **Block or warn.** A red fitness function or a crossed `error`-level budget →
   block. A warn-level budget or a borderline pattern → warn with the law cited.

## Success criteria

- `pnpm test:arch` and `pnpm depgraph` are green on the diff.
- No new engine-literal branch above the seam; no new inlined gate.
- Every new tool/engine is declared once and derived — no central-list hand-edit.
- `server.ts` stays composition-only and under budget.

## What NOT to do

- Do NOT approve a diff that adds an `engine === "<literal>"` branch to a handler or
  a session factory. The fix is the engine registry, not another branch.
- Do NOT accept an inline `eslint-disable` of an architecture rule or a one-off
  budget bump in a feature PR. A guardrail relaxes only via an RFC amendment.
- Do NOT treat a green unit suite as sufficient — the OCP failure modes are
  invisible at the unit level (a missing capability silently defaults to `human`).
  The fitness lane is the gate that catches them.

## Reference

- `docs/ai-context/architecture/fitness-functions.md` — the index of checks.
- `docs/ai-context/architecture/architecture-principles.md` — §4a, the ten laws.
- `docs/ai-context/agent-process/code-quality.md` — "Architecture enforcement."
- `docs/rfcs/0004-architecture-hardening.md` and
  `docs/rfcs/references/0004-05-fitness-functions-and-guardrails.md`.
```

The agent's relationship to the existing roster is deliberate: `capability-gate-auditor` checks the *capability lattice* (off-by-default, threat-model row, keystone denial) and `architecture-fitness-auditor` checks the *structural seams* (OCP, layering, budgets). They overlap on one cell — both care that a handler does not inline a gate — and that overlap is the point: it is the single most-cited SRP defect, worth two agents watching.

---

## 9. The harness skill — `driving-browxai/SKILL.md` references the seam, add-only

`harness/driving-browxai/SKILL.md` is the portable "drive browxai well" skill — the loop discipline (observe → locate → act → verify), capability gating, bounded waits. It teaches an agent to *use* browxai; it does not teach an agent to *extend* it. When an agent does extend (adds a tool, an engine, a substrate), it should learn the add-only seam from the skill it already loaded. Add a short "Extending browxai" section to the skill, pointing at the fitness map rather than restating it:

> ## Extending browxai (add-only)
>
> If your task adds a tool, an engine, or a substrate adapter rather than driving an
> existing one, the seams are **add-only** — you add a file at a known extension
> point; you do not edit the core. The contract:
>
> - **A new tool** = a `host.register(name, def, handler)` block in the right
>   `src/tools/*-tools.ts` family + a capability declaration + a keystone test.
>   `server.ts` is unchanged unless you added a new family (one `registerXxxTools`
>   line).
> - **A new engine** = a new `src/engine/adapters/*` adapter + a `CAPABILITIES` row +
>   one engine-registry registration. **Never** an `engine === "<literal>"` branch.
> - **A new substrate adapter** = an implementation of the existing port that passes
>   `port-conformance`. A method you cannot honor *declares the gap as a capability*;
>   it does not throw.
>
> Before you assume your change was add-only, run `pnpm test:arch`. The single map of
> what fails when you drift is
> [`docs/ai-context/architecture/fitness-functions.md`](../../docs/ai-context/architecture/fitness-functions.md);
> the laws it enforces are in `architecture-principles.md` §4a. An edit to a central
> list, a session factory, or `server.ts` business logic is the signal you missed a
> seam — find the registry the change should have used.

This keeps the skill's discipline (it stays a *driving* skill) while giving the extending agent a single pointer into the standard. The skill does **not** duplicate the fitness table — `AGENTS.md` is the source of truth, the skill is a pointer, exactly as the multi-harness auto-discovery contract requires.

---

## 10. The workflow / harness contract — a fitness gate in builder→reviewer

RFC 0003 (capability-ports decoupling) landed through a builder→reviewer multi-agent workflow: a builder agent implements a phase in a worktree, a reviewer agent checks the diff against the doctrine before merge. That pattern is how future multi-agent refactors will run — and it is exactly where architectural regression can slip in at scale, because each builder sees only its slice. The contract: **the reviewer's gate includes the fitness suite, and the suite is the non-negotiable floor.**

The builder→reviewer loop, with the fitness gate made explicit:

```text
builder (worktree, one phase)
  └─ implements add-only against the seam
  └─ local gate: pnpm typecheck && pnpm test && pnpm lint && pnpm build
  └─ fitness floor: pnpm test:arch && pnpm depgraph    ← must be green to hand off
        │
        ▼
reviewer (reads diff + runs the gate against the merge base)
  └─ architecture-fitness-auditor: pnpm test:arch, pnpm depgraph, budgets
  └─ maps any red to the violated law (L1–L10) and the add-only fix
  └─ BLOCKS the merge on a red fitness function — no "fix in a follow-up"
        │
        ▼
merge (only on green fitness lane)
```

Two rules make this hold for refactors specifically — and they are the load-bearing
reason P0 of the refactor plan lands the guardrails *first*:

- **The fitness lane is frozen before the refactor starts.** P0 lands the suite as
  failing-but-passing (it freezes the *current* maps) so every subsequent phase is
  verified against an invariant that existed before the phase. A builder cannot make
  its phase pass by loosening a fitness function — the reviewer treats any change to
  `test/architecture/**` or `.dependency-cruiser.cjs` in a *refactor* diff as a
  blocking finding requiring an RFC amendment, never a silent edit.
- **Behavior-preservation is the keystone lane; architecture-preservation is the
  fitness lane.** The five-engine keystones prove the refactor changed no external
  behavior; the fitness lane proves it did not regress a seam. A phase merges only
  when **both** are green. This is the structural answer to the parent RFC's risk
  "guardrails become noise / are disabled" — in a multi-agent refactor the reviewer,
  not the builder, owns the fitness lane, and the builder cannot disable what it does
  not own.

For a single-agent change the same contract degrades gracefully: the local gate plus
`pnpm test:arch` is the floor, and `architecture-fitness-auditor` is the PR-time
reviewer. The multi-agent and single-agent paths share one truth — **a red fitness
function blocks the merge, full stop.**

---

## 11. Docs-impact — a boundary change must update `fitness-functions.md`

`docs-impact.md` already requires that a public-surface change updates `tool-reference.md`, `threat-model.md`, the capability table, and `CHANGELOG.md` in the same diff. A *boundary* change has a new docs obligation: if it adds, moves, or removes an architectural seam, the index of executable invariants must reflect it. Extend the docs-impact checklist with a new clause.

Add to the "For a diff that touches discipline" group in `docs-impact.md`:

> For a diff that touches an **architectural boundary** (an engine seam, a substrate
> port, the tool-registration host, the dependency layering, a budget):
>
> - [ ] **`docs/ai-context/architecture/fitness-functions.md`** — if the diff adds a
>       new fitness function, changes how one is run, or changes which law it
>       enforces, the index row is updated **in the same diff**. A new seam with no
>       fitness row is a seam with no guard — the change is half-done.
> - [ ] **`docs/ai-context/architecture/architecture-principles.md`** §4a — if the
>       diff changes what a law guards or adds an enforcer, the law's enforcer column
>       is updated.
> - [ ] **`docs/ai-context/agent-process/code-quality.md`** — if the diff adds a
>       guardrail, the "Architecture enforcement" table gains its row + command.

And update the docs-impact-auditor pointer note so the PR agent knows to check the new surface. The doc's "Why this matters" section ends by naming `docs-impact-auditor` as the PR-time backup; append:

> A boundary change additionally hands off to `architecture-fitness-auditor`, which
> verifies the fitness lane is green *and* that a new seam carries its
> `fitness-functions.md` row — stale invariant indexes poison the next refactor the
> way stale public docs poison adopter integration.

This closes the loop the whole reference is built around: the standard ([§4a laws](#21-new-section--insert-after-4-before-5)) is enforced by the suite ([`0004-05`](../../rfcs/references/0004-05-fitness-functions-and-guardrails.md)), indexed by [`fitness-functions.md`](#4-new-doc--docsai-contextarchitecturefitness-functionsmd), taught by [`code-quality.md`](#3-code-qualitymd--add-architecture-enforcement--the-automated-guardrails) and [`AGENTS.md`](#7-agentsmd--point-the-cross-harness-source-of-truth-at-the-guardrails), re-checked by [`architecture-fitness-auditor`](#8-new-agent-skill--agentsskillsarchitecture-fitness-auditormd), gated in the [builder→reviewer workflow](#10-the-workflow--harness-contract--a-fitness-gate-in-builderreviewer), and **kept current by docs-impact** — so the next agent cannot add a seam without also adding its guard.

---

## 12. Summary of edits (the changelist this reference specifies)

| Target | Edit | Why (audit finding) |
|--------|------|---------------------|
| `architecture-principles.md` | New §4a (the ten laws + enforcer column); four machine-checked §7 checklist items; Related pointer to `fitness-functions.md`. | Macro rules documented but not tied to a machine; laws need a home in the doctrine (D8/D12). |
| `code-quality.md` | New "Architecture enforcement — the automated guardrails" section (8 guardrails × command); the meta-rule; the `architecture-fitness-auditor` note. | *"A future contributor reading code-quality.md will NOT learn the guardrails."* |
| `fitness-functions.md` *(new)* | The single index of every fitness function: what it proves, file, how to run, law/decision enforced; usage guide; meta-rule. | No map of "what fails if I drift" exists; D9/D12. |
| `repo-map.md` | Rewrite `server.ts` entry (~382 LOC, composition-only); add `src/tools/` and `src/engine/` entries; add fitness-functions pointer. | Map predates the `src/tools/` decomposition; stale. |
| `docs/rfcs/README.md` | Add the 0004 row; add a "Reference corrections" note flagging `references/03` (12,889-line `server.ts` is stale); note the references-suite convention. | *"Stale RFC reference document predates session factory refactor."* |
| `AGENTS.md` | Add `architecture-fitness-auditor` to the agents list; new "Architecture enforcement" subsection; quality-gate clarification. | Cross-harness source of truth must name the macro guardrails. |
| `.agents/skills/architecture-fitness-auditor.md` *(new)* | The PR-time macro-rule agent, mirroring `tracker-id-auditor`. | Micro rules have a backup agent; macro rules had none. |
| `driving-browxai/SKILL.md` | New "Extending browxai (add-only)" section pointing at the seam + fitness map. | The harness skill should route an extending agent to the standard, add-only. |
| `docs-impact.md` | New "architectural boundary" checklist clause requiring a `fitness-functions.md` update; auditor handoff note. | A boundary change with no fitness row is half-done. |

Every edit is text only — no `src/` change, consistent with the parent RFC's non-goals. The edits land in P5 of the refactor plan ([`0004-04`](../../rfcs/references/0004-04-refactor-plan.md)), *after* the suite they document exists, so no doc points at a check that is not yet runnable.

---

## Related

- [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) — the parent RFC; D12 is this reference's charter, §4a/the laws its content.
- [`0004-02-maintainability-standard.md`](0004-02-maintainability-standard.md) — the ten laws with full rationale and safety-critical lineage; this reference indexes their enforcers, that one derives them.
- [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md) — the `EngineRegistry` / metadata-at-registration patterns the docs above tell agents to use instead of editing the core.
- [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md) — the executable specs (lint rules, fitness tests, dependency-cruiser config, budgets); this reference is its documentation-and-harness counterpart.
- [`0004-04-refactor-plan.md`](0004-04-refactor-plan.md) — the phasing; these doc edits land in P5, after the suite exists.
- [`../../ai-context/architecture/architecture-principles.md`](../../ai-context/architecture/architecture-principles.md), [`../../ai-context/agent-process/code-quality.md`](../../ai-context/agent-process/code-quality.md), [`../../ai-context/architecture/repo-map.md`](../../ai-context/architecture/repo-map.md), [`../../ai-context/agent-process/docs-impact.md`](../../ai-context/agent-process/docs-impact.md) — the four existing docs this reference edits.
