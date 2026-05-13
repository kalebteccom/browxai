# Phase 0 — Discovery & validation

> Canonical roadmap: `kalebteccom/project-ideas` → `projects/agent-browser-bridge/roadmap.md`.
> This file mirrors the Phase-0 slice and tracks live build status. Keep the portfolio in sync.

**Goal.** Confirm the core premise before building the full surface — does a curated
`find()` + `ActionResult` surface make an agent measurably more reliable than raw
navigate/click/snapshot on real calibration tasks? — and pin down the design details of
owning the Playwright/CDP transport ourselves.

Rough effort: ~1–1.5 weeks. (The open-questions research pass is already done — see
`research-open-questions.md` in the portfolio — so Phase 0 is mostly the spike, the
ratification, and this repo skeleton.)

## Scope / checklist

- [ ] **Curated-surface spike.** Throwaway MCP server in `spike/` — **built**, typecheck-clean,
  exposes raw + curated surfaces selectable by `BROWX_SPIKE_SURFACE`, logs every tool call to
  `spike/runs/<task>.<surface>.jsonl`. Two task scripts in `spike/tasks/` (Wikipedia search +
  the-internet.herokuapp.com Dynamic Loading — ambiguity-shaped, no auth). Post-hoc analysis in
  `spike/analyze.ts`. **What's left:** an agent actually drives the four-cell matrix (2 surfaces ×
  2 tasks) and writes the go/no-go verdict to `docs/phase-0-spike-verdict.md`. See
  `AGENT-RUNBOOK.md` at the repo root.
- [x] **`agent-browser` + `@playwright/mcp` read** → `docs/divergence-notes.md` — what browxai
  borrows (a11y-tree-as-snapshot from `@playwright/mcp`; `tree_diff` + stable refs from
  `agent-browser`; re-snapshot-after-action as the floor; `--caps`/origin-flag ideas) and the
  six point-by-point divergences (MCP-native server; scoped `ActionResult` w/ per-call `mode`;
  owns the BYOB/profile/CDP-attach/`httpOnly` lifecycle + `__browx`; token-efficiency as a
  first-class NFR; ranked `find()`; tighter security default), plus the ref-scheme-compatibility
  rule and a Phase-1 watch list. Citations included.
- [x] **Ratify the research recommendations** into Phase-1 design decisions → `docs/phase-1-design.md`
  (draft — a few details, e.g. the exact a11y serialisation grammar, settle once the spike + the
  prior-art reads are fully digested). Covers: module layout (`src/{session,page,helper,util}/…`);
  the one-serialisation/one-ref-scheme coherence constraint (stable refs by element-key, not
  enumeration order); the full `ActionResult` shape + build steps (MutationObserver as
  change-detector only, scoped re-snapshot, the four `mode`s, token budgeting); `window.__browx` +
  `awaitHuman` + the `exposeBinding`-with-polling-fallback transport; the session lifecycle
  (managed dedicated profile default / opt-in BYOB) + the Phase-1 security non-negotiables; MCP
  server wiring.
- [x] **site-docs lifecycle port-plan** → `docs/site-docs-lifecycle-port-plan.md` — ~600–700 LOC
  across `playwright-instrumented-browser.ts` / `playwright-driver.ts` / `auth.ts` in site-docs;
  what ports cleanly (3 launch modes, attach-aware `close()`, `storageState()` localStorage-merge,
  `LocalStorageStateCache`, the raw primitive ops), what needs generalisation (`__siteDocs.capture()`
  → `__browx`; **invert** the security flags — managed dedicated profile + normal flags + sandbox by
  default, lowered-flags/BYOB off-by-default behind an explicit flag + loud warning, CDP loopback
  only), what's out of scope (`runFlow`/flow-runtime/doc-pack/calibrate/viewer — those become
  *consumers* of browxai), a concrete first-PR slice (~150–250 LOC: managed-launch + `goto`/
  `screenshot` + stub `snapshot()` + the stdio MCP server with `navigate`/`snapshot`/`screenshot` +
  a smoke test), and the open risks (Playwright #34359, the CDP `storageState()` workaround,
  site-docs assumptions, `exposeFunction`→`exposeBinding`, profile-dir lock contention, no Chromium
  in CI).
- [x] **Repo skeleton** — private repo, MIT licence, README, `package.json` (TS/Node, MCP SDK,
  playwright-core), `tsconfig.json`, CI (typecheck + test on Node 20 / pnpm), commit-guard hooks.

## Exit criteria

- [ ] Written go/no-go on "curated surface measurably beats raw ops" with concrete numbers.
- [x] `ActionResult` shape ratified and written into the Phase-1 design. *(draft — `docs/phase-1-design.md`)*
- [x] `window.__browx` helper API + transport ratified. *(`docs/phase-1-design.md` §4)*
- [x] Phase-1 security non-negotiables confirmed. *(`docs/phase-1-design.md` §5)*
- [x] Port-plan for the site-docs lifecycle code exists and is judged feasible. *(`docs/site-docs-lifecycle-port-plan.md`)*
- [x] `@playwright/mcp` + `agent-browser` divergence notes written. *(`docs/divergence-notes.md`)*
- [x] Private repo skeleton stood up.

**Phase 0 closes once the curated-surface spike's go/no-go is written.** Everything else is in hand.

## Build status (live)

- Repo created (`kalebteccom/browxai`, private), MIT-licensed, CI + commit-guard hooks in place,
  TS/Node skeleton (`src/index.ts`, `src/cli.ts` placeholders).
- Design docs landed: `docs/phase-1-design.md` (the ratified Phase-1 design, draft), `docs/divergence-notes.md`
  (vs. `@playwright/mcp` and `agent-browser`), `docs/site-docs-lifecycle-port-plan.md` (the port-plan).
- **Spike harness built** (`spike/server.ts` + `spike/browser.ts` + `spike/log.ts` + `spike/analyze.ts`,
  two task scripts, `AGENT-RUNBOOK.md`); typecheck clean; deps installed (`@modelcontextprotocol/sdk` 1.29,
  `playwright-core` 1.60, `zod` 3.25, `tsx`). Chromium not downloaded yet (`pnpm spike:install-browser` is
  the first thing the runbook tells the agent to do).
- **Not done:** an agent has not yet *run* the spike's four-cell matrix; the go/no-go verdict
  (`docs/phase-0-spike-verdict.md`) is the last Phase-0 deliverable.
