# RFC 0004 / Reference 07 — Prior art & references

This is the citation record for the architecture-hardening standard: the external
bodies of practice [RFC 0004](../0004-architecture-hardening.md) imports, what each
one *is* (accurately, not as a slogan), and the exact browxai law, decision, or
guardrail each one grounds. The parent RFC's central claim — *"NASA-level
maintainability"* — is a precise, citable target, not rhetoric; this document is
where the citations live and where the mapping from external rule to browxai
enforcer is made explicit. The companion that turns these citations into running
code is [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md);
the doctrine these practices *extend* (never restate) is
[`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md)
and [`code-quality.md`](../../ai-context/agent-process/code-quality.md).

A note on scope and honesty: we import **practices**, not frameworks (RFC 0004 §7
alternative — "adopt an off-the-shelf clean-architecture framework" — was rejected).
Several of the canonical sources below were written for C, for the JVM, or for
1970s mainframe modularity. Where browxai deliberately *adapts* or *relaxes* a rule
to fit a TypeScript MCP server, this document says so plainly. Where we are
paraphrasing a well-known rule rather than quoting it, this document says that too.
No page numbers are invented; sources are cited by author / title / year / venue.

---

## 1. Safety-critical software engineering

The reframing that makes this lineage applicable, restated from RFC 0004 §1: in C,
the safety-critical rules guard against *memory corruption and undefined behavior*;
in browxai, the analogous failure mode is **architectural corruption** — a
god-module, an `if (engine === "literal")` leak, a hand-edited central list — and
the analogous mechanization is the **fitness function**. We are not writing flight
software. We are importing the *discipline that mechanizes discipline*.

### 1.1 The Power of Ten — Holzmann, 2006

**Source.** G. J. Holzmann, *"The Power of Ten — Rules for Developing
Safety-Critical Code,"* IEEE Computer, vol. 39, no. 6, June 2006, pp. 95–99.
Written at NASA/JPL's Laboratory for Reliable Software. Ten rules, deliberately few
enough to remember, every one mechanically checkable by a static analyzer — that
checkability is the whole point, and it is exactly the property RFC 0004 demands of
its own ten laws.

The ten rules and their browxai mapping. Where browxai's adaptation *relaxes* the
literal rule, the relaxation and its compensating control are stated.

| # | Power-of-Ten rule (paraphrased) | browxai mapping | Adapt / relax? |
|---|---|---|---|
| **1** | Restrict to simple control flow; no `goto`, `setjmp`, recursion. | **L1 (closed core)** and **L7 (bounded everything)**. The browxai analogue of "simple control flow" is *no engine-literal branching above the seam* — the `if (engine === …)` chains the audit found in `src/session/managed.ts:26,35` / `byob.ts:154,162` / `incognito.ts:25,33` are the control-flow complexity this rule forbids, lifted to the architectural plane. | **Relaxed on recursion.** browxai allows recursion (tree-walks in `src/page/dom-walk.ts`, snapshot composition) — but **bounded and tested**, per rule 2. The compensating control is L7's bounded-resource budget, not a recursion ban. |
| **2** | All loops must have a fixed, statically provable upper bound. | **L7.** Every ring, deadline, poll window, and fan-out carries an explicit tested bound — the doctrine already names `canvas_capture`'s 16384×16384 cap and `gesture_chain`'s clamps (architecture-principles §3). | Direct import; mechanized as a budget test rather than a compiler proof. |
| **3** | No dynamic memory allocation after initialization. | **L7**, *adapted.* A GC'd runtime cannot honor this literally. The browxai translation is **no unbounded allocation on the hot path** — bound the buffer, stream over slurp (architecture-principles §3); the audit's `perf-audit.ts` token-budget concern (no termination invariant) is exactly the failure this rule prevents. | **Adapted** — "no unbounded growth," not "no allocation." |
| **4** | No function longer than ~60 lines (one printed page). | **L3 (one reason to change).** Mapped to the hard budgets RFC 0004 §5 D11 sets: a tool module ≤ ~400 LOC, `server.ts` ≤ 400, a function ≤ ~70 LOC / cyclomatic complexity ≤ ~15. The god-modules the audit found (`read-observe-tools.ts` at 1965 LOC, `capture-report-tools.ts` at 1514) are rule-4 violations at module scale. | Adapted upward (70 vs 60) and lifted to module scale; mechanized by `eslint` `max-lines` / `max-lines-per-function` / `complexity`. |
| **5** | Minimum two assertions per function; assertions must be side-effect-free and check anomalous conditions. | **L8 (assert the invariants).** browxai introduces an `invariant()` helper and an assertion-density check on the load-bearing modules; a violated invariant surfaces as a **structured refusal**, never a crash (fault containment, §1.4 below). | **Relaxed on the density floor.** We do not impose "≥2 everywhere" — that would manufacture noise assertions in pure data-shaping code. The density check targets the *load-bearing* modules (the session factories, the gate, the substrates), not every utility. |
| **6** | Declare data objects at the smallest possible scope. | **L3 / L4 (segregated contracts).** The TypeScript analogue is the `SessionEntry` (50+ fields, `src/session/registry.ts:48`) and `ToolHost` (75 members, `src/tools/host.ts:54`) segregation: a consumer depends on the narrow role-bundle it uses, not the god-object — smallest-scope *contract*, not just smallest-scope *variable*. | Lifted from variable scope to interface scope (ISP). |
| **7** | Check the return value of every non-void function; check the validity of every parameter. | **L6 (validate at the edge, trust within).** browxai narrows untyped data at the boundary (MCP wire, config, the CDP/Playwright edge) and is fully typed thereafter — enforced by the five `no-unsafe-*` rules now at `error` plus `no-explicit-any`. The just-landed handler-arg typing (`host.register`'s handler receives `z.infer<z.ZodObject<S>>`, `src/tools/host.ts:60-64`) *is* this rule made structural. | Adapted: TypeScript's type system discharges most "check the parameter" obligations at compile time; the rule survives as "narrow at the edge, then trust the types." |
| **8** | Limit preprocessor use to header inclusion and simple macros. | **No direct analogue** — TypeScript has no C preprocessor. The spirit (no metaprogramming that defeats static analysis) maps to **L2's codegen discipline**: the SDK tool-types are *generated from the source-of-truth registrations* (D7), not hand-mirrored or macro-expanded, and a fitness test fails if the committed file diverges. | **N/A in C terms; spirit preserved** as "generated, checkable, never hand-mirrored." |
| **9** | Restrict pointer use; no more than one level of dereference; no function pointers. | **No direct analogue** (no raw pointers). The spirit — *no indirection the analyzer cannot follow* — maps to **L1/L10's dependency layering (D10)**: dependency-cruiser makes the import graph statically followable and forbids the cross-layer reaches (handlers → concrete engine adapter, `sdk/*` → handler internals) that are the TypeScript equivalent of an untrackable pointer chase. | **Reinterpreted** as static dependency-graph enforceability. |
| **10** | Compile with all warnings enabled at the most pedantic setting; code must compile clean, daily, with multiple static analyzers; warnings are not waived, they are fixed. | **The meta-rule of the entire standard.** This is the single most load-bearing import: it is *why* RFC 0004 exists. browxai's global gate already runs `pnpm typecheck` / `test` / `test:keystone` / `lint` / `format:check` / `build` clean with a **zero-ignores discipline** (no `// @ts-ignore`, no unjustified `eslint-disable`) per code-quality.md. RFC 0004 extends "all analyzers at maximum" to include the **architecture analyzers that do not exist today** — the fitness suite, dependency-cruiser, the budgets, the custom OCP lint rules. | Direct import; the gap RFC 0004 closes is precisely the *architectural* analyzers missing from "all checkers at maximum." |

The honest summary: of the ten, **rules 1, 2, 4, 5, 7, 10 map cleanly** onto browxai
laws; **3 is adapted** for a GC'd runtime; **6 is lifted** from variable to interface
scope; **8 and 9 have no C-level analogue** but their *spirit* (no analysis-defeating
metaprogramming, no untrackable indirection) survives as the codegen and
dependency-graph disciplines. None is imported as cargo-cult; each is mapped to a
browxai failure mode the audit actually found.

### 1.2 The JPL Institutional Coding Standard

**Source.** *JPL Institutional Coding Standard for the C Programming Language*,
Jet Propulsion Laboratory, DOCID D-60411 (the "JPL C standard," authored under
Holzmann, building on and operationalizing the Power of Ten). What it *is*: a
layered ruleset — rules grouped by severity / risk level — where **each rule is tied
to a specific static-analyzer check**, not left to reviewer judgment. Its
organizing idea, that a coding standard is only real if a tool enforces it, is the
direct ancestor of RFC 0004's "**every law above is a green check or it is not in
the standard**" (RFC 0004 §4).

browxai mapping: the JPL standard's *severity layering* is the model for RFC 0004's
**phased landing of the guardrails** (P0 lands them reporting-only / `warn`, later
phases promote to `error` — see [`0004-04-refactor-plan.md`](0004-04-refactor-plan.md)),
and its *rule-to-analyzer binding* is the model for RFC 0004's Law→Enforcer column
(every law names its lint rule, fitness test, or CI gate).

### 1.3 DO-178C and NASA NPR 7150.2 — the traceability discipline

**Sources.**
- *DO-178C / ED-12C, "Software Considerations in Airborne Systems and Equipment
  Certification,"* RTCA / EUROCAE, 2011. The avionics software certification
  standard. Its load-bearing concept for our purposes is **bidirectional
  requirements traceability**: every requirement traces down to code and to a test,
  and every line of code and every test traces back up to a requirement — and at the
  higher assurance levels, **structural coverage** (statement / decision / MC/DC) is
  a *certification artifact*, an obligation, not an aspiration.
- *NASA NPR 7150.2, "NASA Software Engineering Requirements,"* NASA Procedural
  Requirements. NASA's institutional software-engineering process requirements;
  classifies software and imposes traceability and verification obligations scaled
  to class.

What we import is **the traceability discipline, not the certification process.**
browxai is not seeking a DO-178C DAL; importing MC/DC coverage wholesale would be
exactly the speculative over-engineering architecture-principles §1 forbids. We
import the *structural* idea:

> Coverage of the architectural seam is a **structural property, not a hope.**

This is **L9 (traceable)** verbatim in intent. The concrete browxai obligation: every
world-touching tool ⇒ a capability declaration ⇒ a keystone denial test, **in the
same change**; every engine ⇒ a capability row ⇒ a keystone lane. The audit found
this chain is **asserted but unverified** — there is no test that every registered
tool has a `TOOL_CAPABILITY` entry (tools silently default to `human`), no test that
every `EngineKind` in `src/engine/types.ts:25` has a `CAPABILITIES` row, no
"engine-adapter-contract" keystone proving the OCP claim. The traceability fitness
tests (D9) are the DO-178C traceability matrix, scoped to the seam that matters: the
tool ↔ capability ↔ batch ↔ deep ↔ keystone chain.

The browxai precedent for this is already real and is *the* cited model: the
**capability-gate discipline** (architecture-principles §4) — *"a per-tool keystone
test asserting the gate blocks when not granted, in the same diff that adds it."*
RFC 0004 generalizes that single in-the-same-diff traceability rule into a structural
fitness test that *fails the build* when the chain has a gap.

### 1.4 MISRA C — the ruleset-enforced-by-a-static-analyzer model

**Source.** *MISRA C* (Motor Industry Software Reliability Association),
*Guidelines for the Use of the C Language in Critical Systems* (MISRA C:2012 and
later amendments/corrigenda). What it *is*: a large catalogue of rules and
directives, each classified (mandatory / required / advisory) and **each designed to
be checked by a MISRA-checking static analyzer** — the canonical industrial example
of "a coding standard *is* a tool configuration." Deviations are permitted only
through a documented, justified deviation process — never an undocumented inline
suppression.

browxai mapping: MISRA's two structural ideas are imported directly.
1. **The ruleset is the analyzer config.** This is RFC 0004's whole D8/D9/D11 thesis:
   the maintainability standard is not prose, it is the `eslint.config.js` rules, the
   `dependency-cruiser` config, and the `test/architecture/**` suite.
2. **Deviations go through a documented process, never an inline silence.** This is
   already browxai norm — code-quality.md's zero-ignores discipline ("no
   `eslint-disable` without justified comment") — and RFC 0004 §8 hardens it into the
   meta-rule: *a guardrail may only be relaxed via an RFC amendment with rationale,
   never an inline disable* (the `no-unsafe-*` rollout already established this norm).
   MISRA's "advisory vs required" tiering is the model for browxai's warn-then-error
   promotion.

The honest boundary: browxai imports MISRA's **enforcement model**, not its rule
*content* (MISRA's rules are about C integer promotion, pointer arithmetic, and
undefined behavior — irrelevant to TypeScript). The two custom rules browxai already
ships — `no-tracker-ids-in-comments` and `no-page-eval-stringified-arrow`
(`eslint.config.js:31,66`) — are browxai's *own* MISRA-style rules: project-specific
hazards (provenance rot; the dom_export/element_export stringified-arrow LSP trap)
encoded as analyzer checks. RFC 0004's new custom rules (`no-engine-literal-branches`,
the inlined-capability-gate rule) are the next entries in that same catalogue.

---

## 2. Design & maintainability canon

The classical literature that browxai's *doctrine* already embodies (mostly without
citing it) and that RFC 0004 makes explicit. The pattern across this section: the
audit found the doctrine is *right* and *unenforced* — these are the sources that
name *why* the doctrine is right, so a future reader (human or agent) can reason from
principle rather than from precedent.

### 2.1 Parnas, 1972 — information hiding

**Source.** D. L. Parnas, *"On the Criteria To Be Used in Decomposing Systems into
Modules,"* Communications of the ACM, vol. 15, no. 12, December 1972, pp. 1053–1058.
The founding paper of **information hiding**: a module's boundary should hide a
*design decision likely to change*, so a change to that decision is contained to one
module. This is the intellectual root of the Single Responsibility Principle and of
"one reason to change."

browxai mapping: **L3 (one reason to change)** and **D3 (split the god-modules)** are
Parnas applied. The doctrine already states it (architecture-principles §5: *"One
reason to change per module… If two unrelated reasons touch one file, split it."*).
The god-modules the audit found — `read-observe-tools.ts` (1965 LOC, 20 tools),
`emulation-config-tools.ts` (1107 LOC, mixing emulation / config / approvals /
secrets / captcha) — are precisely modules whose boundaries hide *several*
independently-changing decisions, the Parnas anti-pattern. The `SessionEntry`
segregation (D3) hides the engine-vs-mode decision behind role-bundles rather than
exposing 50+ fields to every consumer.

### 2.2 Dijkstra — separation of concerns

**Source.** E. W. Dijkstra, *"On the role of scientific thought"* (EWD447, 1974),
where the phrase "separation of concerns" is articulated as studying one aspect in
isolation "for the sake of its own consistency." The conceptual partner to Parnas.

browxai mapping: the **capability gate living in one place** (architecture-principles
§5; the gate is `gateCheck` on `ToolHost`, `src/tools/host.ts:71`) and the rule that
*a handler must not inline its own capability check* (code-quality.md SOLID §) are
separation-of-concerns made operational. The audit's finding that **no lint rule flags
an inlined `if (capabilities.includes(...))` in a handler** is the gap RFC 0004 closes
(the inlined-capability-gate custom rule) — the concern is separated by doctrine but
not by machine.

### 2.3 Lakos — large-scale physical design and levelization

**Source.** J. Lakos, *Large-Scale C++ Software Design* (Addison-Wesley, 1996; the
ideas are extended in his later *Large-Scale C++: Process and Architecture*, 2019).
The canonical treatment of **physical** (as opposed to logical) dependency: the
directed graph of which file/component depends on which must be **acyclic and
levelizable** — components sort into levels where each level depends only on lower
levels. Cyclic physical dependencies are the large-scale-design defect Lakos's
*levelization* techniques exist to break.

browxai mapping: **D10 (enforce the dependency graph)** is Lakos made executable.
The doctrine *asserts* the layering — "the core depends on nothing outward"
(architecture-principles §1) — but the audit found **no machine checks it**:
`.depcheckrc.json` checks for *unused* dependencies, not *import direction*; there is
no dependency-cruiser, no madge, no forbidden-import rules. RFC 0004 introduces
dependency-cruiser encoding the levels the doctrine names: `server.ts` / `tools/*` may
not import `sdk/*` or `cli/*`; `page/*` handlers may not import a concrete engine
adapter or a transport; `sdk/*` may not import handler internals; nothing imports
`cli/*` except the bin; the core never imports outward. This is the single
highest-leverage guardrail against dependency-inversion rot — Lakos's acyclic,
levelized physical graph, checked in CI.

### 2.4 Robert C. Martin — SOLID and Clean Architecture

**Sources.** R. C. Martin, the SOLID principles (consolidated across his writing,
1990s–2000s) and *Clean Architecture: A Craftsman's Guide to Software Structure and
Design* (Prentice Hall, 2017). The load-bearing import is **the Dependency Rule**:
source-code dependencies point only *inward*, toward higher-level policy; nothing in
an inner circle knows anything about an outer circle.

browxai mapping: the Dependency Rule *is* architecture-principles §1 ("the core
depends on nothing outward"). SOLID is the spine of code-quality.md's SOLID section
and of RFC 0004's ten laws — L1 (OCP, closed core), L4 (ISP, segregated contracts),
L5 (LSP, substitutable adapters), and the Dependency Rule (DIP) threaded through L1
and D10. The audit's central finding restated in Martin's terms: browxai's *logical*
SOLID is excellent (real ports, dependency inversion at the engine and transport and
plugin boundaries) but its **OCP is violated at the wiring layer** — the adapters are
closed for modification, but their *instantiation* (`if (engine === …)` across three
factories) is open-for-modification in exactly the place OCP forbids. RFC 0004's
`EngineRegistry` (D1) is the Open-Closed Principle finally honored at the wiring
layer, not just the class layer.

### 2.5 Cockburn — Hexagonal Architecture (Ports and Adapters)

**Source.** A. Cockburn, *"Hexagonal Architecture"* (also "Ports and Adapters,"
c. 2005, alistair.cockburn.us). The pattern: the application core defines **ports**
(interfaces it owns), and **adapters** on the outside conform to those ports;
the core is testable in isolation and ignorant of which adapter is attached.

browxai mapping: this is the **literal shape of browxai's seams**, and it is the most
directly-realized prior art in the codebase. The engine port (`BrowserEngine`,
RFC 0002), the transport port (`Transport`, three conforming adapters), the plugin
port (`PluginApi`), and the RFC 0003 capability substrates (`ActionSubstrate`,
`CaptureSubstrate`, `StorageSubstrate`, `ScriptSubstrate`, `EmulationSubstrate` —
all imported by `ToolHost`, `src/tools/host.ts:15-19`) are textbook ports-and-adapters.
RFC 0004 does not introduce hexagonal architecture; it **hardens the existing
hexagon** so the core *physically cannot* reach around a port (D10) and every adapter
*provably* honors its port (L5 / D5 — the Safari LSP leak where
`BrowserSession.page()` throws is an adapter that violates the port contract;
`src/session/types.ts:86` types `page()` as always-present while
`snapshot-substrate-select.ts:44` and `network-substrate-select.ts:44` already branch
on `session.engine === "safari"` to route around it). `requireCdp()`
(`src/engine/session-cdp.ts:26`) — which returns the CDP handle on a capable engine
and throws a structured, engine-naming error otherwise — is the existing exemplar of
"declare the gap as a capability, never throw a vague error," the LSP-honoring pattern
D5 generalizes.

### 2.6 The Pragmatic Programmer — DRY and orthogonality

**Source.** A. Hunt and D. Thomas, *The Pragmatic Programmer* (Addison-Wesley, 1999;
20th-anniversary ed. 2019). Origin of **DRY** ("Don't Repeat Yourself — every piece
of knowledge must have a single, unambiguous, authoritative representation") and the
**orthogonality** principle (unrelated things should be independent; a change to one
should not ripple to another).

browxai mapping: **L2 (single source of truth)** is DRY stated as a law. The audit's
T2 theme — hand-maintained central lists (`BATCH_ALLOWED_TOOLS`, `TOOL_CAPABILITY`
with 181 entries, `DEEP_TOOLS` in `src/engine/tool-gate.ts:38`, the 673-LOC
hand-mirrored SDK tool-types) — is a textbook DRY violation: the *same knowledge*
("this tool is batchable / deep / has this capability") is written in up to five
disjoint places, and every miss is silent. **D2 (metadata at registration; central
lists derived)** and **D7 (generate the SDK types)** are the single-authoritative-
representation fix. The audit's T4 theme (copy-paste families: five policy classes
with identical buffer+record, the 7-step action pattern repeated ~50×) is the same
violation at the code level, fixed by D4's `PolicyBuffer<T>` / `actionTool()` /
`EgressSanitiser` extractions. Orthogonality maps to the dependency layering (D10):
a change to a transport must not ripple into a handler.

### 2.7 Fowler — refactoring and the strangler fig

**Sources.** M. Fowler, *Refactoring: Improving the Design of Existing Code*
(Addison-Wesley, 1999; 2nd ed. 2018) — the catalogue of behavior-preserving
transformations; and M. Fowler, *"StranglerFigApplication"* (martinfowler.com, 2004) —
the pattern of growing a new system *around* the edges of an old one, incrementally,
until the old one can be removed, named after the strangler fig that grows around a
host tree.

browxai mapping: the **strangler-fig pattern is RFC 0004's phasing model** (§6) and
is *already the proven browxai method* — RFC 0002 extracted the first engine adapter
"`PlaywrightChromiumAdapter` with **zero behavior change** (strangler-fig)," and
RFC 0003 moved the capability substrates the same way. RFC 0004 §6 inverts the usual
instinct (guardrails land *first*, P0, so the refactor is performed against the
fitness functions that keep it true) but the per-phase discipline is pure Fowler:
each phase is a behavior-preserving refactoring, gate-green, with the five-engine
keystones as the regression gate throughout. The non-goal "no behavior change — every
refactor step is byte-identical per engine" (RFC 0004 §3) is the definition of a
refactoring in Fowler's sense.

### 2.8 Feathers — seams

**Source.** M. Feathers, *Working Effectively with Legacy Code* (Prentice Hall,
2004). Defines a **seam**: "a place where you can alter behavior in your program
without editing in that place" — the unit of testability and of safe change in code
that lacks tests.

browxai mapping: the entire RFC 0004 vocabulary of "the seams are mostly real" (RFC
0004 §0) is Feathers's seam. The doctrine's "proven seam" test
(architecture-principles §1 — *"is there a second real implementation today?"*) is the
discipline that decides *where* a seam earns its keep. The audit's framing — "the
defect is their *wiring*, not the adapters" — is precisely Feathers: the seams exist
(the ports), but the code reaches *around* them (`page()` direct calls bypassing the
substrates; inlined engine literals bypassing the registry), so the alteration point
is not where the seam is. D1 / D5 move every alteration back onto the seam.

---

## 3. Evolutionary architecture & fitness functions

This is the **load-bearing import** of the entire RFC. Everything in §1–§2 explains
*what good structure is*; this section is *how you keep it after the structure is
built*, which is the actual problem the audit's meta-finding (T7 — "the guardrail
vacuum") identified.

### 3.1 Building Evolutionary Architectures — Ford, Parsons, Kua, 2017

**Source.** N. Ford, R. Parsons, P. Kua, *Building Evolutionary Architectures*
(O'Reilly, 2017; 2nd ed. with Pramod Sadalage, 2022). The book that names and
operationalizes the **architectural fitness function**: an objective, automated test
that measures whether the architecture still exhibits a characteristic you care about
(an *-ility* — maintainability, the absence of cyclic dependencies, layering
integrity, performance budgets). A fitness function *fails the build when the
characteristic regresses*, turning an architectural principle from a hope into a
gate.

browxai mapping: this is **D9** ("every architectural invariant gets an executable
fitness function") and the answer to the audit's T7. RFC 0004 §1 names it as "the
load-bearing import for browxai." Every one of the ten laws is paired with a fitness
function or gate (RFC 0004 §4's Enforcer column); the suite lives in
`test/architecture/**` as a first-class part of `pnpm test`. The framing that closes
the loop, from RFC 0004 §0: *"the architecture drifted exactly where no machine was
watching."* The fitness function is the machine. The book's taxonomy maps directly:
- *Atomic* fitness functions (single context) → the per-rule checks: file-size
  budget, complexity budget, the `no-engine-literal-branches` lint rule.
- *Holistic* fitness functions (multiple dimensions together) → the
  engine-adapter-contract keystone (a synthetic sixth engine that must work with zero
  core edits — it exercises the registry, the gate, the substrates, and the
  capability matrix at once).
- *Triggered* vs *continuous* → browxai runs the architecture suite continuously in
  the fast `pnpm test` lane (static AST/graph/string analysis, no browser) per
  RFC 0004 §8's "the fitness suite is slow" mitigation.

### 3.2 ArchUnit and dependency-cruiser — executable architecture

**Sources.**
- *ArchUnit* (archunit.org) — a JVM library for asserting architectural rules as unit
  tests: "no class in package `..service..` may access `..controller..`," cyclic-
  dependency checks, layer-access rules, all expressed as ordinary JUnit tests. The
  reference implementation of "architecture as a test."
- *dependency-cruiser* (sverweij/dependency-cruiser, npm) — the JS/TypeScript
  analogue: validates and visualizes the module dependency graph against a declarative
  ruleset (`forbidden` rules with `from` / `to` path patterns), runnable in CI.

browxai mapping: dependency-cruiser is the **named tool for D10** (RFC 0004 §5:
"introduce `dependency-cruiser` (or an equivalent custom check)"). ArchUnit is cited
as the *lineage* — the proof that "architecture expressed as an executable test" is a
mature, industrial practice, not a browxai invention — and as the conceptual model
for the `test/architecture/**` suite that goes beyond pure import-graph rules
(completeness, port-conformance, traceability) into ArchUnit-style structural
assertions. The concrete dependency-cruiser ruleset is specified in
[`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md).

### 3.3 Property-based testing — QuickCheck / fast-check

**Sources.** K. Claessen and J. Hughes, *"QuickCheck: A Lightweight Tool for Random
Testing of Haskell Programs,"* ICFP 2000 — the origin of property-based testing
(assert a *property* that must hold for all inputs; the framework generates and
shrinks counterexamples). *fast-check* (dubzzz/fast-check, npm) — the modern
TypeScript/JavaScript property-based testing library in the QuickCheck lineage.

browxai mapping: property-based testing is the **"test the invariants, not the
examples"** layer for **L7 / L8**. The audit found concrete gaps a property test
closes: `perf-audit.ts`'s token-budget algorithm has *no termination invariant or
size bound* ("a bad estimate could cause an infinite loop or memory pressure; no
fuzzing or property-based test validates the algorithm's termination"). The browxai
property obligations are bounded and specific — e.g. *"for all inputs, the perf-audit
report size never exceeds 2.5× the summary token budget"*; *"for all action programs,
the ring buffer never exceeds its cap"* — exactly the bounded-resource properties L7
requires, expressed as universally-quantified tests rather than hand-picked examples.
This is a *targeted* import (the load-bearing bounded algorithms), not a mandate to
property-test everything — per architecture-principles §1, no speculative machinery.

### 3.4 Mutation testing — Stryker

**Sources.** R. A. DeMillo, R. J. Lipton, F. G. Sayward, *"Hints on Test Data
Selection: Help for the Practicing Programmer,"* IEEE Computer, 1978 — the founding
mutation-testing paper (seed faults; a good test suite kills the mutants). *StrykerJS*
(stryker-mutator.io) — the JavaScript/TypeScript mutation-testing framework.

browxai mapping: mutation testing is the **"test the tests"** layer — it answers
"does the fitness suite actually *catch* a regression, or does it pass vacuously?" The
risk is real and named in RFC 0004 §8: a fitness function that passes today by
*freezing* the existing maps (P0 lands the completeness/traceability tests "as
failing — they pass today for the existing maps; they just freeze them") could be
asserting nothing. Mutation testing applied to the architecture suite — seed an
`if (engine === "safari")` into a handler, seed a tool missing from `TOOL_CAPABILITY`,
seed a forbidden cross-layer import — verifies the guardrails *kill the mutant*. This
is the highest-assurance, highest-cost layer and is scoped accordingly: applied to the
fitness suite and the load-bearing gate logic, not the whole tree.

---

## 4. Tooling landscape

The concrete tools the guardrail layer (RFC 0004 D8–D12) is built from, what each
gives, and which guardrail in
[`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md)
consumes it. The audit's harness-and-docs subsystem confirmed **none of the
architecture-specific tools below exist in the tree today** — that absence *is* the
guardrail vacuum.

| Tool | What it gives | browxai guardrail (0004-05) | Status today |
|---|---|---|---|
| **dependency-cruiser** | Declarative `forbidden` import-graph rules; CI-runnable; graph visualization. | **D10** dependency layering — the levelized core/adapter/sdk/cli rules. | **Absent.** `.depcheckrc.json` checks unused deps only, not direction. |
| **ArchUnit** *(lineage / model)* | JVM precedent for architecture-as-test; the conceptual template for structural assertions beyond import rules. | The `test/architecture/**` suite's structure (completeness, port-conformance, traceability). | Lineage only — browxai writes the equivalent in vitest. |
| **jscpd** | Copy-paste / duplication detection with a configurable token threshold and a budget. | **D4 / L2** duplication budget in CI (the copy-paste families: 5 policy classes, the 7-step action pattern). | **Absent.** No duplication gate. |
| **ts-prune / knip** | Dead-export and unused-file detection for TypeScript. | Dead-code hygiene supporting **L2/L3** (orphaned capabilities, stale `TOOL_CAPABILITY` rows, unused exports). | **Absent.** The audit flags orphaned-capability and stale-entry risk with no detector. |
| **StrykerJS** | Mutation testing — seeds faults, reports surviving mutants. | The "test the tests" assurance layer on the fitness suite and the gate logic (§3.4). | **Absent.** |
| **fast-check** | Property-based testing with generation + shrinking. | **L7/L8** bounded-resource and termination properties (the perf-audit token-budget bound). | **Absent.** |
| **typescript-eslint type-aware rules** | The `no-unsafe-*` family, `no-explicit-any`, `no-floating-promises`, etc. — boundary type-safety. | **L6** validate-at-the-edge; the five `no-unsafe-*` rules now at `error`. | **Present and at `error`** — the one piece already landed; L6's enforcer exists. |
| **eslint built-in budgets** | `max-lines`, `max-lines-per-function`, `complexity`, member-count via custom rule. | **L3 / L4 / D11** size, function-length, complexity, interface-member budgets. | **Absent.** No file-size or complexity budget; `server.ts` has no enforced ceiling (only a `require-await` exemption, `eslint.config.js`). |
| **eslint custom rules** *(browxai-local)* | Project-specific hazard checks as analyzer rules. | **L1** `no-engine-literal-branches`; the inlined-capability-gate rule. | **Two exist** (`no-tracker-ids-in-comments`, `no-page-eval-stringified-arrow`, `eslint.config.js:31,66`); the OCP rules are new. |
| **vitest (architecture suite)** | The runner for the completeness / port-conformance / traceability / OCP-contract fitness tests. | **D9** the whole `test/architecture/**` suite + the engine-adapter-contract keystone. | **Absent** as an architecture suite; vitest itself runs the 1834 unit + 22 keystone tests. |

The single highest-leverage additions, in audit-severity order: **dependency-cruiser**
(D10 — the DIP ratchet), the **engine-adapter-contract keystone** (L1 — proves the OCP
claim the doctrine *makes but does not verify*), and the **completeness fitness tests**
(L2 — close four OCP findings at once by deriving the central maps).

---

## 5. Internal prior art

The most important prior art is browxai's own. RFC 0004 is not importing discipline
into an undisciplined codebase; it is **mechanizing a doctrine that is already
written and already partially proven**. Each internal precedent below is a pattern
RFC 0004 *generalizes*, not invents.

### 5.1 RFC 0002 — the `BrowserEngine` port and the strangler-fig precedent

[`0002-multi-engine-bidi.md`](../0002-multi-engine-bidi.md) established two things
RFC 0004 builds on directly:
1. **The engine port itself** (`BrowserEngine`, the capability-segregated interface;
   `EngineKind` at `src/engine/types.ts:25`; the per-engine `EngineCapabilities`
   declarations and `capabilitiesFor()` at `src/engine/capabilities.ts:36,125`). This
   is the seam RFC 0004 D1 closes the *wiring* behind — the adapters RFC 0002 built
   are exactly the "parts that are right" RFC 0004 §3 refuses to rewrite.
2. **The strangler-fig method, proven twice** (Chromium adapter extracted with zero
   behavior change; Firefox, WebKit, Android landed as adapters without touching the
   tool surface). RFC 0004 §6 adopts this method wholesale and adds the guardrail-first
   inversion. RFC 0002's "engine declares its capabilities rather than assuming them"
   is the direct ancestor of D2's "tools self-declare metadata at registration."

The crucial honest note RFC 0004 inherits from RFC 0002: the multi-engine work *also*
introduced the very coupling RFC 0004 fixes — the `if (engine === …)` chains in the
session factories (`managed.ts:26,35`, `byob.ts:154,162`, `incognito.ts:25,33`) and the
substrate-select engine branches (`snapshot-substrate-select.ts:44`,
`network-substrate-select.ts:44`) are the *expected* shape of a fourth/fifth engine
landed under a green-but-OCP-blind gate. RFC 0002 did the right thing (real adapters);
the missing guardrail let the *wiring* drift. This is the cleanest possible evidence
for the T7 meta-finding.

### 5.2 RFC 0003 — the capability substrates

[`0003-capability-ports-decoupling.md`](../0003-capability-ports-decoupling.md)
introduced the five capability substrates (`ActionSubstrate`, `CaptureSubstrate`,
`StorageSubstrate`, `ScriptSubstrate`, `EmulationSubstrate`) that `ToolHost` composes
(`src/tools/host.ts:15-19`) and that `SessionEntry` carries (`snapshotSubstrate`,
`networkSubstrate`, `src/session/registry.ts`). RFC 0004 leans on them in two ways:
1. **They are the real contract D5 enforces.** The Safari LSP leak (`page()` throws) is
   a bug *because* the substrates are the intended path — callers should never reach
   `page()` directly; the residual direct calls are the defect. RFC 0004 D5 closes the
   leak by making `page()` an engine-declared capability and routing the guards into
   the registry's `postWire`.
2. **The module decomposition RFC 0003 produced is explicitly flagged as interim.**
   RFC 0004 §5 D3 notes the coarse `src/tools/*` modules are "an artifact of RFC 0003's
   line-range decomposition, explicitly flagged as thematically loose at the time" —
   D3 finishes that decomposition toward one-family-per-module. RFC 0004 is the
   *completion* of RFC 0003's seam work, not a reversal of it.

### 5.3 architecture-principles.md and code-quality.md — the doctrine extended

[`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md)
(macro) and [`code-quality.md`](../../ai-context/agent-process/code-quality.md) (micro)
are the doctrine RFC 0004 **extends and operationalizes, never replaces** (RFC 0004 D8).
The relationship is precise:
- architecture-principles §1 (dependency direction), §2 (proven-seam test, anti-
  speculation), §4 (scalability seams — *"new engine = new adapter"*), and §5 (one
  reason to change) are the *logical* statements of L1, L3, L4, and the Dependency
  Rule. RFC 0004 adds the *mechanized enforcer* column those sections never had.
- The doctrine's own flagship OCP example — *"the `perf_audit` pluggable analyser
  registry is the canonical example"* (architecture-principles §2; code-quality.md
  SOLID §) — is, per the audit, **stringly-typed and edited per category in its
  implementation** (the `ANALYSERS` map). RFC 0004 D6 makes the cited exemplar
  *actually exemplary*. This is the sharpest illustration of "doctrine right,
  enforcement absent."
- code-quality.md's **zero-ignores discipline** and **public-surface hygiene** (no
  tracker IDs, no phase tags in anything a user/agent reads) are the norms RFC 0004's
  meta-rule (§8) and custom lint rules build on.

D12 ships the doctrine update: architecture-principles §7's review checklist gains the
ten laws and their enforcers; code-quality.md gains an "Architecture enforcement"
section (the audit found the guardrails are "not consolidated or made visible" — the
rules are scattered across architecture docs and agent skills); a new
`docs/ai-context/architecture/fitness-functions.md` becomes the index of executable
invariants. Specified in
[`0004-06-ai-documentation-and-harness.md`](0004-06-ai-documentation-and-harness.md).

### 5.4 The existing custom ESLint rules — the custom-rule precedent

browxai already ships two `browxai-local` custom ESLint rules
(`eslint.config.js:31,66`, wired at `:110-111`, `error` from day one at `:148-149`,
`:242-243`):
- **`no-tracker-ids-in-comments`** — encodes the public-surface-hygiene hazard
  (provenance rot) as an analyzer check.
- **`no-page-eval-stringified-arrow`** — encodes the dom_export/element_export
  root-cause class (a stringified arrow passed to `page.evaluate` loses its closure and
  silently mis-evaluates — an LSP violation of the page-side-function contract).

These are the **proof that browxai already practices the MISRA model** (§1.4): a
project-specific hazard, once understood, becomes an analyzer rule that *fails the
build*, not a code-review checklist item that erodes. RFC 0004's new rules —
`no-engine-literal-branches` (L1) and the inlined-capability-gate rule — are the next
two entries in the same browxai-local catalogue, written against hazards the audit
found (the `if (engine === …)` leak; the inlined `capabilities.includes(...)` bypass).
The precedent matters: it means the OCP rules are *the same kind of thing* the team
already maintains, not a new category of machinery.

### 5.5 The keystone discipline — the real-browser fitness gate precedent

The keystone lane (`test/keystone/**`, 22 tests, `vitest.keystone.config.ts`) is the
**existing precedent for a fitness gate that verifies a claim against reality rather
than asserting it.** Its established uses:
- The **page-side-function discipline** designates keystone as *"the regression gate
  for evaluate-serialization bugs"* — a structural claim (every `page.evaluate`-calling
  tool works against real Chromium) verified, not hoped.
- The **determinism claim** (recorder/replay, byte-identical runs) is *"keystone-tested
  against real Chromium so the determinism claim is verified, not asserted"*
  (architecture-principles §3) — this is **L10** already practiced.
- The **per-engine keystone lanes** (Firefox, WebKit, Android, Safari) verify the
  capability matrix per engine.

RFC 0004 extends this proven gate in two directions: the **engine-adapter-contract
keystone** (L1 / D9 — a synthetic sixth engine that must register and work with zero
core edits, the holistic fitness function that finally *verifies* the "new engine = new
adapter" claim the audit found is **false today** because a sixth engine touches 5–8
files), and the **port-conformance contract test** (L5 / D5 — run against every adapter
including a synthetic one, forbidding a port method that throws unconditionally).
The keystone discipline is the template; RFC 0004 adds the architectural assertions it
was missing.

---

## 6. Summary mapping table — external practice → browxai law / decision / guardrail

The complete cross-reference. Read this table as the answer to "where did *this* rule
come from, and what makes it real in browxai?"

| External practice | Source (author / title / year / venue) | browxai law / decision / guardrail it grounds |
|---|---|---|
| Power of Ten — simple control flow (rule 1) | Holzmann, *Power of Ten*, IEEE Computer, 2006 | **L1** closed core; `no-engine-literal-branches` lint rule |
| Power of Ten — bounded loops (rules 2–3) | Holzmann, 2006 | **L7** bounded everything; bounded-resource budget tests (adapted: "no unbounded growth," GC runtime) |
| Power of Ten — small functions (rule 4) | Holzmann, 2006 | **L3 / D11** size & complexity budgets (`max-lines`, `complexity`) |
| Power of Ten — assertion density (rule 5) | Holzmann, 2006 | **L8** `invariant()` + density check on load-bearing modules (relaxed floor) |
| Power of Ten — check returns / validate params (rule 7) | Holzmann, 2006 | **L6** validate-at-edge; the `no-unsafe-*` rules + `z.infer` handler typing |
| Power of Ten — clean compile, all analyzers max (rule 10) | Holzmann, 2006 | **The meta-rule**; the zero-ignores gate extended with the architecture analyzers |
| Layered ruleset, each rule tied to an analyzer | *JPL Institutional Coding Standard*, DOCID D-60411 | The Law→Enforcer column; warn-then-error phased landing (D8/D11) |
| Bidirectional requirements traceability; coverage as obligation | DO-178C / ED-12C, RTCA/EUROCAE, 2011; NASA NPR 7150.2 | **L9** traceability fitness tests (tool↔capability↔keystone; engine↔caps↔lane) |
| Ruleset = static-analyzer config; documented deviations only | MISRA C:2012 | **D8/D9/D11** standard-as-analyzer-config; the meta-rule (relax only via RFC amendment) |
| Information hiding (module hides a changing decision) | Parnas, CACM, 1972 | **L3 / D3** split the god-modules; segregate `SessionEntry` |
| Separation of concerns | Dijkstra, EWD447, 1974 | **L3**; the single-place capability gate; inlined-gate lint rule |
| Levelization / acyclic physical dependency | Lakos, *Large-Scale C++ Software Design*, 1996 | **D10** dependency-cruiser layering rules |
| SOLID + the Dependency Rule | R. C. Martin, *Clean Architecture*, 2017 | **L1/L4/L5** + DIP threaded through D10; the `EngineRegistry` (D1) honoring OCP at the wiring layer |
| Hexagonal / Ports and Adapters | Cockburn, "Hexagonal Architecture," c. 2005 | The engine / transport / plugin / substrate ports (RFC 0002/0003); D5/D10 harden the hexagon |
| DRY + orthogonality | Hunt & Thomas, *The Pragmatic Programmer*, 1999 | **L2** single source of truth (D2 metadata-at-registration, D7 codegen); D4 copy-paste collapse |
| Refactoring catalogue + strangler fig | Fowler, *Refactoring*, 1999/2018; "StranglerFigApplication," 2004 | RFC 0004 §6 phasing; the byte-identical behavior-preservation non-goal |
| Seams | Feathers, *Working Effectively with Legacy Code*, 2004 | The "seams real, wiring wrong" diagnosis; D1/D5 move alteration back onto the seam |
| Architectural fitness functions | Ford, Parsons, Kua, *Building Evolutionary Architectures*, 2017 | **D9** — the load-bearing import; `test/architecture/**` |
| Architecture-as-test tooling | ArchUnit (JVM, lineage); dependency-cruiser (JS/TS) | **D10** dependency-cruiser config; the `test/architecture/**` structural assertions |
| Property-based testing | Claessen & Hughes, QuickCheck, ICFP 2000; fast-check | **L7/L8** bounded-resource & termination properties (perf-audit token budget) |
| Mutation testing | DeMillo/Lipton/Sayward, IEEE Computer, 1978; StrykerJS | "Test the tests" on the fitness suite + gate logic |
| Type-aware boundary linting | typescript-eslint `no-unsafe-*` | **L6** — the one enforcer already landed |
| `BrowserEngine` port + strangler-fig (internal) | [`0002-multi-engine-bidi.md`](../0002-multi-engine-bidi.md) | **D1** wiring closed behind the port; §6 method; the T7 evidence |
| Capability substrates (internal) | [`0003-capability-ports-decoupling.md`](../0003-capability-ports-decoupling.md) | **D5** substrates are the contract; D3 completes the decomposition |
| The doctrine (internal) | [`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md), [`code-quality.md`](../../ai-context/agent-process/code-quality.md) | Extended by **D8/D12**; the enforcer column the doctrine lacked |
| Custom ESLint rules (internal precedent) | `no-tracker-ids-in-comments`, `no-page-eval-stringified-arrow` (`eslint.config.js:31,66`) | **L1** — the custom-rule pattern the OCP rules extend |
| Keystone real-browser gate (internal precedent) | `test/keystone/**` (22 tests); page-side-function & determinism gates | **L1/L5/L9/L10** — the engine-adapter-contract & port-conformance keystones |

---

## Related

- [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) — the parent
  RFC: the thesis, the ten laws (L1–L10), the decisions (D1–D12), the phasing.
- [`0004-01-current-state-audit.md`](0004-01-current-state-audit.md) — the 80 findings
  and the file:line evidence this document's mappings answer.
- [`0004-02-maintainability-standard.md`](0004-02-maintainability-standard.md) — the
  full standard; the Power-of-Ten / JPL / DO-178C lineage in depth (this document is
  its citation record).
- [`0004-05-fitness-functions-and-guardrails.md`](0004-05-fitness-functions-and-guardrails.md) —
  the executable realization of every tool and practice cited here.
- [`0004-06-ai-documentation-and-harness.md`](0004-06-ai-documentation-and-harness.md) —
  where the doctrine docs (§5.3) are edited to encode the standard.
- [`0004-08-future-proofing.md`](0004-08-future-proofing.md) — how the hardened seams
  absorb the next engine / transport / capability class add-only.
