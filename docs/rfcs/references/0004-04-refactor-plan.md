# RFC 0004 / Reference 04 — The phased refactor plan

**Parent:** [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) (the spine — thesis, ten laws L1–L10, decisions D1–D12).
This reference is the **execution plan**: how the decisions land, in what order, against what gates, with what proof of behavior-preservation, and how each phase reverts cleanly if it goes wrong.

## Abstract

This document sequences the D1–D12 decisions into six independently-shippable phases (P0–P5) under one rule that inverts the usual refactor instinct: **the guardrails land first.** P0 instruments the codebase — the fitness-function harness, the dependency graph, the budgets — *before* a single `src/` line moves, so every subsequent refactor is performed *against* frozen, machine-checked invariants and its behavior-preservation is mechanical rather than asserted. P1–P5 then strangle the five drifted seams (engine wiring, registration metadata, god-modules, the remaining switches, the assertion/bounded-resource pass) one at a time, promoting each guardrail from `warn` to `error` exactly when the seam it protects is closed. The five-engine keystone suite and the unit suite are the regression gate on every phase; no phase changes external behavior; every phase is a self-contained, revertible commit.

---

## 1. The philosophy: guardrail-first strangler-fig

### 1.1 Why guardrails before refactors

The audit's meta-finding ([`0004-01-current-state-audit.md`](0004-01-current-state-audit.md), theme T7) is that **all 80 structural defects were committed through a green gate.** There was no machine watching the macro layer, so the macro layer drifted. The naive response — "refactor the 80 defects, then add guardrails" — repeats the original mistake in miniature: it performs a large behavior-sensitive change with *no executable definition of the behavior being preserved*, and then bolts on the guardrails after the risky part is over. That is exactly backwards.

The discipline this plan adopts instead has two load-bearing properties:

1. **Instrument before operating.** P0 lands the entire enforcement layer — the fitness functions, `dependency-cruiser`, the size/complexity/duplication budgets, the `no-engine-literal-branches` lint rule — as **reporting-only** (warn) for the budgets and graph, and as **failing-but-frozen** for the completeness/traceability tests (they pass today against the *existing* hand-maintained maps; they simply lock those maps so a regression is loud). After P0, the architectural invariants are *executable*. Every refactor in P1–P5 is then a diff that must keep those checks green. The behavior-preservation argument stops being "we read it carefully" and becomes "the contract test still passes."

2. **Strangler-fig, not rewrite.** Per the parent RFC §3 and §7, the engine adapters, the capability substrates (the RFC 0003 ports), and the plugin runtime are *correct*; the defect is their **wiring**. So every phase replaces a wiring mechanism (an `if (engine === …)` chain, a hand-maintained `Set`, a god-module's grab-bag of concerns) with a registry/metadata-driven equivalent **behind the same observable surface**, deletes the old path only once the new one is proven, and never touches the parts that work. The new mechanism grows alongside the old until the old is fully strangled, at which point its removal is a no-op on behavior.

### 1.2 The same discipline RFC 0002 and 0003 already used

This is not a new methodology for browxai — it is the methodology that made the two prior structural RFCs safe, generalized from "behavior" to "architecture."

- **RFC 0002** ([`0002-multi-engine-bidi.md`](../0002-multi-engine-bidi.md)) introduced the `BrowserEngine` port and extracted today's behavior as `PlaywrightChromiumAdapter` with **zero behavior change** (P0), then grew Firefox/WebKit/Android as *new adapters* — each gate-green, each with the Chromium unit + keystone suites unchanged as the regression proof. P2a/P2b explicitly kept the Chromium CDP path *byte-identical* while routing only the off-Chromium engines through the new substrate, and proved the hot-path claim with a benchmark (`Δ 0.02 %`) rather than asserting it.
- **RFC 0003** decoupled `server.ts` from engine specifics via the capability substrates (`ActionSubstrate`, `CaptureSubstrate`, …), again landing the port first and migrating callers behind it without behavior change.

RFC 0004 takes the third step: where 0002 proved *behavior* with keystones and 0003 proved *decoupling* with the substrate ports, 0004 proves *the architecture itself* with fitness functions — and lands those fitness functions first, in P0, exactly as 0002 landed its port first in its own P0. The pattern catalogue those refactors target is [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md); the executable invariants are [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md); the standard each phase enforces is [`0004-02-maintainability-standard.md`](0004-02-maintainability-standard.md).

The single most reusable lesson from those two RFCs is the *byte-identity discipline*: RFC 0002's P2a/P2b kept the Chromium CDP path **verbatim** (`CdpSnapshotSubstrate` / `CdpNetworkSubstrate` are the old code moved behind an interface unchanged — "byte-identical, 71 Chromium keystones + 1663 unit tests unchanged") and routed only the *new* off-Chromium engines through the new path. RFC 0004 generalizes that rule to *every* phase: the mechanism being replaced (the `if`-chain, the hand-list, the god-module) is moved behind the new mechanism without altering what it produces; the proof is that the *output set is identical* (the same adapter instances, the same derived map, the same registered tool names), checked by a fitness test that pins the prior output as its oracle.

### 1.3 The behavior-preservation taxonomy

Because "byte-identical" is the load-bearing claim of every phase, the plan classifies each kind of change by *what proves it preserved behavior*, so the reviewer knows which assertion to look for rather than re-reading the diff:

- **Dispatch-relocation** (P1 engine registry, P4 switch→registry): the change swaps *how* a handler/adapter is selected, not *which* one is selected for a given input. Proof: a fitness test asserting the registry resolves the same target the `if`/`switch` did, plus the relevant keystone confirming the resolved target still drives a real session identically.
- **Map-derivation** (P2): the change replaces a hand-written list with a derived one. Proof: a *derived-equals-frozen* assertion against the P0 snapshot — the strongest available oracle, because it is the exact pre-change data.
- **Registration-move** (P3 god-module splits): the change moves `register(name, …)` calls between files without touching them. Proof: the registered-tool-name set is unchanged (a fast-lane assertion against `coreToolNames`, the snapshot `createServer` already takes at `server.ts:359`), plus per-family unit + keystone lanes.
- **Extraction-substitution** (P3 `PolicyRecordBuffer`/`actionTool`/`EgressSanitiser`, the `sample.ts`/`network.ts`/`extract.ts` dedup): the change replaces N copies with one shared abstraction. Proof: the existing per-instance unit tests (five policy tests, the action family's tests, the secrets-masking tests) run green against the shared abstraction — if the abstraction diverged from any copy, its test fails.
- **Assertion-addition** (P5 `invariant()`): the change adds checks that must be *no-ops on valid inputs*. Proof: the full unit + five-engine keystone suites run with no invariant firing, plus a property test for any bound (perf-audit token budget) that previously had none.

### 1.3 The per-phase contract

Every phase below is specified against the same fixed template so a future engineer or agent can execute it mechanically:

- **Goal** — the one architectural outcome.
- **Files edited** — the existing files that change, grounded in the audit's file:line evidence.
- **Files created** — the new files (registries, base classes, fitness tests).
- **Why this order** — the dependency on the prior phase.
- **Gate promotions** — which fitness functions / lint rules go `warn → error` this phase.
- **Behavior-preservation** — the exact keystone/unit that proves byte-identity.
- **Risk + rollback** — the failure mode and the single-commit revert.
- **Rough effort** — order-of-magnitude, from the audit's per-refactor estimates.

---

## 2. Phase-dependency diagram

```
                         ┌─────────────────────────────────────────┐
                         │  P0 — INSTRUMENT (no src/ behavior change)│
                         │  fitness harness · dep-cruiser · budgets  │
                         │  completeness/traceability frozen · lint  │
                         │  rules scoped to NEW violations           │
                         └─────────────────────┬─────────────────────┘
                                               │ (every later phase verified against P0)
              ┌────────────────────────────────┼────────────────────────────────┐
              ▼                                 ▼                                 ▼
   ┌────────────────────┐          ┌──────────────────────┐          ┌────────────────────┐
   │ P1 — EngineRegistry │          │  (independent of P1)  │          │  (independent)      │
   │  D1 + D5            │          │                        │          │                    │
   │  collapse 3 factory │          │                        │          │                    │
   │  chains + safari    │          │                        │          │                    │
   │  guards + selectors │          │                        │          │                    │
   │  close LSP leak     │          │                        │          │                    │
   └─────────┬──────────┘          │                        │          │                    │
             │ (engine seam closed) │                        │          │                    │
             ▼                      ▼                        │          │                    │
   ┌────────────────────┐  ┌────────────────────┐            │          │                    │
   │ P2 — metadata @ reg │  │ P3 — segregation   │◄───────────┘          │                    │
   │  D2 + D7            │  │  D3 + D4           │  (P3 §ToolHost split    │                    │
   │  colocate caps;     │  │  split god-modules;│   eases after P2       │                    │
   │  derive central     │  │  segregate ToolHost│   metadata exists)     │                    │
   │  maps; gen SDK types │  │  / SessionEntry;   │                       │                    │
   └─────────┬──────────┘  │  extract families  │                       │                    │
             │             └─────────┬──────────┘                       │                    │
             │                       │                                  ▼                    │
             └───────────┬───────────┘                       ┌────────────────────┐         │
                         ▼                                    │ P4 — switches +     │         │
              ┌────────────────────┐                          │  layering→error     │         │
              │ P5 — assert + bound │◄─────────────────────────┤  D6 + D10           │         │
              │  L7 + L8 + D12 docs │                          └────────────────────┘         │
              │  ship the standard  │                                                          │
              └────────────────────┘                                                          │
                                                                                              │
   Legend: P1 must precede P2 (metadata derivation keys off the registry-supplied             │
   engine record) and P3 (the substrate selectors fold into the registry). P2 should          │
   precede P3's ToolHost split (the segregated sub-ports consume the colocated metadata).      │
   P4 and P5 depend only on P0's harness + whichever budgets P3 promoted. ◄──────────────────────┘
```

The hard ordering constraint is **P0 → P1 → {P2, P3} → {P4, P5}**. P2 and P3 are sequenced (P2 first) but P3's non-ToolHost work (god-module splits, `PolicyBuffer`, `actionTool`, `EgressSanitiser`) is independent of P2 and can interleave. P4 and P5 are independent of each other; both depend only on P0 plus the budgets P3 promoted.

---

## 3. Phase → decision → finding → guardrail matrix

| Phase | Closes decisions | Closes audit findings (subsystem) | Promotes to `error` |
|-------|------------------|-----------------------------------|---------------------|
| **P0** | D8, D9, D10, D11, D12 (lands the *mechanism*) | none yet — *freezes* all (the meta-finding T7 itself) | completeness/traceability tests (frozen-pass); `no-engine-literal-branches` + `no-inlined-capability-checks` **scoped to new violations only** |
| **P1** | D1, D5 | engine-dispatch OCP (engine-adapters, session, tools-and-seam); Safari LSP leak (session, page-core); substrate-selector divergence (page-core) | `no-engine-literal-branches` (whole tree); port-conformance contract test |
| **P2** | D2, D7 | hand-maintained central lists (policy-util, tools-and-seam); `DEEP_TOOLS` checklist drift (engine-adapters); SDK tool-types hand-mirror (plugin-sdk) | completeness tests `frozen → derived`; SDK tool-types codegen drift test |
| **P3** | D3, D4 | god-modules `read-observe`/`capture-report`/`emulation-config`/`deep-tools` (tools-and-seam); `ToolHost`/`SessionEntry` god-objects; the 5 policy classes, the 7-step action pattern, egress masking, `sample.ts`/`network.ts`/`extract.ts` duplication (session, policy-util, page-features) | `max-lines` / `max-lines-per-function` / `complexity` budgets; interface-member budget; `jscpd` duplication budget |
| **P4** | D6, D10 | CLI/transport/analyser/mode switches (plugin-sdk, page-features, session); the layering the doctrine asserts but no machine checks (harness-and-docs) | `dependency-cruiser` layering rules `warn → error` |
| **P5** | (L7, L8 enforcers under D8/D9; D12 doc landing) | unbounded-resource + missing-invariant findings (page-features perf token-budget; the rings/deadlines/depth caps); the doc/discoverability gaps (harness-and-docs) | bounded-resource lint rule; assertion-density check on the load-bearing modules |

Every cell above is traceable to a finding in [`0004-01-current-state-audit.md`](0004-01-current-state-audit.md) and a target pattern in [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md).

---

## P0 — Instrument before operating

**Goal.** Make every architectural invariant *executable* without changing one line of `src/` runtime behavior. After P0, the codebase cannot drift further on the audited axes without a loud, local failure — and every subsequent phase has a machine-checked definition of "behavior preserved."

**Files created.**

- `test/architecture/**` — the fitness-function harness, a first-class part of `pnpm test` (static AST/graph/string analysis, no browser, fast lane). Initial suite:
  - `ocp-engine-contract.test.ts` — instantiates a synthetic 6th engine (a `MockEngineKind` fake conforming to `EngineCapabilities` from `src/engine/types.ts:68`) and asserts the core tool surface resolves against it; **expected to FAIL today** (it documents the gap that P1 closes — it is the executable form of the parent RFC's headline claim).
  - `tool-capability-completeness.test.ts` — asserts every registered tool name has a `TOOL_CAPABILITY` entry (`src/util/capabilities.ts:87`); passes today by *freezing* the 181-entry map against the live registration set, catching the audit's "silent fallback to `human`" gap (policy-util guardrail-gap #1).
  - `batch-allow-completeness.test.ts` — freezes `BATCH_ALLOWED_TOOLS` (`src/tools/host-build.ts:640–712`) against the registered set.
  - `deep-tools-engine-matrix.test.ts` — asserts every `DEEP_TOOLS` member (`src/engine/tool-gate.ts:38`) is refused on the non-deep engines and allowed on the deep ones, via `assertEngineSupports` (`tool-gate.ts:131`) — closing the engine-adapters guardrail-gap "no suite validates every `DEEP_TOOLS` entry is unavailable on Firefox/WebKit."
  - `port-conformance.test.ts` — runs the substrate ports (`ActionSubstrate`, `CaptureSubstrate`, `StorageSubstrate`, `ScriptSubstrate`, `EmulationSubstrate`) against *every* adapter incl. the synthetic one, asserting no port method throws unconditionally where the port promises a value (the L5 enforcer; documents the Safari `page()` throw that P1 relocates).
- `.dependency-cruiser.cjs` — the layering rules (D10) encoded **as `warn`**: `server.ts`/`tools/*` may not import `sdk/*` or `cli/*`; `page/*` may not import a concrete engine adapter or transport; `sdk/*` may not import handler internals; nothing imports `cli/*` except the bin.
- ESLint budget config additions (D11) **as `warn`**: `max-lines`, `max-lines-per-function`, `complexity`, sized from the *healthy current* modules (e.g. `src/engine/tool-gate.ts` at 145 LOC, `src/server.ts` at 382 LOC), not the god-modules.
- `jscpd` duplication budget **as reporting-only**.
- Two custom lint rules (`no-engine-literal-branches`, `no-inlined-capability-checks`) **scoped to new violations only** — they fail on a *newly added* `if (engine === "…")` or inlined capability check, but allowlist the existing sites (which P1/P2 remove). This stops the bleeding without blocking the tree on debt the later phases pay down.

**Files edited.** None in `src/`. Only `package.json` test/lint scripts, the ESLint config, and CI workflow to run `test/architecture/**` in the fast lane and `dependency-cruiser` in CI.

**Why this order.** It is the precondition for everything. P1–P5 are each "make a change that keeps these green"; if the checks do not exist, the phases have no objective definition of success.

**Gate promotions this phase.** Completeness/traceability tests land as **failing-but-passing-by-freezing** (they pass against today's maps and lock them). The budgets, graph, and `jscpd` land at **warn**. The two custom lint rules land at **error but new-violations-only**.

**Behavior-preservation.** Trivial — no `src/` change. The full unit suite + the five-engine keystone lanes (`headless`, `firefox`, `webkit`, `android`, `safari` — `test/keystone/*.keystone.test.ts`) run unchanged as proof that adding the harness perturbed nothing.

**Risk + rollback.** Risk is near-zero (additive tooling). The only real risk is a *flaky or slow* fitness test entering the fast lane; mitigated because every architecture test is static (no browser). Rollback: revert the single P0 commit — `src/` is untouched, so there is nothing to unwind.

**Rough effort.** ~3–4 days (harness scaffolding + the six initial fitness tests + dependency-cruiser config + budget calibration). Maps to the harness-and-docs `topRefactors` #2/#3/#4.

---

## P1 — The `EngineRegistry` (D1, D5)

**Goal.** Realize the parent RFC's headline: *a sixth engine is a single new file plus one registration line.* Today it requires editing 5–8 existing files. Collapse the triplicated engine-dispatch wiring and the scattered Safari guards into one `EngineRegistry`, and close the Safari LSP leak by making `page()` a *declared capability*, not an unconditional throw.

**Files edited (grounded in the audit).**

- `src/tools/session-registry.ts` — the worst offender. It carries the factory dispatch (`session-registry.ts:177–243`: the `if (mode === "attached") … else if (mode === "incognito") … else …` chain over `openByobSession`/`openIncognitoSession`/`openManagedSession`) **and** the scattered Safari guards: `sess.engine !== "safari"` recurs at `:266`, `:280`, `:292`, `:301`, `:332`, `:338`, `:349`, `:383`, `:408` (HAR/video/replay-HAR attach, console attach, browser-bridge attach, dialog-policy attach, confirm/fs-picker bridge wiring) — the 18-guard cluster the audit names. These become `EngineRegistry.postWire(sess, …)` calls keyed off `sess.engine`, with each engine's record owning its own post-creation steps.
- `src/session/managed.ts` (162 LOC), `src/session/incognito.ts` (133), `src/session/byob.ts` (216) — the three session factories. Their per-engine launch/attach branching collapses to a registry lookup (`registry.get(engine).makeAdapter(opts)`); the factories keep only their *mode* concern (persistent vs ephemeral vs attach), not the *engine* concern.
- `src/tools/host-build.ts` — the five substrate selectors `actionsFor` (`:288`), `captureFor` (`:301`), `storageFor` (`:318`), `scriptFor`, `emulationFor`. These already use capability detection (`e.session.safari?.()`) rather than name literals in the current tree — they are the *good* pattern — but the 5× identical `if (safariHandle) return new SafariXSubstrate(…); return new PlaywrightXSubstrate(…)` shape (the page-core audit's "5-line boilerplate repeated 5 identical times") folds into `EngineRegistry.makeSubstrates(session)`, so a new engine supplies one substrate-bundle factory instead of editing five closures.
- `src/engine/tool-gate.ts` — `assertEngineSupports` (`:131`) and `DEEP_TOOLS` (`:38`) stay (they are already capability-keyed, not engine-name-keyed — RFC 0002 proved this when WebKit auto-gated with zero `tool-gate.ts` edits, keying on `deep:false` rather than an engine name). P1 only routes the gate through the registry's capability record so the synthetic engine in the contract test is gated correctly. The `EngineCapabilities` shape it reads (`engine`, the `subInterfaces: ReadonlySet<EngineSubInterface>` over the nine sub-interfaces `lifecycle`/`navigation`/`snapshot`/`input`/`network`/`storage`/`script`/`emulation`/`capture`, and the `deep` flag — `types.ts:68–72`) is exactly what each `EngineRecord.capabilities` supplies, so the registry is a strict superset of today's capability declaration, not a parallel system.

**Files created.**

- `src/engine/registry.ts` — the `EngineRegistry`. Each engine registers, in *one* place, a record:

  ```ts
  import type { EngineKind, EngineCapabilities, EngineSession } from "./types.js";

  /** One engine's entire integration surface, declared in one file. Adding an
   *  engine = a new module that calls `registerEngine(record)` once; no edit to
   *  any session factory, the session registry, or host-build. */
  export interface EngineRecord {
    readonly kind: EngineKind;
    readonly capabilities: EngineCapabilities;        // src/engine/types.ts:68
    readonly makeAdapter: (opts: AdapterOptions) => Promise<EngineSession>;
    readonly makeSubstrates: (session: EngineSession) => SubstrateBundle;
    /** Post-creation wiring previously scattered as `sess.engine !== "safari"`
     *  guards across session-registry.ts — now owned by the engine that needs it. */
    readonly postWire: (ctx: PostWireContext) => Promise<void>;
  }

  const REGISTRY = new Map<EngineKind, EngineRecord>();
  export function registerEngine(r: EngineRecord): void { REGISTRY.set(r.kind, r); }
  export function engineRecord(kind: EngineKind): EngineRecord {
    const r = REGISTRY.get(kind);
    if (!r) throw new Error(`no EngineRecord registered for engine "${kind}"`);
    return r;
  }
  ```

- `src/engine/adapters/chromium.engine.ts`, `firefox.engine.ts`, `webkit.engine.ts`, `android.engine.ts`, `safari.engine.ts` — thin registration modules, each calling `registerEngine({ … })` for its already-existing adapter. No adapter *logic* moves; this is pure wiring relocation.

**The dispatch collapse, concretely.** The triplicated branch the audit names — present in spirit across the three factories and the session registry — reduces to a registry lookup. Before (the shape the audit found, e.g. the per-engine wiring inside the factories and the `sess.engine !== "safari"` post-creation guards in `session-registry.ts:266–408`):

```ts
// session-registry.ts (today) — engine literals leak into the wiring path
if (sess.engine !== "safari") {
  if (creationRecordHarResolved) await attachHar(sess.page().context(), …);
  await br.attach(sess.page().context());                 // browser-bridge
  attachDialogPolicy(sess.page().context(), dialogState);
  // … 15 more Playwright-only steps, each guarded `!== "safari"`
}
```

After (P1 — the engine owns its own post-wire; the registry has no engine literals):

```ts
// session-registry.ts (P1) — one call, engine-agnostic
import { engineRecord } from "../engine/registry.js";

await engineRecord(sess.engine).postWire({ sess, br, dialogState, /* … */ });

// safari.engine.ts — the no-Page engine simply omits the Playwright-only steps
registerEngine({
  kind: "safari",
  capabilities: SAFARI_CAPABILITIES,              // engine/capabilities.ts, deep:false
  makeAdapter: (opts) => openSafariSession(opts),
  makeSubstrates: (s) => safariSubstrateBundle(s),
  postWire: async ({ sess }) => {
    // BiDi log.entryAdded console bridge (the safari `bidi` branch from :305) —
    // and nothing Playwright-only. The throw in safari-session.ts:34 is never reached.
  },
});
```

The other four engines register the full Playwright `postWire`; the `!== "safari"` guard vanishes because the *absence* of a step is now an engine's own declaration, not a caller's branch.

**The Safari LSP fix (D5).** `src/session/safari-session.ts` makes `page()` throw `NO_PLAYWRIGHT_PAGE` unconditionally (`safari-session.ts:34–35`) — the Liskov violation that forced the 18 guards. Resolution per D5: callers reach the page only through the substrate ports (already the design intent post-RFC-0003); the residual direct `page()` reads are the bug. P1 makes the no-Page nature a *declared capability* on the engine record (the `subInterfaces` set already exists on `EngineCapabilities`, `types.ts:71`), and moves the 18 guards into `safari.engine.ts`'s `postWire` (which simply omits the Playwright-only steps). The `port-conformance.test.ts` from P0 then forbids any *new* unconditional-throw port method.

**Why this order.** First because it is the single highest-leverage refactor (it closes the most findings across the most subsystems: engine-adapters, session, tools-and-seam, page-core). Second because P2's metadata derivation and P3's substrate-selector fold both *key off* the registry record — P1 must supply it. Third because it is the one whose behavior-preservation is most directly proven by an existing asset (the five engine keystones), so doing it early maximizes confidence for the phases that follow.

**Gate promotions this phase.** `no-engine-literal-branches` goes from new-violations-only to **whole-tree `error`** (the existing literals are now gone). The `port-conformance.test.ts` goes from documenting-the-gap to **green and enforcing**. The `ocp-engine-contract.test.ts` (the engine-adapter-contract keystone) flips from **FAIL → PASS** — the synthetic 6th engine now works with zero core edits. That flip is the phase's headline deliverable.

**Behavior-preservation.** The five real engine keystones are byte-identical proof: `headless.keystone.test.ts` (Chromium), `firefox.keystone.test.ts`, `webkit.keystone.test.ts`, `android.keystone.test.ts`, `safari.keystone.test.ts` must pass unchanged. The registry is a pure indirection over the *same* adapter instances and the *same* post-wire steps — only the *dispatch mechanism* changes, so each engine's observable session is identical. The unit suite (session-registry, factory, gate tests) is the fast-lane backstop.

**Risk + rollback.** Risk: a post-wire step is reordered or dropped during the guard relocation (e.g. console-attach must precede dialog-policy attach). Mitigated by relocating guards *one engine at a time* with the keystone for that engine green before the next, and by `postWire` preserving the exact source order from `session-registry.ts`. Rollback: the registry is additive until the old chains are deleted in the final P1 commit; revert that commit to restore the `if`-chains. Each engine's registration is its own sub-commit, so a single bad engine reverts in isolation.

**Rough effort.** ~3–4 days (engine-adapters `topRefactors` "AdapterRegistry" at 2–3 days + the session-registry guard relocation at 1–2 days; session `topRefactors` #3/#4/#5 are the same work from the session subsystem's view).

---

## P2 — Metadata at registration; derive the central maps (D2, D7)

**Goal.** Kill the hand-maintained god-lists. A tool today is hand-added to up to five disjoint lists (`TOOL_CAPABILITY`, `BATCH_ALLOWED_TOOLS`, `DEEP_TOOLS`, the SDK tool-types, the docs) and every miss is silent. Replace this with **colocated declaration at `host.register`**, derive the central maps from the registrations, and generate the SDK types so they cannot drift.

**Files edited.**

- `src/tools/host.ts` — extend the `register` signature (`host.ts:60–64`). Today it is `register(name, { description, inputSchema }, handler)`. Add an optional metadata bag:

  ```ts
  register: <S extends z.ZodRawShape = Record<string, never>>(
    name: string,
    def: {
      description: string;
      inputSchema?: S;
      capability?: Capability;   // was a TOOL_CAPABILITY entry in capabilities.ts:87
      batchable?: boolean;       // was membership in BATCH_ALLOWED_TOOLS
      deep?: boolean;            // was membership in DEEP_TOOLS
    },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>,
  ) => void;
  ```

  The host accumulates the metadata into a derivation table as each `registerXxxTools(host)` module runs.
- `src/util/capabilities.ts` — `TOOL_CAPABILITY` (`:87`, 181 entries) becomes **derived** from the registrations rather than hand-listed; the type union `Capability` (`:17`, the 17-member closed vocabulary `read`/`navigation`/`action`/`human`/`eval`/`byob-attach`/`file-io`/`network-body`/`clipboard`/`secrets`/`extensions`/`stealth`/`captcha`/`credentials`/`device-emulation`/`diagnostics`/`canvas`) and `ALL_CAPABILITIES` (`:36`) stay as the closed vocabulary — the *names* are still declared once in the type system; only the *per-tool assignment* moves to the registration site. The orphan-capability and missing-entry gaps (policy-util guardrail-gaps #1, #2 — "a tool registered but missing from the map silently defaults to `human`"; "a capability in `ALL_CAPABILITIES` unused and orphaned") become impossible by construction: the derived map *is* the registration set, and a fitness test asserts every `ALL_CAPABILITIES` member is referenced by at least one registration.
- `src/tools/host-build.ts` — `BATCH_ALLOWED_TOOLS` (`:640–712`) is derived from `def.batchable`, not the 72-line literal `Set`.
- `src/engine/tool-gate.ts` — `DEEP_TOOLS` (`:38`) is derived from `def.deep`; this closes the engine-adapters finding "the gate is a manually-maintained checklist with zero automated regression prevention" — a new CDP-dependent tool now self-declares and auto-gates.
- `src/sdk/tool-types.ts` (673 LOC) — deleted as a hand-maintained file; replaced by a generated artifact (D7).
- The per-family modules' `register` calls (`src/tools/read-observe-tools.ts`, `action-tools.ts`, `deep-tools.ts`, …) gain the inline `{ capability, batchable, deep }` at each registration site. This is mechanical and colocated — the metadata lives next to the tool, which is the whole point.

**Files created.**

- `scripts/gen-sdk-tool-types.ts` — build-time codegen (D7) that reads the registrations (which now carry their zod schemas) and emits `src/sdk/tool-types.generated.ts` as `z.infer` of each `inputSchema`, identical to the inference the handlers already use.
- `test/architecture/sdk-tool-types-drift.test.ts` — fails if the committed generated file diverges from a fresh regeneration (the plugin-sdk guardrail-gap "no codegen test validates tool-types matches schemas").

**Why this order.** After P1, the registry exists, so the derivation has a single composition point to hang off (the host built in `host-build.ts`, handed to each `registerXxxTools`). Before P3, because P3's `ToolHost` segregation (the sub-ports a handler depends on à la carte) is cleaner when the per-tool metadata is already colocated — the segregated ports consume the declared metadata rather than reaching into central maps.

**Gate promotions this phase.** The completeness fitness tests from P0 flip from **frozen** to **derived**: `tool-capability-completeness.test.ts`, `batch-allow-completeness.test.ts`, and `deep-tools-engine-matrix.test.ts` now assert *the derived map equals the registration set* — a stronger invariant than the frozen snapshot, and one that cannot be satisfied by hand-editing. `sdk-tool-types-drift.test.ts` goes to **error**.

**Behavior-preservation.** The derived maps must be *element-identical* to the frozen P0 snapshots — that is the test. If `TOOL_CAPABILITY` derives to exactly the 181 entries P0 froze, the capability gate behaves identically; if `BATCH_ALLOWED_TOOLS` derives to the same set, `batch` behaves identically; if `DEEP_TOOLS` derives identically, the engine gate refuses identically (the five engine keystones confirm). The SDK types are proven identical by the drift test against the prior hand-written shapes (a one-time diff review during the cutover).

**Risk + rollback.** Risk: a registration omits a metadata field a tool needs (e.g. a deep tool not marked `deep`), silently widening its availability. Mitigated precisely by the *derived-equals-frozen* assertion — the P0 snapshot is the oracle, so any omission fails the completeness test loudly during P2 rather than at runtime. Rollback: the derivation reads from the same registrations; reverting the P2 commit restores the hand-maintained literals (kept until the cutover commit deletes them).

**Rough effort.** ~2–3 days (policy-util `topRefactors` "auto-derive TOOL_CAPABILITY" + tools-and-seam "metadata-driven BATCH_ALLOWED_TOOLS" at 1–2 days; the SDK codegen at ~1 day, plugin-sdk `topRefactors` #2).

---

## P3 — Module and object segregation; extract the families (D3, D4)

**Goal.** Bring the god-modules under the size budget, segregate the god-objects so consumers depend on the narrow port they use, and collapse the copy-paste families to shared abstractions — the SRP/ISP/DRY half of the refactor.

**Files edited — god-module splits (D3, SRP).**

- `src/tools/read-observe-tools.ts` (1965 LOC, 20+ tools: `snapshot`, `find`, `frames_list`, `text_search`, `extract`, `verify_*`, `screenshot`, `console_read`, `network_read`, `ws_read`, `inspect`, `point_probe`, `sample`, `watch`, `screenshot_marks`, `screenshot_region`, `generate_locator`) — split by cohesive concern toward one-family-per-module (DOM reads / assertions / extraction / buffer reads / capture-composition), per the tools-and-seam `topRefactors` "split god modules by SRP."
- `src/tools/capture-report-tools.ts` (1514 LOC), `src/tools/deep-tools.ts` (1033 LOC) — split by family.
- `src/tools/emulation-config-tools.ts` (1107 LOC) — split by *domain* (emulation / config / approvals / secrets / captcha), per D3's note that this module is itself heterogeneous.

Each split keeps the same `registerXxxTools(host)` shape and the same `register` calls (now with P2 metadata), so `server.ts` (the 382-line composition root) gains a handful of new `register*Tools(host)` lines (`server.ts:341–356`) and loses none — composition only, no business logic, exactly as architecture-principles §4 prescribes.

**Files edited — object segregation (D3, ISP).**

- `src/tools/host.ts` — `ToolHost` (the 75-member interface, `host.ts:54+`) is segregated into composable sub-ports a handler depends on à la carte. The members already cluster by role in the source (`register`/`gateCheck`/`engineGate`/`denyContent`; `entryFor`/`ctxFor`/`confirmCtxFor`; `actionsFor`/`asTarget`/`actionTimeout`/`asActionResultText`; `captureFor`; `storageFor`/`scriptFor`/`emulationFor`), so the split is a regrouping, not a redesign:

  ```ts
  /** A handler asks for exactly the sub-port it calls. `ToolHost` stays as the
   *  intersection the composition root assembles — `buildHost` returns one object
   *  that satisfies all of them — but a handler's signature narrows to its slice. */
  export interface GateHost {
    gateCheck: (toolName: string) => ToolResponse | null;
    engineGate: (toolName: string, e: SessionEntry) => ToolResponse | null;
    denyContent: (toolName: string, decision: { reason: string }) => ToolResponse;
  }
  export interface ActionHost {
    actionsFor: (e: SessionEntry) => ActionSubstrate;
    asTarget: (a: RawTargetArgs, tool: string, refs: RefRegistry) => ResolvedTarget;
    actionTimeout: (a: { timeoutMs?: number }) => { ms: number; warning?: string };
    asActionResultText: (p: Promise<unknown>) => Promise<ToolResponse>;
  }
  // SessionHost, CaptureHost, StorageHost, ScriptHost, EmulationHost likewise.
  export interface ToolHost extends GateHost, ActionHost, SessionHost,
    CaptureHost, StorageHost, ScriptHost, EmulationHost { register: …; }
  ```

  A `register*Tools(host: ActionHost & SessionHost)` signature then *compiles a guarantee* that the action family touches nothing else — the ISP win the tools-and-seam `topRefactors` "port interfaces" names, and the dependency-cruiser "ToolHost split" rule (L4) enforces it.
- `src/tools/session-registry.ts` + the session types — `SessionEntry` (the 50+-field god object) is segregated into the role-bundles its consumers use (engine-core vs policy vs feature concerns), per the session `topRefactors` #2 — tools depend on the sub-object, not the fat record.

**Files edited / created — family extractions (D4, DRY).**

- The five policy classes (dialog / permission / notification / fs-picker / device-emu) share an identical buffer+cap+record pattern. Extract `src/session/policy-buffer.ts` exporting `PolicyRecordBuffer<T>`; refactor the five to compose it (session `topRefactors` #1 — eliminates ~400 LOC, makes the bug surface 1 instead of 5).
- The 7-step action handler pattern (~50 sites) — extract `src/tools/action-tool.ts` exporting an `actionTool()` wrapper (tools-and-seam `topRefactors` "extract boilerplate wrappers" — ~50 % code cut on the action family).
- Egress masking (URL-sanitiser + secrets) is hand-called at each sink. Introduce `src/util/egress-sanitiser.ts` exporting `EgressSanitiser`, injected once into every output path (policy-util `topRefactors` "create EgressSanitiser abstraction" — turns caller discipline into a compile-time chokepoint; closes the page-features gap "no guardrail prevents returning `NetworkBuffer.iter()` without masking").
- `src/page/sample.ts` — centralize the duplicated metric dispatch: extract a `METRIC_READERS` lookup shared by `elementSampler` (`sample.ts:140`) and `windowSampler` (`:192`), collapsing the two `switch (p.metric)` blocks (`:145`, `:195`) so adding a metric is one edit, not two — closing the page-features silent-failure gap (a metric added to `ELEMENT_METRICS` at `:13` but missed in `windowSampler`).
- `src/page/network.ts` (1070 LOC) — route `NetworkTap.close()` and `NetworkBuffer.recent()` through the existing `foldInteresting` instead of the inlined noise-fold (page-features `topRefactors` #2).
- `src/page/extract.ts` (890 LOC) — extract a shared `treeSearch(tree, matcher)` combinator behind `scanTreeForCollection` and `scanTreeForBestMatch` (page-features `topRefactors` #4).

**Why this order.** After P1 (the substrate-selector fold removed one source of god-module bulk) and after P2 (the `ToolHost` segregation consumes the colocated metadata; the segregated handlers declare their capability inline). The family extractions are independent and can interleave, but the `ToolHost`/`SessionEntry` splits read cleanest once P2's metadata exists.

**Gate promotions this phase.** The size/complexity budgets (`max-lines`, `max-lines-per-function`, `complexity` — D11) flip `warn → error`: every god-module is now under the ~400-LOC tool-module ceiling and ~70-LOC / complexity-≤15 function ceiling. The interface-member budget (L4) flips to `error` against the segregated sub-ports. The `jscpd` duplication budget flips to `error` (the five-policy, action-pattern, and egress duplication is gone).

**Behavior-preservation.** Splitting a module that only *registers* tools is behavior-neutral by construction — the same `register(name, …)` calls run, just from more files; the full unit suite plus the five engine keystones confirm every tool still registers and behaves identically. The `PolicyRecordBuffer<T>` extraction is proven by the existing per-policy unit tests (dialog/permission/notification/fs-picker/device-emu) running green against the composed base. `actionTool()` is proven by the action-family unit + keystone (`headless`) tests. `EgressSanitiser` is proven by the secrets-masking + URL-sanitiser unit tests now exercising the single chokepoint. `sample.ts` is proven by `sample` unit tests asserting element and window paths produce identical series for shared metrics.

**Risk + rollback.** Risk: a god-module split accidentally changes registration *order*, perturbing the `coreToolNames` snapshot taken in `createServer` (`server.ts:359`). Mitigated by preserving the source order of `register` calls across the split and asserting the registered-name set is unchanged (a fast-lane test). Risk: the `EgressSanitiser` chokepoint misses a sink. Mitigated because the masking unit tests + the page-features guardrail (which P5 makes a lint rule) flag an unmasked egress. Rollback: each split is its own commit (one god-module per commit); each extraction is its own commit; any single one reverts independently.

**Rough effort.** ~5–7 days total (tools-and-seam "split god modules" at 4–5 days; the `PolicyRecordBuffer` + `actionTool` + `EgressSanitiser` extractions at ~1–2 days each, overlapping). The largest phase by LOC touched, the lowest-risk per-LOC (registration-only moves).

---

## P4 — The remaining switches (D6) and dependency layering to `error` (D10)

**Goal.** Replace every *extensibility* switch with an add-only registry, and turn the dependency-cruiser layering rules from `warn` to `error` so DIP rot is impossible.

**Files edited — switches → registries (D6).**

- `src/cli.ts` — the subcommand `switch (subcommand)` (`cli.ts:46`, cases `doctor`/`chrome`/`init`/`serve`/`plugin`/version/help) becomes a `Map<string, CommandHandler>` registered add-only (plugin-sdk `topRefactors` #1 — "highest-leverage OCP win: every new command becomes add-only").
- `src/plugin/cli.ts` — the inner `switch (sub)` (`plugin/cli.ts:503`, install/remove/list/info/upgrade/sync) becomes the same registry; and `PM_VERBS` (`:157`, the `Record<PackageManager, Record<PmOperation, string>>`) becomes a per-package-manager adapter so adding yarn is one `YarnAdapter` (plugin-sdk `topRefactors` #3 also splits this file's five concerns — LockStore / ConfigStore / PackageManagerAdapter / Installer / CLI — but the OCP-relevant part is the dispatch).
- `src/sdk/index.ts` — `createBrowxai`'s `switch (mode)` (`sdk/index.ts:206`, in-process/stdio-child/socket) becomes a `TransportFactory` registry (plugin-sdk `topRefactors` #4 — "new transports become add-only without modifying `createBrowxai`"). Note the `Transport` *port* is already proven (architecture-principles §1 cites the three transports); only the *selection* is a switch.
- `src/page/perf-audit.ts` — the stringly-typed trio: `ANALYSERS` (`:88`, `Record<AuditCategory, AuditCategoryAnalyser>`), the `AuditCategory` union (`:23`), and `ALL_AUDIT_CATEGORIES` (`:33`) collapse to a single `const ANALYSERS = { … } as const` from which the union and the array are *derived* (page-features `topRefactors` #3 — "adding a category is 1 edit, not 4; typos are compile-time errors"). This makes the perf-audit analyser registry — the doctrine's own cited OCP exemplar (architecture-principles §2) — actually exemplary, per D6.
- `src/util/config-store.ts` — the hard-coded precedence (`ConfigStore.apply` called four times in fixed order at `config-store.ts:177–180`, plus the `getLayer` switch at `:185`) becomes a data-driven layer-metadata array iterated in `resolve()` and `getLayer` (policy-util `topRefactors` "replace hard-coded `ConfigStore.apply` calls with a data-driven layer metadata array").
- The session-mode literals (`persistent`/`incognito`/`attached`) in `session-registry.ts:177–243` — if not already folded into P1's registry — become a `SessionFactoryProvider` registry (session `topRefactors` #3).

**Files created.**

- `src/cli/command-registry.ts`, `src/sdk/transport-registry.ts` — the add-only `Map`s.
- `test/architecture/no-extensibility-switch.test.ts` — a lint-style fitness test backing the plugin-sdk guardrail-gap "no linter rule prevents adding switch statements for extensibility."

**Why this order.** Independent of P2/P3 (these switches are in `cli`/`sdk`/`page`/`util`, not the tool seam), so it can run in parallel with P3. Sequenced after P0 (which landed dependency-cruiser at warn) so the layering promotion has its rules already in place and exercised.

**Gate promotions this phase.** The `dependency-cruiser` layering rules (D10) flip `warn → error` in CI — the single highest-leverage guardrail against DIP rot. `no-extensibility-switch.test.ts` goes to `error`.

**Behavior-preservation.** Each switch→registry is a pure dispatch swap: the CLI registry resolves the same handler the `case` did (CLI smoke tests + `browxai --help`/`doctor` behavior unchanged); the transport registry returns the same transport the `case` constructed (the `sdk.keystone.test.ts` lane proves all three transports still drive a session); the `perf-audit` `as const` derivation must produce a union and array *identical* to the hand-written ones (the `perf-audit.keystone.test.ts` lane + unit tests confirm every category still runs); the config-store layer array must apply in the *same precedence order* (config-store unit tests assert resolved values are unchanged for every layer combination). The dependency-cruiser promotion changes no runtime behavior — it only fails the build on a *future* bad import.

**Risk + rollback.** Risk: the config-store layer-array reorders precedence (env > user > project > session must be preserved). Mitigated by a config-store unit test that pins the resolved value for every layer permutation before and after. Risk: a dependency-cruiser rule, on promotion to error, surfaces a *pre-existing* legitimate import the warn phase tolerated — handled by tightening the rule with a documented allowlist entry (never an inline disable, per the L-meta rule). Rollback: each registry is its own commit; the dependency-cruiser promotion is a one-line config change reverted independently.

**Rough effort.** ~2–3 days (plugin-sdk `topRefactors` #1/#4 + page-features #3 + policy-util config-layer + the dependency-cruiser promotion at ~1 day, harness-and-docs `topRefactors` #4).

---

## P5 — Assertion density, bounded-resource pass, and the doc/harness landing (L7, L8, D12)

**Goal.** Add the safety-critical disciplines that have no current enforcer — assertion density (L8) and bounded-resource (L7) — on the load-bearing modules, audit the unbounded resources the page-features audit flagged, and *ship the standard*: the documentation and harness changes that make every guardrail discoverable by the next agent and exercised by the harness.

**Files edited — assertions + bounds.**

- The load-bearing modules — `src/page/actionresult.ts`, `src/page/network.ts`, `src/tools/host-build.ts`, `src/engine/registry.ts` (new in P1), `src/util/config-store.ts` — gain `invariant(...)` calls at their internal contracts (L8: a violated invariant surfaces as a structured refusal, never a crash or silent wrong answer — the fault-containment generalization of browxai's existing anti-wedge/structured-refusal pattern).
- `src/page/perf-audit.ts` — the token-budget algorithm the page-features audit flagged ("no safety bound or invariant: report size never exceeds 2.5× `SUMMARY_TOKEN_BUDGET`; a bad estimate could loop or pressure memory") gets an explicit, tested bound and a termination invariant (L7).
- The rings, deadlines, and depth caps (network buffer, console ring, watch poll window, recursion in the extract tree-walk and the canvas discovery) get explicit, *tested* bounds where they are implicit today (L7; architecture-principles §3's bounded-buffer discipline made executable).

**Files created.**

- `src/util/invariant.ts` — the `invariant(cond, msg)` helper that throws a structured, contained error (not a bare `assert`).
- `test/architecture/assertion-density.test.ts` — a density check on the load-bearing modules (L8 enforcer).
- `test/architecture/bounded-resource.test.ts` + the `no-unbounded-loop`/`no-unbounded-slurp` lint rule (L7 enforcer).
- `docs/ai-context/architecture/fitness-functions.md` — the index of every executable invariant: each lint rule, fitness test, dependency-cruiser rule, budget, and CI gate, with its law (L1–L10) and the finding it closes. This is the discoverability artifact (harness-and-docs `topRefactors` #5).

**Files edited — the doc/harness landing (D12).**

- `docs/ai-context/agent-process/code-quality.md` — gains an **"Architecture enforcement"** section listing every guardrail and its automated-check status, cross-linking the ESLint rules, the `test/architecture/**` suite, and the CI workflow (harness-and-docs `topRefactors` #5 — "high visibility/discoverability payoff").
- `docs/ai-context/architecture/architecture-principles.md` — its §7 review checklist gains the ten laws and their enforcers (D8); the doctrine is *extended, not replaced*.
- `docs/ai-context/architecture/repo-map.md` and the RFC index — corrected for the stale references the audit found (the coupling-audit reference still cites `server.ts` at 12,889 lines; it is now 382 — the composition-root refactor already landed).
- `.agents/skills/` — gains an `architecture-fitness-auditor` skill (mirroring the existing `tracker-id-auditor`) so a PR-time agent runs the fitness suite and reports violations.

**Why this order.** Last because it is the *capstone*: the assertion/bounded-resource pass touches modules that P1–P4 have already settled (asserting invariants on a registry that does not exist yet is premature), and the doc landing must describe the *final* state of all guardrails — `fitness-functions.md` is only accurate once P0–P4's checks are all in place and promoted.

**Gate promotions this phase.** The bounded-resource lint rule and the assertion-density check go to `error` on the load-bearing modules. With this, *every* law L1–L10 has a green enforcer — the standard is fully mechanized, which is the parent RFC's definition of done.

**Behavior-preservation.** Adding `invariant()` calls is behavior-preserving by definition when the invariants hold (they assert what the code already guarantees); the full unit + five-engine keystone suites confirm none fire spuriously. The perf-audit bound is proven by a property test asserting termination and the `≤ 2.5× budget` ceiling on adversarial inputs. The doc/skill changes touch no `src/` runtime.

**Risk + rollback.** Risk: an `invariant()` is too strict and fires on a legitimate edge case, converting a previously-tolerated state into a refusal. Mitigated by asserting only contracts the code *already* depends on, and by the structured-refusal (not crash) failure mode containing the blast radius. Rollback: each module's invariant pass is its own commit; the doc landing is doc-only and reverts independently.

**Rough effort.** ~2–3 days (the invariant/bounded pass at ~1–2 days; the doc/skill landing at ~1 day, harness-and-docs `topRefactors` #5).

---

## 3.1 The gate ratchet: how `warn → error` is scheduled

The promotions in §3's last column are not cosmetic — they are the mechanism that makes the refactor *irreversible*. A guardrail at `warn` reports drift; a guardrail at `error` forbids it. The ratchet rule is: **a guardrail is promoted to `error` in the same phase that removes the last violation it would flag**, never before (it would block the tree on debt not yet paid) and never after (a gap between "debt cleared" and "gate closed" is a window for re-drift).

This couples each phase to its guardrail tightly:

- `no-engine-literal-branches` cannot go whole-tree `error` until P1 deletes the last `if (engine === …)` / `sess.engine !== "safari"` branch — so it is scoped to *new* violations in P0 and promoted in P1.
- The completeness tests cannot become *derived* assertions until P2 derives the maps — so they are *frozen* (still useful: they catch a hand-edit that desyncs the map from the registration set) in P0 and promoted in P2.
- The size/complexity/duplication budgets cannot go `error` until P3 splits the god-modules and extracts the families — so they report at `warn` from P0 (calibrated from healthy modules like `tool-gate.ts` at 145 LOC) and promote in P3.
- The dependency-cruiser layering rules cannot go `error` until the tree is clean of cross-layer imports — so they warn from P0 and promote in P4.
- The bounded-resource and assertion-density rules land and promote together in P5, on the modules the prior phases have already settled.

The L-meta rule (parent RFC §8) governs every promoted gate thereafter: a guardrail may only be relaxed via an RFC amendment with rationale — never an inline `eslint-disable` or a `.skip()`. This is the same norm the just-landed `no-unsafe-*` enforcement already established, generalized to the architecture layer.

## 4. Definition of done

### 4.1 Per-phase DoD

| Phase | Done when |
|-------|-----------|
| **P0** | `test/architecture/**` runs in the fast lane; dependency-cruiser + budgets + `jscpd` report at `warn`; completeness/traceability tests pass by freezing the current maps; the two custom lint rules fail on *new* violations only; `ocp-engine-contract.test.ts` exists and *fails* (documenting the gap); all unit + five engine keystones unchanged. |
| **P1** | `EngineRegistry` owns all engine dispatch + post-wire; zero `if (engine === …)` / `sess.engine !== "safari"` branches remain in `session-registry.ts`/`managed.ts`/`incognito.ts`/`byob.ts`/`host-build.ts`; `no-engine-literal-branches` at whole-tree `error`; `port-conformance.test.ts` green; **`ocp-engine-contract.test.ts` flips to PASS** (a synthetic 6th engine works with zero core edits); the Safari `page()` throw is contained in `safari.engine.ts` `postWire`; five engine keystones unchanged. |
| **P2** | `host.register` carries `{capability, batchable, deep}`; `TOOL_CAPABILITY`/`BATCH_ALLOWED_TOOLS`/`DEEP_TOOLS` are *derived* and element-identical to the P0 freeze; `sdk/tool-types.ts` is generated with a drift test at `error`; completeness tests promoted `frozen → derived`; five engine keystones unchanged. |
| **P3** | No tool module exceeds the ~400-LOC budget (`read-observe`/`capture-report`/`emulation-config`/`deep-tools` all split); `ToolHost`/`SessionEntry` segregated into role sub-ports; `PolicyRecordBuffer<T>`/`actionTool()`/`EgressSanitiser` extracted and consumed everywhere; size/complexity/interface-member/`jscpd` budgets at `error` with zero violations; registered-tool-name set unchanged; unit + five engine keystones unchanged. |
| **P4** | CLI/plugin-CLI/transport/perf-analyser/config-layer/session-mode switches are add-only registries; dependency-cruiser layering rules at `error`; `no-extensibility-switch.test.ts` at `error`; CLI/SDK/perf-audit/config behavior unchanged (keystones + unit). |
| **P5** | `invariant()` lands on the load-bearing modules with the density check at `error`; the perf-audit token-budget and the rings/deadlines/depth-caps have tested bounds with the bounded-resource rule at `error`; `fitness-functions.md` indexes every guardrail; `code-quality.md` + `architecture-principles.md` + `repo-map.md` + the RFC index updated; the `architecture-fitness-auditor` skill exists; unit + five engine keystones unchanged. |

### 4.2 Overall DoD

The RFC is *done* when **every law L1–L10 has a green enforcer and the whole architecture suite is green at `error` with zero violations**, specifically:

- All fitness functions in `test/architecture/**` green at `error` — including the **engine-adapter-contract keystone** (the synthetic 6th engine resolves the core tool surface with zero edits to any session factory, the session registry, `host-build`, or the tool-gate).
- The size / complexity / duplication / interface-member budgets at `error` with **zero violations** — every god-module split, every god-object segregated, every copy-paste family collapsed.
- The dependency-cruiser layering rules at `error` — the core depends inward; no `sdk`/`cli`/transport/engine-adapter leak.
- The `no-engine-literal-branches`, `no-inlined-capability-checks`, `no-extensibility-switch`, bounded-resource, and assertion-density rules at `error` (whole-tree).
- The SDK tool-types codegen drift test at `error`.
- **The 1834 unit tests + the five engine keystones (`headless`/`firefox`/`webkit`/`android`/`safari`) unchanged** across every phase — the regression spine that proves behavior was preserved end to end.
- The standard is *discoverable and exercised*: `fitness-functions.md`, the `code-quality.md` enforcement section, the extended `architecture-principles.md` checklist, and the `architecture-fitness-auditor` skill are all in place (D12).

The owner's acceptance test is the parent RFC's headline made executable: **a new engine is one file plus one registration line; a new tool self-declares its metadata at registration; a new transport/command/analyser/config-layer is add-only — and a violation of any of these is a red CI gate, not a code-review judgment call.**

---

## 5. What we are NOT doing (recap)

Per the parent RFC §3 non-goals, restated as the execution boundary so no phase scope-creeps:

- **No rewrite of the engine adapters.** `PlaywrightChromiumAdapter`/`Firefox`/`WebKit`/`AndroidCdp`/`Safari` and their logic are correct (RFC 0002 proved them). P1 relocates their *wiring* into the `EngineRegistry`; it does not touch their *behavior*.
- **No rewrite of the capability substrates.** The RFC 0003 ports (`ActionSubstrate`, `CaptureSubstrate`, `StorageSubstrate`, `ScriptSubstrate`, `EmulationSubstrate`, `SnapshotSubstrate`, `NetworkSubstrate`) are the right contract. P1 folds the five *selectors* into `makeSubstrates`; the substrate *implementations* are untouched.
- **No rewrite of the plugin runtime.** `PluginApi` (`registerTool`/`callTool`/`log`) is a proven dependency-inverted port (architecture-principles §1) and protocol-clean (the coupling audit confirms it holds no page/CDP handle). P2 unifies how core *and* plugin tools register metadata, but does not re-architect the runtime.
- **No behavior change.** Every phase is byte-identical per engine, proven by the five engine keystones + the unit suite on every commit. The Chromium CDP path stays verbatim (the same discipline RFC 0002 P2a/P2b held — Chromium byte-identical, only off-Chromium routed anew).
- **No speculative ports.** Per architecture-principles §1's proven-seam test, every registry this plan introduces has *multiple real implementations today* — 5 engines, 70+ batchable tools, 9 perf analysers, 3 transports, 5 CLI commands, 4 config layers. Where there is a single implementation today, the concrete code stays and the seam is added later. We import the *practices* (Power-of-Ten, fitness functions, levelization), never a generic framework.

---

## Related

- [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) — the parent RFC: thesis, the ten laws L1–L10, decisions D1–D12, and §6 phasing this document expands.
- [`0004-01-current-state-audit.md`](0004-01-current-state-audit.md) — the 80 findings, the OCP extension-scenario tables, and the six themes every phase here closes.
- [`0004-02-maintainability-standard.md`](0004-02-maintainability-standard.md) — the safety-critical standard each gate promotion enforces.
- [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md) — the before/after target patterns (`EngineRegistry`, metadata-at-registration, `PolicyRecordBuffer`, `actionTool`, `EgressSanitiser`) each phase lands.
- [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md) — the executable invariants and the `warn → error` promotion specs this plan schedules.
- [`0004-06-ai-documentation-and-harness.md`](0004-06-ai-documentation-and-harness.md) — the P5 doc/harness landing in full.
- Prior structural RFCs whose strangler-fig discipline this plan inherits: [`0002-multi-engine-bidi.md`](../0002-multi-engine-bidi.md) and its coupling audit [`03-browxai-coupling-audit.md`](03-browxai-coupling-audit.md).
