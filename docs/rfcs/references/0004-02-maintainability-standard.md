# RFC 0004 / Reference 02 — The browxai safety-critical maintainability standard

This is the standard the parent RFC ([`0004-architecture-hardening.md`](../0004-architecture-hardening.md)) adopts as binding in its decision D8: the ten browxai laws (L1–L10) made concrete, each traced to the safety-critical practice it adapts and to the executable enforcer that holds it true. The thesis is one sentence: **browxai's architecture stays maintainable not because its authors — human or agent — are disciplined, but because the discipline is mechanized.** Every law below either compiles to a fitness function, a lint rule, or a CI gate, or it is not in this standard. This document is the *why* and the *adaptation*; the *how* (the exact config and test code) is [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md), and the full citations are [`0004-07-prior-art-and-references.md`](0004-07-prior-art-and-references.md).

---

## 1. The reframing: the failure mode is architectural corruption

Safety-critical software — avionics, spacecraft, implantable medical devices, nuclear instrumentation — does not stay correct over decades because its engineers are more careful than ours. It stays correct because *carefulness is not on the critical path*. The relevant practices (surveyed in §2) all share one structural move: take a class of defect that human review demonstrably fails to catch under pressure, and convert it into a machine check that fails the build. The Power of Ten does not ask you to *remember* not to recurse unboundedly; it bans unbounded recursion and points a static analyzer at it. DO-178C does not ask you to *believe* the tests cover the requirements; it makes coverage a structural property you must exhibit. The discipline is real, but it lives in tooling, not in heroics.

browxai is not flight software. A wedged session is recoverable; a leaked secret is bad but not fatal; nobody dies. But the *shape* of the failure browxai must guard against is precisely analogous, and the audit ([`0004-01-current-state-audit.md`](0004-01-current-state-audit.md)) proves it. In C, the Power-of-Ten rules guard against **memory corruption and undefined behavior** — a class of defect that is invisible at the point of the edit, compounds silently, and surfaces far from its cause. In browxai, the analogous defect class is **architectural corruption**:

- A **god-module** — `read-observe-tools.ts` at 1965 LOC registering 20+ unrelated tools, `capture-report-tools.ts` at 1514, `emulation-config-tools.ts` at 1107 mixing device-emulation with `register_secret` and `solve_captcha`. Each edit looks local; the module's *reason to change* has quietly become "anything observation-shaped happened."
- An **engine-literal leak** — `if (engine === "safari")` and its siblings spread across `managed.ts`, `incognito.ts`, `byob.ts` (three engine-literal dispatch sites — `byob.ts` uses attach/refusal paths, not an identical chain), plus 17 scattered Safari guards in `session-registry.ts`, plus five `*For(e)` substrate selectors in `host-build.ts`. Each guard was a reasonable local patch; together they make the flagship claim *"a new engine is a new adapter"* false — a sixth engine touches 5–8 existing files.
- A **hand-edited central list** — `TOOL_CAPABILITY` (181 entries, `src/util/capabilities.ts:87-524`), `BATCH_ALLOWED_TOOLS` (71-entry Set, `src/tools/host-build.ts:640-712`), `DEEP_TOOLS` (`src/engine/tool-gate.ts:38-88`), the 673-line hand-mirrored `sdk/tool-types.ts`. Every one is a place where adding a tool requires editing a god-list, and every miss is *silent*: a tool absent from `TOOL_CAPABILITY` defaults to `human`; a tool absent from `DEEP_TOOLS` runs on Firefox and crashes mid-execution with an opaque error instead of refusing cleanly at registration.

These defects share the C-defect signature: invisible at the edit, compounding, surfacing far from the cause. And they share the C-defect remedy. The Power-of-Ten answer to memory corruption is "bound every buffer and let the analyzer prove it." The browxai answer to architectural corruption is the same move one layer up: **bound every extension point to add-only growth, and let a fitness function prove it.** That is the load-bearing import. The mechanization for architectural corruption is the fitness function (Ford/Parsons/Kua, 2017) — an automated test that fails when an architectural characteristic regresses — and the meta-finding of the audit (theme T7) is that browxai had *zero* of them. Every one of the 80 structural defects was committed through a green gate.

This standard does not soften any existing rule. It *extends* [`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md) (the macro doctrine) and [`code-quality.md`](../../ai-context/agent-process/code-quality.md) (the micro doctrine) — both still bind, in full, on every change — and adds the one thing they lacked: a machine that fails when they are violated. Where this document would restate them, it cross-references instead.

---

## 2. The lineage

The standard imports five bodies of practice. Each contributes a precise rule, not a vibe; the full citations and the deeper survey are in [`0004-07-prior-art-and-references.md`](0004-07-prior-art-and-references.md). The unifying thread across all five — the reason they belong in *one* standard rather than five borrowed slogans — is the single move named in §1: **convert a defect class that review fails to catch into a machine check that fails the build.** Each body of practice is that move applied to a different defect class.

**The Power of Ten (Holzmann, NASA/JPL Laboratory for Reliable Software, 2006).** Ten rules for safety-critical C, chosen because each is *mechanically checkable by a static analyzer at maximum strictness* — that selection criterion is the whole point, and it is why the Power of Ten succeeded where decades of "coding guideline" PDFs failed. The rules: simple control flow (no `goto`/`setjmp`, no recursion); all loops have a fixed upper bound a checker can prove; no dynamic memory allocation *after initialization*; functions short enough to fit on a page (≈60 lines); **assertion density of at least two per function**; declare data at the smallest possible scope; **check the return value of every non-void call**, and check the validity of every parameter; limit the preprocessor; restrict pointer use; and **compile clean with all warnings on under multiple static analyzers**. The context is JPL flight software — Mars rovers, deep-space probes — where a defect cannot be patched in the field and a single unbounded loop can strand a billion-dollar vehicle; the rules are deliberately *more* restrictive than general good practice because the cost of a missed defect is unbounded. browxai's adaptation keeps the *spirit-as-mechanization* — every rule is a checker, not a hope — and re-grounds each rule in the architectural-corruption failure mode rather than the memory-corruption one: bounded loops (rule 2) imports directly to bounded *extension points* (L1/L7); the allocation rule (rule 3) is *adapted*, not imported — a GC runtime cannot honor "no allocation after initialization" literally, so browxai's translation is "no unbounded allocation on the hot path"; assertion density → *invariant* density on load-bearing modules (L8); check every return → narrow every *boundary* value (L6); short functions → module/function budgets (L3). The translation is exact where it can be (rules 2, 4, 5, 7) and honestly adapted where the runtime differs (rule 3); the per-law table in §3 makes each mapping explicit.

**The JPL Institutional Coding Standard (2009).** The Power of Ten productionized into an institutional standard: ~30 rules organized by severity, *each bound to a specific static-analysis tool*, with a documented and *auditable* deviation process — a rule may be relaxed only with written rationale recorded against the deviation, never by an inline silent suppression. The institutional contribution beyond the Power of Ten is the *governance*: it answers "what happens when a rule must be broken" with a process, not a `// NOLINT`. browxai imports two things. First, the **warn → error layering**: a new guardrail lands as a warning (visible, non-blocking) before it is promoted to a blocking error, so the team is never surprised by a wall of failures (the parent RFC's P0 phase does exactly this). Second, and critically, the **deviation discipline**: a guardrail may be relaxed only via an RFC amendment with rationale, never an inline `eslint-disable`. This already matches browxai norms — the just-landed `no-unsafe-*` work established it, and `code-quality.md`'s zero-ignores rule already forbids unjustified suppressions — so the import is a formalization, not a new burden.

**DO-178C / NASA NPR 7150.2 traceability.** The airborne-software certification standard (DO-178C) and the NASA software-engineering requirements (NPR 7150.2) both make *traceability* a structural deliverable rather than a documentation chore: every requirement traces to code traces to a test, and coverage is a property you *exhibit* in a trace matrix, not a number you hope for. The certifying authority does not accept the sentence "we tested it" — it requires the artifact that *shows* every requirement is exercised and every line of code traces back to a requirement, because the experience of the field is that untraced coverage is imaginary coverage. The reason this matters for an MCP server is direct: browxai's most dangerous silent failure is a *coverage hole in the seam* — a world-touching tool with no denial test, an engine with no capability row, a deep tool outside the gate — and each is exactly the kind of gap a trace matrix surfaces and prose review misses. browxai imports this as L9: every world-touching tool ⇒ a capability declaration ⇒ a keystone denial test, *in the same change*; every engine ⇒ a capability row ⇒ a keystone lane. The seam's coverage becomes a structural property a fitness test *asserts*, not a convention reviewers police.

**Defense in depth / fault containment.** The reactor-and-airframe principle, from systems-safety engineering: a fault is *contained* at the boundary where it arises and surfaced as a defined, recoverable signal — never allowed to propagate as undefined behavior across the rest of the system. The canonical form is the containment barrier (a reactor's nested vessels, an aircraft's redundant hydraulics) where each layer catches what the previous let through, and no single fault cascades. The software analogue is the principle that a component returns a defined error code its caller checks, rather than corrupting shared state or aborting the process. browxai already embodies this in its anti-wedge deadline: `withDeadline` (`src/util/deadline.ts:64-72`) races every wedge-prone inner path (a hung `page.evaluate`, a wedged renderer, a stuck CDP `send`) against a timer and returns a `DeadlineError` whose message is an explicit, multi-branch *recovery playbook* (`src/util/deadline.ts:18-29` — retry once / discard-and-reopen the wedged session / raise the timeout for this one call) — a *structured refusal*, not a crash, and not a stall. That is fault containment exactly: the fault (a hung inner op) is contained at the deadline boundary and the agent is handed a recoverable signal. The standard generalizes that single, proven pattern into a law (L8): every internal fault — a violated invariant, an unsupported adapter method, an out-of-range parameter — surfaces as a structured refusal, never a crash or a silent wrong answer, through the same envelope.

**Building Evolutionary Architectures / fitness functions (Ford, Parsons, Kua, 2017).** The load-bearing import — the mechanism that makes the other four enforceable rather than aspirational. An *architectural fitness function* is an automated, objective test of an architectural *characteristic* you care about — coupling direction, module size, the open-closed property of a seam, the absence of an engine literal above the seam — that *fails the build when the characteristic regresses*. The insight the book contributes is that architecture is not a one-time decision captured in a diagram; it is a *characteristic of the running system that erodes continuously* unless something measures it on every change, exactly as a unit test measures behavior. This is the precise answer to the audit's meta-finding (theme T7): browxai's doctrine was excellent and its diagrams were accurate, but with zero fitness functions, the *characteristics* the diagrams asserted drifted the moment no human was watching — and an agent-driven, high-velocity codebase is one where no human is watching most of the time. Where flight software points a static analyzer at memory safety, browxai points a fitness function at architectural safety. The entire enforcer column of the ten-laws table is fitness functions, lint rules, and CI gates of this kind; without this import, the standard would be one more PDF the audit's evidence proves does not hold the line.

These five collapse into one rule per law. The summary, before the law-by-law treatment:

| Body of practice | Defect class it mechanizes against | browxai law(s) | Mechanism in browxai |
|---|---|---|---|
| Power of Ten | unbounded control flow, allocation, unchecked returns | L1, L3, L6, L7, L8 | bounded extension points, size/complexity budgets, boundary narrowing, bounded resources, invariant density |
| JPL Institutional Standard | silent rule-breaking; ungoverned deviation | (cross-cutting) | warn→error layering; deviation only via RFC amendment, never inline suppression |
| DO-178C / NPR 7150.2 | coverage holes in the seam | L9, L10 | tool↔capability↔keystone and engine↔caps↔lane trace fitness tests; keystone-verified determinism |
| Defense in depth / fault containment | uncontained fault propagation | L5, L8 | structured-refusal envelope; gate-before-dispatch, deadline-during, sanitiser-after |
| Fitness functions (Ford et al.) | continuous architectural erosion | all of L1–L10 | the executable enforcer column itself |

---

## 3. The ten laws

Each law follows the same shape: **(a)** the precise statement (from the parent RFC §4); **(b)** the safety-critical origin and *why that rule exists in flight software*; **(c)** the browxai failure mode it prevents, with audit evidence at file:line; **(d)** the TypeScript adaptation; **(e)** the enforcement, cross-linked to [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md). The laws are not independent — they form a dependency chain: L4 (segregated contracts) is what *makes* L5 (substitutable adapters) achievable, because a port that over-promises forces an adapter to lie; L2 (single source of truth) is what *makes* L9 (traceability) a derivation rather than a chore, because you can only trace what is declared once; L1 (closed core) is the keystone the whole refactor turns on. The worked-rationale clauses below note these couplings where they bind.

At a glance — the same ten laws as the parent RFC §4, indexed to the lineage and the failure mode this document expands:

| Law | One-line | Lineage | Worst browxai evidence |
|-----|----------|---------|------------------------|
| **L1** Closed core | no engine/transport/adapter literal above the seam; extension is add-only | Power-of-Ten rule 1; OCP | `managed.ts`/`incognito.ts`/`byob.ts` engine-literal dispatch sites; 17 Safari guards in `session-registry.ts` |
| **L2** Single source of truth | declare a fact once, derive it everywhere | DRY; DO-178C config-data | `TOOL_CAPABILITY` (181), `DEEP_TOOLS`, hand-mirrored `sdk/tool-types.ts` (673 LOC) |
| **L3** One reason to change | one module/object, one responsibility; hard size/complexity budgets | Power-of-Ten rule 4; Parnas | `read-observe-tools.ts` (1965 LOC, 20+ tools) |
| **L4** Segregated contracts | depend on the narrow port, not the 35-member bag | ISP; Lakos | `ToolHost` (35 members); `SessionEntry` (40 fields) |
| **L5** Substitutable adapters | honor the port or declare the gap; never throw where a value is promised | LSP; fault containment | `BrowserSession.page()` throws on Safari → 17 guards |
| **L6** Validate at the edge | narrow untyped data once at the boundary; trust within | Power-of-Ten rule 7; `no-unsafe-*` | the landed `no-unsafe-*` + `z.infer` typing (exemplar); egress hand-call gap |
| **L7** Bounded everything | every loop/buffer/ring/recursion/wait has an explicit, tested bound | Power-of-Ten rule 2 (direct); rule 3 (adapted); principles §3 | strong inventory; `perf-audit` unbounded `while`, undeclared walk depth |
| **L8** Assert the invariants | assert internal invariants; a violation is a structured refusal, never a crash | Power-of-Ten rule 5; fault containment | `DeadlineError` exemplar; no uniform `invariant()` / density |
| **L9** Traceable | tool↔capability↔keystone and engine↔caps↔lane are structural coverage | DO-178C / NPR-7150.2 | no completeness test; silent `DEEP_TOOLS` drift |
| **L10** Deterministic & observable | deterministic where it pays; keystone-verified, not asserted | DO-178C reproducibility | new seams must not break replay |

### L1 — Closed core

**(a) Statement.** No module above the engine seam may name an engine, a transport, or a concrete adapter. Extension is add-only: a new engine is a new file plus one registration line, with zero edits to existing core files.

**(b) Safety-critical origin.** Power-of-Ten rule 1 — *simple, predictable control flow*. Flight software bans `goto` and unbounded branching not for elegance but because a control-flow graph a human (and a model checker) can fully enumerate is one where every path is reachable, testable, and free of the surprise transition that strands a vehicle. An `if (engine === …)` chain scattered across a codebase is the architectural form of the same hazard: the set of reachable wiring paths is no longer enumerable from one place, and the "add an engine" path is *never exercised by any test* until it fails in production.

**(c) browxai failure mode.** The audit's most severe theme. Adapter *instantiation* is hardcoded `if-else` over `EngineKind` literals at three engine-literal dispatch sites — `src/session/managed.ts:109-120`, `src/session/incognito.ts:89-112`, `src/session/byob.ts:154-196` — the managed/incognito factories run a Playwright launch chain (`new PlaywrightFirefoxAdapter()` / `new PlaywrightWebKitAdapter()` / else Chromium), while `byob.ts` is *not* an identical chain — it dispatches over attach/refusal paths (`openAndroidByobSession`, attach adapters). Post-creation wiring scatters 17 Safari guards through `src/tools/session-registry.ts` (lines 266, 280, 292, 301, 332, 338, 349, 383, 408, 441, 451, 457, 479, 536, 550, 584, 589), each `if (sess.engine !== "safari")` before attaching console/HAR/video/dialog/permission/notification/fs-picker/downloads/stealth. Five substrate selectors in `src/tools/host-build.ts:288-357` repeat the same engine branch verbatim. The flagship claim of `architecture-principles.md` §4 — *"new engine = new adapter behind the existing port"* — is **false today**: a sixth engine edits 5–8 existing files.

**(d) TypeScript adaptation.** Collapse all engine-literal dispatch behind one `EngineRegistry` keyed by `EngineKind`, where each engine declares its wiring in *one* record and the factories/selectors/gate become data-driven lookups (the full pattern is D1 in [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md)). The law forbids the *literal* above the seam; the registry record itself is the one sanctioned place an engine name appears.

```ts
// The only file allowed to name an engine. Every other module above the seam
// resolves wiring through the registry, never by branching on session.engine.
interface EngineEntry {
  readonly kind: EngineKind; // "chromium" | "firefox" | "webkit" | "android" | "safari"
  readonly capabilities: EngineCapabilities;
  makeAdapter(opts: SessionOptions): Promise<BrowserSession>;
  makeSubstrates(): SubstrateBundle;
  postWire(entry: SessionEntry): void; // the 17 ex-Safari guards live here, once
}
const ENGINE_REGISTRY = new Map<EngineKind, EngineEntry>();
```

**(e) Enforcement.** A custom lint rule `no-engine-literal-branches` flags `if (engine === "<literal>")` / `session.engine === …` outside the registry and the two sanctioned substrate selectors, plus the **engine-adapter-contract keystone**: a synthetic sixth engine registered through `ENGINE_REGISTRY` alone must make the standard tool surface work with *zero* edits to any core file. The rule lands scoped-to-new-violations first, then promotes to `error` once the registry exists. The audit confirmed neither exists today: `eslint.config.js:110-111` defines only `no-tracker-ids-in-comments` and `no-page-eval-stringified-arrow`.

**(f) Why this is the keystone.** L1 is the law the entire refactor turns on, for two reasons. First, it is the law with the most leverage: the single `EngineRegistry` change closes the audit's most severe theme (T1) and dissolves the L5 LSP leak in the same move (the 17 Safari guards become one `postWire`). Second, the engine-adapter-contract keystone is the *only* test in the standard that exercises the runtime — every other fitness function is static AST/graph analysis — and it is the one that converts the flagship doctrine claim from documented-but-false to mechanically-true. The distinction matters: a lint rule proves *no new* engine literal is added; the keystone proves a *new engine actually works* with zero core edits. Both are required, because the lint rule can be satisfied by a registry that is incomplete, and the keystone can pass while a literal lurks in a path the synthetic engine does not exercise. They are complementary, not redundant — the defense-in-depth principle (§4.4) applied to the guardrails themselves.

### L2 — Single source of truth

**(a) Statement.** No fact is written twice. Capabilities, batchability, deep-ness, tool-types, and layer precedence are *declared once* at the unit and *derived* — never hand-listed in a parallel central register.

**(b) Safety-critical origin.** DRY, and the DO-178C discipline for *configuration data*: a parameter that controls behavior is defined in exactly one place and consumed everywhere, because a value duplicated across two tables that must agree is a latent divergence that no review reliably catches. The JPL standard treats a hand-maintained mirror of a generated artifact as a defect by construction.

**(c) browxai failure mode.** A new tool today must be hand-added to up to five disjoint registers, each miss silent: `TOOL_CAPABILITY` (`src/util/capabilities.ts:87-524`, 181 entries, defaults to `human` on omission), `BATCH_ALLOWED_TOOLS` (`src/tools/host-build.ts:640-712`), `DEEP_TOOLS` (`src/engine/tool-gate.ts:38-88`), the 673-LOC hand-mirrored `src/sdk/tool-types.ts` (which *admits in its own header* that the zod schemas are the source of truth), and `ALL_CAPABILITIES` / `ALL_CONFIRM_HOOKS` (`src/util/capabilities.ts:36-54, 589-594`). The `tool-types.ts` file is the purest instance: a hand-written mirror of a generated truth, guaranteed to drift.

**(d) TypeScript adaptation.** Colocate the metadata at registration. The host's `register` already types the handler's `args` from the tool's own zod `inputSchema` (`src/tools/host.ts:60-64` — `register: <S extends z.ZodRawShape>(name, def: { description; inputSchema?: S }, handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResponse>)`); extend `def` to carry `{ capability, batchable, deep }` and *derive* the four central maps from the registrations. The SDK types are generated from the same registrations, not hand-mirrored (D7).

```ts
host.register(
  "network_body",
  {
    description: "…",
    inputSchema: networkBodyShape,
    capability: "network-body", // was: a line in TOOL_CAPABILITY
    batchable: false,           // was: presence/absence in BATCH_ALLOWED_TOOLS
    deep: true,                 // was: a line in DEEP_TOOLS
  },
  async (args) => { /* args: z.infer<typeof zNetworkBody> */ },
);
```

**(e) Enforcement.** Completeness fitness tests: every registered tool has a derived capability (no silent `human` default by omission); the derived batch/deep sets equal the registrations; the committed `sdk/tool-types.ts` is byte-identical to the regenerated output or the test fails. The audit confirmed none of these exists — there is no test that "every registered tool has a `TOOL_CAPABILITY` entry" or "no stale entries remain."

### L3 — One reason to change

**(a) Statement.** One module, one responsibility; one object, one role. Hard budgets: a tool module ≤ ~400 LOC, `server.ts` ≤ 400, a function ≤ ~70 LOC / cyclomatic complexity ≤ ~15.

**(b) Safety-critical origin.** Power-of-Ten rule 4 — *no function longer than ~60 lines* (one printed page) — plus Parnas's information-hiding: a unit you cannot see in one screen is a unit whose invariants you cannot hold in your head, and a unit with two reasons to change is two units sharing a lock. Flight software enforces the line budget mechanically precisely because "keep functions short" as advice does not survive schedule pressure.

**(c) browxai failure mode.** The god-modules: `read-observe-tools.ts` (1965 LOC, 20+ tools — snapshot, find, frames_list, text_search, extract, verify_\*, screenshot, console_read, network_read, ws_read, inspect, point_probe, sample, watch, …), `capture-report-tools.ts` (1514, 21 concerns), `emulation-config-tools.ts` (1107, mixing device-emulation with `register_secret` / `solve_captcha`), `deep-tools.ts` (1033). These are an artifact of an earlier line-range decomposition, explicitly flagged as "thematically loose" at the time; they violate the doctrine's own one-tool-one-file rule (`code-quality.md` SOLID §). And `server.ts` is documented as "registry composition only" (`repo-map.md`, `code-quality.md`) but nothing prevents a 200-line helper creeping inline — there is no size budget on it.

**(d) TypeScript adaptation.** Split by cohesive concern toward one-family-per-module (D3); `server.ts` stays a composition root. The budget is a *number*, sized from the current healthy modules (a single `src/page/<tool>.ts` handler), not from the god-modules.

**(e) Enforcement.** ESLint `max-lines` (per module), `max-lines-per-function`, and `complexity` budgets at `error`, plus the **composition-root guard** — a hard line ceiling on `server.ts` (the parent RFC sets 400) that fails the build on business-logic creep. The audit confirmed `server.ts` has "NO file-size budget, complexity check, or import-depth guard."

**(f) Why the budget is a number, not a vibe.** The objection to size budgets is that they are arbitrary — why 400 and not 380 or 450? The answer is the JPL discipline: the budget is *calibrated from the current healthy code*, not chosen aesthetically. A single well-formed `src/page/<tool>.ts` handler establishes the natural size of one cohesive unit; the budget is set just above that, so the god-modules fail and the healthy modules pass on day one. This is the critical sizing rule that keeps the guardrail signal rather than noise: a budget sized from the *god-modules* would permit the rot it is meant to prevent, and a budget sized aspirationally below the healthy modules would flag good code and get disabled. The number is empirical, and it ratchets — once the refactor brings the god-modules under it, the budget never rises again (D11). The same calibration logic governs the complexity and member-count budgets of L4: measure the healthy unit, set the budget just above it, ratchet.

### L4 — Segregated contracts

**(a) Statement.** No god-object. A consumer depends on the narrow port it actually uses, not a 35-member bag.

**(b) Safety-critical origin.** ISP, and Lakos's levelization: a wide interface is a wide coupling surface, and every member a consumer *can* call but *should not* is a path to an unintended dependency. Large-scale C++ design treats the size of a component's public surface as a first-class metric because compile-time and reasoning cost both scale with it.

**(c) browxai failure mode.** `ToolHost` is a 35-member interface (`src/tools/host.ts:54-189`) where a typical handler uses 8–12 members; adding a helper forces an edit to the interface and to every destructuring site. `SessionEntry` is a god-object with 40 fields (`src/session/registry.ts:48-224` — session, refs, two substrates, frames, console, network, ws, workers, bridge, recorder, clipboard, routes, regions, emulation, clock, perf, coverage, wedge, metrics, five policy buffers, har, video, secrets, extensions, …), several of which are mode-conditional (`launchProfile?` is persistent-mode-only, `src/session/registry.ts:206`). The `ActionSubstrate` port itself over-promises: 12 methods (`src/page/action-substrate.ts:35-49`) of which `SafariActionSubstrate` genuinely implements 4 and stubs 8 with `safariUnsupportedAction(…)` (`src/page/action-substrate.ts:124-147`) — an ISP failure that *forces* the L5 LSP failure.

**(d) TypeScript adaptation.** Segregate `ToolHost` into composable sub-ports a handler depends on à la carte (`GateHost`, `SessionHost`, `ActionHost`, …) and `SessionEntry` into the role-bundles its consumers actually use (D3). The substrate ports narrow so an adapter implements only what its engine supports — see L5.

**(e) Enforcement.** An interface-member-count budget at `error` and a `dependency-cruiser` rule encoding the `ToolHost` split (the segregated sub-ports may be imported; the fat bag may not be reintroduced).

**(f) The ISP→LSP coupling.** L4 is not cosmetic — it is the *precondition* for L5. The `ActionSubstrate` port over-promises 12 methods (`src/page/action-substrate.ts:35-49`); because the port promises more than Safari can deliver, `SafariActionSubstrate` is *forced* to stub 8 of them with `safariUnsupportedAction(…)` — which is precisely the Liskov violation L5 forbids. Fix the ISP failure (narrow the port to what every adapter can honor, and model the rest as declared capabilities) and the LSP failure cannot arise, because no adapter is ever asked to implement a method it must fake. This is why the standard treats them as a pair: a fat interface manufactures substitutability violations the way a god-module manufactures merge conflicts. Segregating the contract is the structural fix; the L5 port-conformance test is the proof it stayed fixed.

### L5 — Substitutable adapters

**(a) Statement.** Every adapter honors its port's full contract or *declares the gap as a capability*. No adapter throws where the port promises a value.

**(b) Safety-critical origin.** LSP, fused with fault-containment. A redundant component that silently fails to honor the contract of the one it replaces is worse than no redundancy — it converts a handled condition into an unhandled one at the worst moment. Flight software's rule is that a substitute either *is* substitutable or *announces* (via a status word the caller checks) that it is degraded; it never pretends and then throws.

**(c) browxai failure mode.** `BrowserSession.page(): Page` is a required member (`src/session/types.ts:86`, documented as throwing at `src/session/types.ts:95`), but the Safari engine's `page()` actually throws unconditionally at `src/session/safari-session.ts:35` (`NO_PLAYWRIGHT_PAGE`). That single LSP violation is the *root cause* of the 17 scattered defensive guards in `session-registry.ts` (L1's evidence) — every caller that might run on Safari must branch on the engine before calling `page()`. The substrate layer repeats the anti-pattern: `SafariActionSubstrate.hover/select/scroll/…` return `Promise.resolve(safariUnsupportedAction(…))` (`src/page/action-substrate.ts:124-147`), an `ActionResult{ok:false}` discovered only at runtime after dispatch.

**(d) TypeScript adaptation.** Two-part. (1) Make the Page a *declared capability*: `safari?(): SafariSessionHandle` already models the no-Page seam correctly (`src/session/types.ts`); the residual direct `page()` calls are the bug. Callers route through the capability substrates (the established port design), and the engine *declares* whether a raw Page exists — typed so a caller that needs it must narrow, never assume. (2) A degraded substrate method *announces* via the engine's `EngineCapabilities` (`src/engine/capabilities.ts` — Firefox/WebKit already declare `deep: false`), so the gate refuses *before* dispatch, not after. The residual 17 guards collapse into the single `EngineRegistry.postWire`.

**(e) Enforcement.** The **port-conformance contract test** run against *every* registered adapter including the synthetic L1 sixth engine: a port method that throws unconditionally (rather than returning the port's promised value, or being absent because the capability is undeclared) fails the test. Paired with L1's `no-engine-literal-branches` so no caller may re-introduce a branch on the *absence* of a port method.

### L6 — Validate at the edge, trust within

**(a) Statement.** Untyped data is narrowed at the system boundary (the MCP wire, config, the Playwright/CDP edge) and is *fully typed* thereafter. Internal code does not re-validate what the boundary already proved.

**(b) Safety-critical origin.** Power-of-Ten rule 7 — *check the return value of every non-void function and the validity of every parameter* — combined with the boundary discipline: validate exactly once, at the edge, then trust. Flight software validates sensor input at the ingest boundary and then operates on typed, range-checked values internally; it does not pepper the control loop with redundant checks (which would be both slower and a place for a check to *disagree* with the edge). `code-quality.md` already states the browxai form of this: "Validate at system boundaries … trust internal code past it."

**(c) browxai failure mode.** Historically, untyped `any` leaking past the MCP-wire boundary into handler bodies — the class of defect the `no-unsafe-*` family catches. The exemplar of the *fixed* state is the just-landed enforcement: the five `@typescript-eslint/no-unsafe-*` rules are now `error` (`eslint.config.js:212-216`), `no-explicit-any` is `error` (`eslint.config.js:196`), and the host's `register` types every handler's `args` as `z.infer<z.ZodObject<S>>` of the tool's own `inputSchema` (`src/tools/host.ts:60-64`) — so the wire payload is narrowed once, at the MCP boundary, and the handler reads a precise object, never `any`. The residual gap the audit names: a few egress paths (e.g. `NetworkBuffer.iter()` raw snapshots, `src/page/network.ts`) hand the untrusted-shaped data downstream without the narrowing the masking layer assumes (see L-egress under §4.3).

**(d) TypeScript adaptation.** The boundary-narrowing contract: zod at the MCP wire, the config parser, and the Playwright/CDP edge; `z.infer` types flowing inward; no `any`, no `as` re-widening past the edge. The `no-unsafe-*` family *is* the mechanization — what was a discipline ("validate at the boundary") is now a build failure if violated.

**(e) Enforcement.** The five `no-unsafe-*` rules + `no-explicit-any` at `error` (already landed), plus a boundary-narrowing test that asserts every registered handler's argument type derives from its `inputSchema`. The per-test/per-fixture relaxations (`eslint.config.js:260-265`) are the *sanctioned* deviation — scoped, documented, and outside `src/`.

### L7 — Bounded everything

**(a) Statement.** Every loop, buffer, ring, recursion, and wait has an explicit, *tested* bound. No unbounded fan-out, slurp, or recursion.

**(b) Safety-critical origin.** Power-of-Ten rules 2 and 3 — *every loop has a fixed upper bound a checker can statically prove*, and *no dynamic memory allocation after initialization*. The reason is exact: an unbounded loop or an unbounded allocation is a latent denial-of-service against the vehicle itself — a single oversized input exhausts the resource and wedges the system at the worst possible time. The bound is not a tuning knob; it is a safety property.

**(c) browxai already lives this — partially.** browxai has more bounded-resource discipline than any other axis in the audit. The §4.2 inventory below catalogs the bounds it *already* enforces and names the gaps. The discipline is real but *unmechanized*: no test asserts the bounds stay, and no lint rule flags a new unbounded loop or slurp. `architecture-principles.md` §3 already states the rule ("Bound the buffer; stream over slurp") and cites the canvas/gesture bounds — this law turns that prose into a fitness function.

**(d) TypeScript adaptation.** Every ring carries an explicit `cap`; every recursion carries an explicit, tested depth guard; every wait is clamped; every batch is capped. The bound is a named constant or a constructor parameter, never an implicit "it won't get that big."

**(e) Enforcement.** A `bounded-resource` audit (lint + budget tests) asserting each known ring/deadline/depth-cap/batch-cap is present and at its declared value, and flagging a new unbounded loop (`while` / `for` / `for…of` / `do-while`, e.g. `while (true)`) or unbounded `slurp` in `src/page/*` / `src/util/*`. Detailed inventory and the gaps in §4.2.

### L8 — Assert the invariants

**(a) Statement.** Internal invariants are asserted, not assumed. A violated invariant surfaces as a *structured refusal*, never a crash or a silent wrong answer.

**(b) Safety-critical origin.** Power-of-Ten rule 5 — *assertion density of at least two per function* — with the constraint that assertions are *side-effect-free* (they test a condition, they do not themselves recover). The recovery is defined at the *system* level, not per-assertion: a failed assertion surfaces a contained fault that the surrounding fault-containment machinery handles, never a silent abort. Assertions in flight software are not debug scaffolding; they are the runtime statement of the invariants the static analysis could not prove, and a failed assertion is a containable fault, not a panic.

**(c) browxai failure mode.** The pattern already exists in its mature form — `DeadlineError` (`src/util/deadline.ts:13-32`) is exactly a contained fault surfaced as a structured, *recoverable* refusal with an explicit playbook, and the secrets `materialize` path returns `{ok:false, error}` rather than throwing when a scope check fails (`src/util/secrets.ts:145-156`). The gap is *density and uniformity*: load-bearing modules (the gate, the engine registry once it exists, the egress chokepoint, the session factories) carry invariants in comments and conditionals but not as a uniform, discoverable `invariant()` helper, and nothing measures the density.

**(d) TypeScript adaptation.** A single helper with a TypeScript *assertion signature*, so a passing invariant also narrows the type (the boundary discipline of L6, applied internally):

```ts
export function invariant(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    // Contained fault → structured refusal, never a raw throw past the dispatch
    // boundary. The dispatcher converts InvariantError into a ToolResponse the
    // agent can act on — same posture as DeadlineError.
    throw new InvariantError(msg);
  }
}
```

Invariants belong at the load-bearing seams: the capability gate (the granted set is well-formed before a check), the `EngineRegistry` (every `EngineKind` resolves to exactly one entry), the egress chokepoint (no raw secret value leaves), the session factories (a session has exactly one adapter). A violated invariant is caught at the dispatch boundary and rendered as a structured refusal — the generalization of the deadline pattern.

**(e) Enforcement.** An `invariant()` helper + an assertion-density check on a declared list of load-bearing modules (the analogue of the Power-of-Ten density rule, scoped to where it pays rather than blanket-applied). The dispatcher's `InvariantError → ToolResponse` mapping is keystone-verified so "structured refusal, never crash" is a tested property.

### L9 — Traceable

**(a) Statement.** Every world-touching tool ⇒ a capability declaration ⇒ a keystone denial test, *in the same change*. Every engine ⇒ a capability row ⇒ a keystone lane. Coverage of the seam is a structural property.

**(b) Safety-critical origin.** DO-178C / NPR 7150.2 traceability: requirement → code → test, with coverage *exhibited*. The certifying authority does not accept "we tested it"; it requires the trace matrix that shows every requirement is covered and every line of code traces to a requirement. The browxai analogue: the *seam* (capabilities, engines) has a coverage matrix that a machine checks.

**(c) browxai failure mode.** The trace is a *convention*, not a property. `architecture-principles.md` §4 mandates "off-by-default behind a declared capability, with a per-tool keystone denial test, in the same diff" — but no test asserts the convention held. The audit found no test that "every engine in `EngineKind` has a capabilities row," no test that "all `DEEP_TOOLS` are unavailable on Firefox," and a 181-entry `TOOL_CAPABILITY` with no completeness check. The `DEEP_TOOLS` drift is the sharpest illustration: a new CDP tool omitted from the set runs on Firefox/WebKit and *crashes mid-execution* instead of refusing at registration (`src/engine/tool-gate.ts:38-88`) — a coverage hole that is silent until it fires.

**(d) TypeScript adaptation.** Make the three traces structural facts derived from the registrations (post-L2): tool ↔ capability ↔ keystone; engine ↔ `EngineCapabilities` row ↔ keystone lane; deep tool ↔ engine-gate refusal. The keystone suite already runs per-engine lanes (Firefox/WebKit/Android/Safari); the new fitness tests assert the *completeness* of the matrix, not just the per-cell behavior.

**(e) Enforcement.** Traceability fitness tests: `tool↔capability↔keystone` (every world-touching tool has a capability and a denial test), `engine↔caps↔lane` (every `EngineKind` has a capabilities row and a lane). These are static (registry/AST analysis) and run in the fast `pnpm test` lane.

**(f) Why derivation beats the chore.** Traditional traceability is a matrix someone maintains by hand — and a hand-maintained matrix drifts exactly like the `TOOL_CAPABILITY` map drifts (L2). L9 only works because L2 lands first: once capability and deep-ness are *declared at the unit* (the `host.register` metadata), the trace is a *derivation* over the registrations, not a document anyone updates. The fitness test does not consult a checklist; it walks the live registrations and the live keystone suite and asserts they line up. That is the difference between DO-178C done as paperwork (which rots) and DO-178C done as a build gate (which cannot): the trace is recomputed from ground truth on every run. This dependency — L9 needs L2 — is why the parent RFC sequences metadata-at-registration (phase P2) before the full traceability promotion, and why the standard presents them as coupled rather than independent.

### L10 — Deterministic & observable

**(a) Statement.** The surface is deterministic where it pays (replay, diffing) and self-diagnosing (the diagnostics recorder); determinism is *keystone-verified*, not asserted.

**(b) Safety-critical origin.** DO-178C reproducibility: a system whose behavior is not reproducible cannot be certified, because a test result that does not repeat proves nothing. Determinism is the precondition for every other verification. browxai's recorder/replay path and the diff-based tools rely on the same property for the same reason.

**(c) browxai failure mode / current state.** `architecture-principles.md` §3 already states the rule and notes that browxai's recorder/replay path is "keystone-tested against real Chromium so the determinism claim is verified, not asserted." The hardening obligation is narrow: the *new* seams introduced by this RFC (the `EngineRegistry`, the derived maps, the egress chokepoint) must not introduce non-determinism — a registry whose iteration order leaks into output, or a derived map whose ordering varies, would silently break replay.

**(d) TypeScript adaptation.** Registries iterate in declared (insertion or sorted) order, never `Object.keys` hash order, where the order is observable; derived maps are sorted deterministically before emission (the `sdk/tool-types.ts` codegen must be byte-stable). The diagnostics recorder (`src/util/diagnostics.ts`) remains the observability spine.

**(e) Enforcement.** The existing keystone determinism gates, extended to cover the new seams: the codegen byte-stability test (also serves L2), and a replay assertion over a sequence that exercises the registry-driven path.

---

## 4. The sub-disciplines (the NASA-grade specifics)

The ten laws are the spine. These six disciplines are where "NASA-level" becomes concrete enough to defend against a skeptical reviewer — each is grounded in a real browxai bound or pattern, cited at file:line.

### 4.1 Assertion discipline (L8)

The helper is `invariant(cond, msg): asserts cond` (§3/L8). Three rules govern its use.

**Where invariants belong.** Not everywhere — the Power-of-Ten "two per function" is a *flight-software* density chosen for a domain where every function is on a safety path. browxai applies the density only to **load-bearing modules**: the capability gate, the `EngineRegistry`, the egress chokepoint, the session factories, the dispatcher. An invariant on a leaf page-side helper is noise; an invariant on "the granted-capability set is well-formed before any check" is load-bearing.

**The density target.** On the declared load-bearing list, the assertion-density check requires a non-trivial density (the calibrated value lives in [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md); it is sized from what the current healthy gate/factory code already implies, not an aspirational blanket "≥2 per function"). The check is a fitness test, not a blanket lint, precisely so it stays signal.

**A violated invariant becomes a structured refusal, never a crash.** This is the fault-containment law made uniform. `DeadlineError` (`src/util/deadline.ts:13-32`) is the existing exemplar — a contained fault rendered as a recoverable, playbook-bearing refusal. `InvariantError` follows the same posture: the dispatcher maps it to a `ToolResponse{ok:false}` the agent can act on, never a raw throw that crashes the dispatch loop. The mapping is keystone-tested so the property is verified, not hoped.

### 4.2 Bounded-resource discipline (L7)

This is browxai's strongest existing axis. The inventory of bounds it **already** enforces — every one verified in the source:

| Bound | Value | Evidence | Kind |
|---|---|---|---|
| Anti-wedge action deadline | default 5 000 ms; clamped to [1 ms, 3 600 000 ms] | `src/util/deadline.ts:9-11`, `clampTimeout` `:39-58`, `withDeadline` `:64-72` | wait |
| Canvas capture dimension cap | 16 384 × 16 384 px (`too-large` refusal) | `src/page/canvas.ts:99` (`CANVAS_MAX_DIMENSION`), enforced `:170-174` | buffer/allocation |
| `gesture_chain` `move` pacing floor | 5 ms (tighter starves the renderer) | `src/tools/canvas-tools.ts:203,217` | wait |
| `gesture_chain` `wait` clamp | 5 000 ms (split longer across calls) | `src/tools/canvas-tools.ts:203,217` | wait |
| `gesture_chain` step cap | 200 steps total | `src/tools/canvas-tools.ts:203` | loop |
| `drag` / `gesture_pinch` interpolation steps | `min(max(steps ?? 12, 1), 100)` | `src/page/gestures.ts:63,212` | loop |
| `gesture_swipe` steps | `min(max(steps ?? 16, 1), 200)` | `src/page/gestures.ts:271` | loop |
| Network HTTP / WS ring size | `cap = 500` (oldest shifted out) | `src/page/network.ts:338,353,581,652,847,929,1003,1018` | ring |
| Network body parse ceiling | `MAX_BODY_BYTES_TO_PARSE = 256_000` (~256 KB) | `src/page/network.ts:96,480,719` | slurp guard |
| `network_read` response-shape keys | `MAX_RESPONSE_SHAPE_KEYS = 20` | `src/page/network.ts:95` | buffer |
| Secrets registry capacity | `cap = 32` (keeps per-sink scan O(secrets × len) sane) | `src/util/secrets.ts:55,72-76` | buffer |
| Secrets mask recursion depth | `depth > 8` → return as-is (can't blow the stack) | `src/util/secrets.ts:183-203`, guard at `:192` | recursion |
| `batch` / `flake_check` inner-call cap | `BATCH_MAX_CALLS = 32` | `src/tools/extensions-batch-tools.ts:738,773,1064` | loop |

The **gaps** the standard names (full list in [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md)):

- `perf-audit.ts` `enforceSummaryBudget` uses iterative token re-estimation with nested severity loops and aggressive `while` loops calling `estimateTokens()` per iteration, with *no hard iteration ceiling* — it relies on a "trimmed" flag to avoid an infinite loop rather than an explicit bound (`src/page/perf-audit.ts:524-583`). An O(N²) risk on a large report, and the only loop in the bounded inventory that lacks an explicit cap.
- The `extract.ts` tree-walk depth: the a11y `walk` generator (`src/page/a11y.ts:205-211`) is iterative (an explicit stack, so no native stack-overflow risk) but carries *no declared depth cap* — a pathological tree is bounded only by memory. The standard requires the cap be made explicit and tested, matching the `secrets.ts:192` `depth > 8` exemplar.

**The rule.** Every loop, buffer, ring, recursion, and wait above carries an explicit, named bound *and a test that asserts the bound holds*. The `secrets.ts` `depth > 8` guard is the model: a one-line cap with an obvious comment ("Bounded depth (8) so a malformed input can't blow the stack", `src/util/secrets.ts:182`), and the fitness test freezes it so a refactor cannot silently remove it. Power-of-Ten's "no recursion" becomes browxai's "**bounded recursion with an explicit, tested depth cap**" — the TypeScript adaptation is not to ban recursion (idiomatic and safe over bounded trees) but to require the cap be a tested constant.

The freeze is what makes a bound a *property* rather than a comment. The shape of the test is a direct behavioral assertion against the cap — for the secrets recursion guard:

```ts
// A bound is verified by exhibiting that exceeding it is contained, not crashed.
it("applyMaskDeep is bounded — a pathological depth does not blow the stack", () => {
  const reg = new SecretRegistry();
  reg.register({ name: "PASSWORD", value: "hunter2" });
  // Build a nesting deeper than the depth>8 guard; the guard must stop the
  // recursion and return the deep tail untouched, never throw RangeError.
  let deep: unknown = "hunter2";
  for (let i = 0; i < 64; i++) deep = { inner: deep };
  expect(() => reg.applyMaskDeep(deep)).not.toThrow();
});
```

This is the Power-of-Ten "exhibit the bound" discipline in TypeScript: the test does not read the constant `8` and assert it equals `8` (a tautology a refactor would update in lockstep) — it *exercises* the boundary and asserts the contained behavior, so removing the guard fails the test for the right reason. The same shape covers the ring caps (push `cap + 1` entries, assert the ring is `cap`), the batch cap (submit `BATCH_MAX_CALLS + 1`, assert refusal), and the deadline clamp (request beyond the ceiling, assert the warning).

### 4.3 Validate-at-edge (L6)

The boundary-narrowing contract has one exemplar (the just-landed enforcement) and one named residual gap.

**The exemplar.** The five `no-unsafe-*` rules at `error` (`eslint.config.js:212-216`) + `no-explicit-any` at `error` (`:196`) + the `z.infer` handler typing (`src/tools/host.ts:60-64`) together make the boundary narrow once and the interior fully typed — exactly Power-of-Ten rule 7 in TypeScript form. What was the prose rule of `code-quality.md` ("Validate at system boundaries … trust internal code past it") is now a build failure if violated. This is the template every future boundary follows.

**The egress residual (L-egress).** The egress sanitiser (URL-sanitiser ∘ secrets-masking) is the one boundary that is *hand-called at each sink* rather than structurally guaranteed. `composeUrlAndSecretsInText` exists as a helper (`src/util/secrets.ts:256-264`) but is *optional* — a caller must remember to invoke it, and the audit found `diagnostics.ts:151-154` calls `applyMaskDeep` directly without the URL sanitiser, and `NetworkBuffer.iter()` returns a "raw, read-only snapshot" with no masking (`src/page/network.ts`). The standard's resolution (D4 in the parent RFC) is to make egress masking a *compile-time chokepoint* rather than a discipline. The mechanism is a branded output type that only the chokepoint can produce, so a handler *cannot* return a string to the MCP client that has not passed the sanitiser — the omission the audit found becomes a type error, not a silent leak:

```ts
// A branded type the dispatcher demands and only EgressSanitiser can mint.
type SanitisedText = string & { readonly __egress: unique symbol };

class EgressSanitiser {
  constructor(private readonly secrets: SecretRegistry | null) {}
  // sanitizeUrlsInText ∘ secrets-masking, in the one correct order, once —
  // the exact composition composeUrlAndSecretsInText performs today, but as a
  // chokepoint the dispatcher owns rather than a helper each sink must call.
  apply(text: string): SanitisedText {
    const afterUrl = sanitizeUrlsInText(text);
    return (this.secrets ? this.secrets.applyMaskInText(afterUrl) : afterUrl) as SanitisedText;
  }
}
```

A handler that builds a `ToolResponse` from a raw `string` instead of a `SanitisedText` no longer compiles. This is L6 applied to the *output* edge: narrow (mask) exactly once, at the egress boundary, and make "exactly once, here" a property the type system enforces rather than a call the author must remember at each of the eight sinks (`ActionResult.network`, `network_read`, `network_body`, `ws_read`, `console_read`, `snapshot`, `find`, and the diagnostics recorder). The fitness test pairs with it: a sink that returns un-branded text, or a new sink added without routing through the chokepoint, fails the build.

### 4.4 Defense in depth / fault containment

The structured-refusal pattern, generalized. browxai already contains faults at three boundaries: the anti-wedge deadline (`DeadlineError`, recoverable, playbook-bearing — `src/util/deadline.ts:13-32`), the secrets scope check (`materialize` returns `{ok:false, error}` rather than substituting cross-origin — `src/util/secrets.ts:145-156`), and the capability gate (a denied tool returns a refusal, not a throw). The standard's contribution is *uniformity*: every internal fault — a violated invariant (L8), an unsupported adapter method (L5), a clamped-out-of-range parameter (the `clampTimeout` warning at `src/util/deadline.ts:47-54`) — surfaces through the same structured-refusal envelope, caught at the dispatch boundary, never propagated as an uncontained throw. Defense in depth means the gate refuses *before* dispatch (L5/L9), and the deadline contains *during* dispatch, and the egress sanitiser scrubs *after* dispatch — three independent layers, each a fitness-tested property.

### 4.5 Traceability (L9)

Two structural coverage properties, both derived (post-L2) rather than maintained:

- **tool → capability → keystone.** Every world-touching tool resolves to a declared capability (no silent `human` default) and has a keystone denial test. The fitness test walks the registrations and fails on any tool with a world-touching capability but no corresponding denial test — the DO-178C trace matrix as a unit test.
- **engine → caps → lane.** Every `EngineKind` (`src/engine/types.ts:25`) has an `EngineCapabilities` row (`src/engine/capabilities.ts`) and a keystone lane. The `deep: false` declarations on Firefox/WebKit (`src/engine/capabilities.ts:52,67`) are the existing model — the engine gate refuses deep tools structurally; the fitness test asserts the *completeness* of that matrix so a new engine cannot land with a missing row, and a deep tool cannot land outside the gate.

Traceability here is a *structural* property — a fact about the shape of the registrations and the test suite — not a convention reviewers enforce. That is the whole difference between L9 and the §4 prose of `architecture-principles.md` it operationalizes.

### 4.6 Determinism (L10)

Keystone-verified, not asserted. The existing recorder/replay and diff paths are already keystone-tested against real Chromium (`architecture-principles.md` §3); the standard's obligation is to extend that verification to the *new* seams so they cannot silently break replay: the `EngineRegistry` iterates in declared order where order is observable, the derived maps sort deterministically before emission, and the `sdk/tool-types.ts` codegen is byte-stable (the same fitness test serves L2 and L10). Determinism is the precondition for verification; a seam that is not deterministic is a seam whose tests prove nothing.

---

## 5. How a law becomes a gate

A law in this standard is not adopted by writing it down; it is adopted by *landing its enforcer*. The lifecycle is the JPL warn → error layering (§2), applied uniformly so that adopting a guardrail never detonates a wall of failures and so that a guardrail, once green, can only ratchet tighter. Every enforcer named in the §3 "(e)" clauses moves through these stages, sequenced by the parent RFC's phasing (RFC 0004 §6):

1. **Instrument (warn / reporting-only).** The fitness function, lint rule, or budget lands first as a *non-blocking* check that surfaces violations without failing the build. The size/complexity/duplication budgets and the `dependency-cruiser` layering rules land here in phase P0. For a *freezing* check (the completeness and traceability tests), "warn" is unnecessary — they already pass for the current maps, so they land *failing* immediately and simply freeze the present state.
2. **Refactor against the green.** The structural change (the `EngineRegistry`, metadata-at-registration, the god-module split) is performed *against* the instrumented checks, so behavior-preservation is mechanically verified and the warning count drops to zero as the debt is paid. This is why the guardrails land *before* the refactor, inverting the usual instinct: you instrument before you operate.
3. **Promote to error.** Once the violations are zero, the check flips from warn to `error` (P1 promotes `no-engine-literal-branches`; P3 promotes the size budgets; P4 promotes the layering rules). From this point the characteristic *cannot* regress without failing the build.
4. **Ratchet, never loosen.** A budget, once met, only tightens. A relaxation is a *deviation*, and the deviation discipline (the JPL import, §2) is absolute: a guardrail may be relaxed only via an RFC amendment recording the rationale — never an inline `eslint-disable` or a quietly raised threshold. This is the meta-rule (the parent RFC calls it L-meta): the same governance the `no-unsafe-*` work already established, generalized to every enforcer.

The consequence is the property the owner asked for: the codebase cannot decay back to its audited state *through a green gate*, because each defect class the audit found now has a check that fails the build the moment it recurs — and the only way to disable a check is a visible, reviewed amendment, not a silent suppression an agent or a hurried human can slip past review. The guarantee is exactly that scoped one, not an absolute (as §3 L1(f) concedes, a lint rule can be satisfied by an incomplete registry and a literal can lurk in an unexercised path — which is why the engine-adapter-contract keystone backs the lint rule in defense-in-depth, and why "decay requires a visible amendment" is the honest claim, not "decay is impossible"). The discipline is mechanized, and the mechanization is governed.

---

## 6. What this standard is NOT

The standard is exacting; it is not maximalist. Four explicit non-claims, each a guardrail against over-reading "NASA-level."

**It is not maximal architecture.** The proven-seam test of `architecture-principles.md` §1 still binds, in full: a port lands only where there is a second real implementation or a committed near-term need. The audit was used *precisely* to confirm every registry this RFC proposes has multiple real implementations today — 5 engines, 70+ batchable tools, 8 perf analysers, 3 transports, 5 CLI commands — so none is speculative. "Bounded everything" (L7) does not mean "abstract everything"; a single-implementation interface with no second consumer remains tech debt under this standard exactly as it is under the existing doctrine. The `canvas_query({adapter, op, args})` inner-`op` dispatch remains the deliberate, sanctioned substrate exception it always was — not a pattern this standard licenses elsewhere.

**It does not forbid pragmatism.** Three similar lines still beat a premature abstraction (`code-quality.md`). The standard forbids *un-mechanized* discipline, not pragmatic concrete code. A 50-line handler with two near-duplicate branches that are genuinely independent is fine; a copy-paste *family* of five (the policy classes, `src/session/dialog.ts:62-93` and siblings) is a DRY defect because the duplication is structural and divergence-prone — the `jscpd` budget (L2/D4) draws that line at a measured threshold, not at "any repetition."

**It does not replace the existing doctrine — it extends it.** `architecture-principles.md` and `code-quality.md` are *retained in full*. This standard adds the enforcer column the audit found missing (theme T7): the doctrine was excellent and unenforced, and the only new thing is the machine that fails when the doctrine is violated. A reader who knows the existing doctrine and this standard should see no contradiction — only that what was advice is now also a gate.

**It forbids un-mechanized discipline.** This is the one positive claim that defines the standard. A rule that lives only in a reviewer's head or a doc's prose is, by the audit's own evidence, a rule that drifts: all 80 structural defects passed human review. The standard's bar for *any* law is therefore singular and unforgiving — **a law that cannot be mechanized into a fitness function, a lint rule, or a CI gate is not in this standard.** That is what "NASA-level" means here: not more rules, but rules a machine holds.

---

## References

- Parent RFC: [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) — the thesis, the ten laws (§4), the decisions (D1–D12), the phasing. This document is the deep expansion of its §1 ("Why NASA-level") and §4 (the standard).
- [`0004-01-current-state-audit.md`](0004-01-current-state-audit.md) — the 80 findings across 8 subsystems; the file:line evidence cited throughout this document.
- [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md) — the `EngineRegistry`, metadata-at-registration, the derived-map and `EgressSanitiser` patterns referenced by L1/L2/L5 and §4.3.
- [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md) — the executable enforcers: every lint rule, fitness test, budget, and gate named in the "Enforcement" clauses above, with concrete config and code; the calibrated density and duplication thresholds.
- [`0004-07-prior-art-and-references.md`](0004-07-prior-art-and-references.md) — full citations for the Power of Ten, the JPL Institutional Coding Standard, DO-178C / NPR 7150.2, defense-in-depth, and *Building Evolutionary Architectures*; the deeper survey of the lineage summarized in §2.
- Doctrine this standard extends (both still binding): [`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md) (macro — boundaries, proven seams, performance, scalability seams) and [`code-quality.md`](../../ai-context/agent-process/code-quality.md) (micro — SOLID-in-TypeScript, comment and public-surface hygiene, the no-half-finished rule).
