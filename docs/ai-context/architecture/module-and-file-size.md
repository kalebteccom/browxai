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

| Scope                                  | Cap (code lines)           | Notes                                                                                                  |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/server.ts` (composition root)     | **280**                    | wiring-only; any business-logic creep trips it (~217 lines today)                                      |
| every production `src/**/*.ts`         | **450**                    | the whole-tree per-file ceiling                                                                        |
| `register*Tools` registration wrappers | **exempt**                 | a flat registration list has one reason to change already                                              |
| `*_FN` page-side function literals     | **exempt** from complexity | a `page.evaluate` function cannot be reduced by extraction without breaking the serialization contract |
| `*.test.ts`                            | higher / out of scope      | colocated tests carry table-driven bulk legitimately                                                   |

The companion per-function budgets in the same block —
`max-lines-per-function-registration-aware` (70),
`complexity-registration-aware` (15), `max-params` (5) — enforce the same
one-job rule at the function grain. A function that needs blank-line section
dividers is two functions.

## Coverage is half the rule

A budget only bites the files it is globbed onto, and that coverage gap was the
real defect here. The `max-lines: 450` block historically covered only
`src/tools/*-tools.ts` + `src/page/**` (+ `server.ts`); `src/util`,
`src/session`, `src/sdk`, `src/plugin`, `src/cli`, `src/transport`, and the
non-`*-tools.ts` composition files under `src/tools` were **uncovered** — which
is exactly how the largest modules (credentials 548, fs-picker 516, tool-types
544, diagnostics 492, host-build 463, permission 452) grew unseen. The block now
globs every production file under `src/` at 450, so the gate sees the whole tree
and no oversized file can land anywhere. Widening the glob, not lowering the
number, was the load-bearing move.

## Why 450, and the ratchet that already ran

450 is not arbitrary: it is sized to the largest **legitimately cohesive** files
in the tree — the flat `register*Tools` registration modules (e.g.
`canvas-tools.ts` ~444), which have one reason to change already and must not be
shredded. Several non-registration modules also sit honestly in the 330-450 band
as one coherent thing (the selector ranker `find.ts`, the perf-audit analysers,
the `ActionResult` orchestration, the vendor-credential adapters). Probing the
post-refactor tree at 320 fails ~18 such files — that would be over-splitting,
the defect the counter-rule below forbids. So the honest floor for the
whole-tree ceiling is 450.

The composition root is the exception that _did_ ratchet: `server.ts` dropped
from 400 to **280** once the target-resolution helpers and the per-capability
warning copy moved out (it is ~217 code lines now). The rule for any future
tightening is unchanged: a budget tightened as a module genuinely shrinks is the
legitimate edit; relaxing one to land a feature is the one thing forbidden
([`fitness-functions.md`](fitness-functions.md), the meta-rule). There is no
cap-debt allowlist — every file is honestly under its ceiling.

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
