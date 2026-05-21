# CLAUDE.md

browxai — an MCP-native, model-agnostic browser-control server on Playwright/CDP.
The agent-facing design lives in `docs/`: `docs/tool-reference.md` is the surface
contract, `docs/threat-model.md` the security model. This file holds the
non-obvious working rules.

## API evolution — never hard-break a config input

browxai's config-surface inputs are a **public contract**: `BROWX_CAPABILITIES`
values, `BROWX_CONFIRM_REQUIRED` hooks, config-store keys, tool names, enum
values. Adopters' configs name them. Evolving that surface must never crash an
existing adopter on their next restart.

**Adding** an input is free — additive, no ceremony.

**Removing or renaming** one is a *deprecation cycle*, never a deletion:

- Do NOT just delete the value so the parser throws "unknown" on it — that
  crashes every adopter whose config still names it.
- Move it to a `RETIRED_*` registry. `RETIRED_CAPABILITIES` in
  `src/util/capabilities.ts` is the reference implementation: the parser
  **accepts** the retired value, ignores it, and emits a non-fatal deprecation
  warning that says what to do instead.
- Genuine typos — a value that was *never* valid — must still error loudly. The
  distinction is "formerly valid" (tolerate + warn) vs. "never valid" (reject).
- A retired value may be fully removed only at a **major** version bump, with a
  CHANGELOG entry.

This is why retiring the `unstable` capability did not break a config that still
lists it. Apply the same pattern to any future retirement, on any config-input
parser. Prefer designing inputs so this rarely bites: favour additive evolution,
and keep the set of breaking primitives small.

## Stable surface & semver

`docs/tool-reference.md` "Stability & semver" defines the frozen surface and the
pre-1.0 contract. A change to the stable surface resets the Phase-3
"API stable ~1 week" clock — do not grow or break it casually. Capability-gated
or behaviour-only changes do not reset the clock.

## Commits

`.claude/hooks/` enforces commit hygiene: single-line conventional-commit
subjects, **≤72 chars**, no body, no AI-attribution trailers. Stage files
explicitly (`git add <paths>`), never `git add .`.

## Before committing code

`pnpm typecheck && pnpm test` must pass. For changes to the core dispatch or
session paths, also run `pnpm test:keystone` (the headless integration test).
