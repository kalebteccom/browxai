# Module and file size discipline

A file over its budget is almost always doing two jobs. The size cap is a proxy
for the real rule — **one reason to change per module**
([`architecture-principles.md`](architecture-principles.md) §7, law L3) — and a
mechanically-enforced backstop for it. This is the Kalebtec family standard
(browxai-cloud enforces the same shape on its Rust crates); browxai applies it to
its TypeScript tree through the ESLint `max-lines` budget.

## The budget

Enforced in `eslint.config.js`, run via `pnpm lint`, sized with
`skipBlankLines` + `skipComments` so the number is _code_ lines, not whitespace:

| Scope | Cap (code lines) | Notes |
| --- | --- | --- |
| `src/server.ts` (composition root) | **400** → ratcheting to 250 | wiring-only; any business-logic creep trips it |
| source `*.ts` across the covered tree | **450** → ratcheting to ~320 | the per-file ceiling |
| `register*Tools` registration wrappers | **exempt** | a flat registration list has one reason to change already |
| `*_FN` page-side function literals | **exempt** from complexity | a `page.evaluate` function cannot be reduced by extraction without breaking the serialization contract |
| `*.test.ts` | higher / out of scope | colocated tests carry table-driven bulk legitimately |

The companion per-function budgets in the same block —
`max-lines-per-function-registration-aware` (70),
`complexity-registration-aware` (15), `max-params` (5) — enforce the same
one-job rule at the function grain. A function that needs blank-line section
dividers is two functions.

## Coverage is half the rule

A budget only bites the files it is globbed onto. browxai's `max-lines: 450`
block currently covers `src/tools/*-tools.ts` + `src/page/**` (+ `server.ts` at
400); `src/util`, `src/session`, `src/sdk`, `src/plugin`, `src/cli`, and the
non-`*-tools.ts` composition files under `src/tools` are **uncovered** — which is
exactly how the largest modules grew unseen. **Widening the glob is a
first-class part of this discipline:** the gate must _see_ every production
source file before the ceiling means anything. New code lands inside the covered
globs; the open work is bringing the historically-uncovered dirs under the same
ceiling.

## The ratchet, not the cliff

The cap moves in two independent axes, and they move in this order, never in one
jump (each step lands on a green `pnpm lint`):

1. **Widen coverage at 450.** Bring the uncovered dirs under the file-size
   ceiling, holding the number. Any file already over 450 is allowlisted by exact
   path with a `// TODO(cap): split — <reason>` so the debt is _parked and
   visible_, never silently passing — and no **new** oversized file can be added
   anywhere.
2. **Lower the ceiling as modules shrink.** As god-files split, drop the global
   ceiling in honest steps (450 → 400 → 360 → ~320) and `server.ts` toward 250.
   A budget tightened as the tree shrinks is the legitimate edit; relaxing one to
   land a feature is the one thing forbidden
   ([`fitness-functions.md`](fitness-functions.md), the meta-rule).

The endpoint is ~320 global / 250 server / the registration and `*_FN`
exemptions preserved. It stops at ~320, not lower, on purpose — see the
counter-rule.

## How to split — along the second responsibility

The fix for an over-budget file is never "delete blank lines." Find the **second
reason to change** and move it to its own file:

- **Realm split.** A session policy file that fuses Node-side policy state, a
  browser-realm `*_PAGE_SCRIPT` constant, and a server-side CDP attach adapter is
  three reasons to change — split into `-policy` / `-page-script` / `-attach`.
- **Layer split.** A file where engine-blind domain shapes cohabit with
  CDP-bound adapter classes is two layers — split domain types out and leave a
  barrel so importers are unchanged.
- **Port / implementations split.** A port file that also carries its concrete
  implementations — lift the implementations to a sibling, keep the contract.
- **Comment debt.** A long retired-API comment appendix is not code; relocate it
  to the surface doc it documents (e.g. `docs/threat-model.md`).

Preserve the public surface: re-export from the original path (a barrel) so the
split is invisible to callers and the dependency-cruiser graph is unchanged.
Keep capability checks routed through the shared gate and engine identity as data
— a split must not introduce an inlined check or an engine literal.

## The honest counter-rule

Smaller is not always better. The doctrine also says three similar lines beat a
premature abstraction, and shredding one cohesive idea across a dozen tiny files
is its own readability tax. The cap fights god-files; it does not mandate maximal
fragmentation. Several browxai modules sit honestly in the 300–340 band as one
coherent thing (the selector ranker, the predicate vocabulary, a perf analyser);
leaving them whole is correct. The target is _one reason to change_, with the
line cap as the backstop that catches the failure — not the goal itself.

## Related

- [`architecture-principles.md`](architecture-principles.md) §7 — readability and
  the one-reason-to-change rule the cap proxies.
- [`fitness-functions.md`](fitness-functions.md) — the `max-lines` budget in the
  enforced-checks index and the frozen-doctrine meta-rule.
- [`hexagonal-and-ddd.md`](hexagonal-and-ddd.md) — the layer boundaries a clean
  split respects.
