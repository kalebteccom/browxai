# Fitness functions — the executable architecture invariants

An _architectural_ characteristic browxai cares about gets an automated test that
**fails when the characteristic regresses** — the evolutionary-architecture import
at the heart of [RFC 0004](../../rfcs/0004-architecture-hardening.md). This page is
the index: every fitness function, custom lint rule, dependency-cruiser rule,
budget, and CI gate — what it proves, where it lives, how to run it, which law
(L1–L10) it enforces, and the audit finding it closes. It is the answer to _"what
breaks if my change is not as add-only as I think it is."_ Read this before any
change that moves a boundary; run the architecture lane before you assume it
didn't.

The architecture lane is **static and fast** — AST / dependency-graph / string
analysis, no browser — and runs inside `pnpm test` (the files live under
`test/architecture/**`). The one exception is the `engine-adapter-contract`
keystone, which exercises a synthetic in-memory engine through real core tools and
runs in `pnpm test:keystone`.

## The map — fitness tests (`test/architecture/**`, run via `pnpm test`)

| Fitness function               | What it proves                                                                                                                                                                                                      | File                                   | Enforces     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------ |
| `ocp-engine-contract`          | A synthetic 6th engine, registered without editing `src/session/*` or `src/tools/*`, drives the core tool surface. A core tool that leaked engine logic fails here.                                                 | `ocp-engine-contract.test.ts`          | L1 · D1      |
| `port-conformance`             | Every substrate adapter (action / capture / storage / script / emulation), including a synthetic one, honors its port — no method throws where the port promises a value.                                           | `port-conformance.test.ts`             | L5 · D5      |
| `tool-capability-completeness` | Every tool registered via `host.register` has an explicit, derived capability (no silent `human` fallback); no stale entries for removed tools.                                                                     | `tool-capability-completeness.test.ts` | L2/L9 · D2   |
| `batch-allow-completeness`     | `BATCH_ALLOWED_TOOLS` is derived from `{ batchable }` at registration and element-identical to the frozen set.                                                                                                      | `batch-allow-completeness.test.ts`     | L2 · D2      |
| `deep-tools-engine-matrix`     | Every `DEEP_TOOLS` member is refused on the non-deep engines and allowed on the deep ones (the engine gate is complete).                                                                                            | `deep-tools-engine-matrix.test.ts`     | L2/L9 · D1   |
| `interface-member-budget`      | Each segregated `ToolHost` sub-port stays under the member ceiling; `ToolHost` declares zero own members (it is the pure intersection — no god-object re-forms).                                                    | `interface-member-budget.test.ts`      | L4 · D3      |
| `no-extensibility-switch`      | The CLI / transport / config-layer / analyser dispatch is add-only registries, not extensibility `switch`es.                                                                                                        | `no-extensibility-switch.test.ts`      | L1/OCP · D6  |
| `gate-bootstrap`               | The capability/engine gate fails **safe** (refuses), never open, on an unbootstrapped map.                                                                                                                          | `gate-bootstrap.test.ts`               | L1 · D1      |
| `server-isolation`             | Two `createServer()` instances in one process do not cross-wire (per-server caps / workspace / origin policy stay bound to their own server).                                                                       | `server-isolation.test.ts`             | L4/DIP · D1  |
| `plugin-info-gate`             | The plugin-info surface is gated and does not leak un-namespaced plugin tools.                                                                                                                                      | `plugin-info-gate.test.ts`             | L1/L9        |
| **`assertion-density`**        | Every load-bearing module carries at least the invariant-density floor (`invariant()` calls on the contracts it depends on); the helper exports `invariant` + `InvariantError`.                                     | `assertion-density.test.ts`            | **L8**       |
| **`bounded-resource`**         | The perf-audit token budget terminates and stays ≤ 2.5× `SUMMARY_TOKEN_BUDGET` on adversarial input; the a11y walk is depth-capped (`MAX_WALK_DEPTH`); the network ring is capped (positive cap, never exceeds it). | `bounded-resource.test.ts`             | **L7** · D11 |

## The map — custom lint rules (`eslint.config.js`, run via `pnpm lint`)

| Rule                                                                                                       | What it proves                                                                                                                              | Level                 | Enforces    |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------- |
| `no-engine-literal-branches`                                                                               | No handler branches on an engine literal (`engine === "safari"`) outside the whitelisted engine-select layer.                               | `error`               | L1 · D1     |
| `no-inlined-capability-checks`                                                                             | No handler inlines a capability check (`caps.enabled.has(…)`, `TOOL_CAPABILITY[…]`) around the shared gate.                                 | `error`               | L1/L3 · D2  |
| **`bounded-resource`**                                                                                     | Flags a `while` / `do-while` / classic `for` with no counter test and no `cap`/`bound` comment nearby — prompts a human to state the bound. | **`warn` (advisory)** | **L7**      |
| `max-lines` / `max-lines-per-function-registration-aware` / `complexity-registration-aware` / `max-params` | File-size / function-length / complexity / parameter budgets on the tool + page layers; `server.ts` ≤ 400.                                  | `error`               | L3/L4 · D11 |
| `no-page-eval-stringified-arrow`                                                                           | `page.evaluate` gets a function, never a stringified arrow (closure-loss footgun).                                                          | `error`               | L6          |
| `no-unsafe-*` (×5) + `no-explicit-any`                                                                     | Untyped wire/config/CDP data is narrowed at the edge; no `any` past it.                                                                     | `error`               | L6          |
| `no-tracker-ids-in-comments`                                                                               | Comments carry the reason, not a PM tracker ID.                                                                                             | `error`               | (hygiene)   |

> The `bounded-resource` lint rule is **advisory (`warn`), never `error`** — a
> linter cannot prove termination (the halting problem), so it _forces a human
> decision at the loop_ rather than blocking the build (0004-05 §1.3). The PROOF of
> a bound is the `bounded-resource.test.ts` budget test plus the `invariant()`
> termination check, not this rule. It is scoped to `src/page/**` / `src/util/**`,
> where the rings, walks, and waits live.

## The map — dependency layering (`.dependency-cruiser.cjs`, run via `pnpm depcruise`)

| Rule                                                    | What it proves                                                   | Enforces     |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ------------ |
| `no-server-or-tools-to-sdk-or-cli`                      | `server.ts` / `tools/*` do not import `sdk/*` or `cli/*`.        | L4/L10 · D10 |
| `no-page-handler-to-engine-adapter-or-transport`        | `page/*` does not import a concrete engine adapter or transport. | L4 · D10     |
| `no-sdk-to-handler-internals`                           | `sdk/*` does not import handler internals.                       | L4 · D10     |
| `core-imports-inward-only` / `only-the-bin-imports-cli` | The core depends inward; only the bin imports `cli/*`.           | L4/DIP · D10 |
| `no-circular`                                           | No import cycles.                                                | L4 · D10     |

## How to use this map

- **Adding a tool?** `tool-capability-completeness` and `batch-allow-completeness`
  fail if you forget the capability or let the derived set drift. You will not get
  a silent `human` fallback — the test names the missing tool.
- **Adding an engine?** `ocp-engine-contract` proves you did not need to edit a
  session factory; `deep-tools-engine-matrix` and the capability completeness tests
  fail fast if a row is missing. If you found yourself editing
  `src/session/managed.ts`, the registry pattern
  ([0004-03](../../rfcs/references/0004-03-ocp-registry-patterns.md)) is the seam
  you missed.
- **Adding a loop, ring, buffer, or recursion?** Give it an explicit bound, assert
  the bound with `invariant()` from `src/util/invariant.ts`, and pin it with a case
  in `bounded-resource.test.ts` (exhibit the bound — drive the resource past the cap
  and assert the contained behaviour, never just read the constant). The
  `bounded-resource` lint rule will prompt you (advisory) if you forget the bound
  comment.
- **Asserting an internal contract?** Use `invariant(cond, msg)` — it throws a
  structured `InvariantError` (the `DeadlineError` idiom), which the dispatch
  boundary renders as a `ToolResponse` refusal, never a crash. Assert only what the
  code already guarantees on valid inputs (so it is a no-op in production); the
  `assertion-density` floor checks the load-bearing modules carry their invariants.
- **Moving a boundary?** The dependency-cruiser rules are the gate. A new cross-layer
  import fails the graph; the message names the rule.

## The meta-rule

A fitness function is _frozen doctrine_. You do not edit it to make your change
pass; you change your code. The only legitimate edits are: (a) a new function for a
new invariant, (b) a budget tightened as modules shrink, (c) an RFC amendment that
changes a law — with rationale recorded in [`../../rfcs/`](../../rfcs/). An inline
disable of an architecture check, or a relaxed budget in a feature PR, is the one
thing this file forbids outright (the JPL deviation discipline,
[0004-02](../../rfcs/references/0004-02-maintainability-standard.md) §2). The PR-time
`architecture-fitness-auditor` agent
(`.agents/skills/architecture-fitness-auditor.md`) re-runs this lane against the
diff as a backup to the local gate.

## Related

- [`architecture-principles.md`](architecture-principles.md) — §4a, the ten laws
  these functions enforce.
- [`module-and-file-size.md`](module-and-file-size.md) — the `max-lines` budget
  in depth: its glob coverage, the ratchet path, and how to split along the
  second responsibility.
- [`hexagonal-and-ddd.md`](hexagonal-and-ddd.md) — the layer map the
  dependency-cruiser and engine-literal rules hold in place.
- [`../agent-process/code-quality.md`](../agent-process/code-quality.md) —
  "Architecture enforcement," the guardrail-to-command table.
- [`../../rfcs/0004-architecture-hardening.md`](../../rfcs/0004-architecture-hardening.md)
  and
  [`references/0004-05-fitness-functions-and-guardrails.md`](../../rfcs/references/0004-05-fitness-functions-and-guardrails.md)
  — the design record and the executable specs.
