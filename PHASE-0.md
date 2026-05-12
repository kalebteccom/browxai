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

- [ ] **Curated-surface spike.** Throwaway MCP server exposing raw Playwright ops + a
  hand-rolled `find()`/`snapshot()`. Run an agent through 1–2 representative site-docs
  calibration tasks on a real site; measure retries / wrong-element actions with vs.
  without the curated surface. → a written go/no-go with the numbers.
- [ ] **`agent-browser` + `@playwright/mcp` read.** Read Vercel `agent-browser`'s `diff`
  implementation (closest prior art for the `tree_diff` mode; also a competitive datapoint —
  Rust CLI, not MCP) and `@playwright/mcp`'s snapshot/selector approach. → divergence notes
  (where browxai deliberately diverges on token efficiency + lifecycle).
- [ ] **Ratify the research recommendations** into Phase-1 design decisions: the `ActionResult`
  shape (scoped-a11y-re-snapshot default, `mode` options, token budget, `snapshotDelta.tree`
  reusing `snapshot()`'s serialisation + ref scheme); the `window.__browx` helper API + the
  `page.exposeBinding` transport (re-injected per navigation, DOM-attribute polling fallback);
  the Phase-1 security non-negotiables (BYOB off-by-default + warned, managed dedicated profile
  default, loopback CDP, untrusted page content). → a Phase-1 design note (or recorded amendments).
- [ ] **site-docs lifecycle port-plan.** Inventory site-docs's `PlaywrightInstrumentedBrowser` /
  `manual-capture` prototype (`--cdp` attach, `profileDir` persistent profile,
  `window.__siteDocs.capture()` helper): what ports cleanly, what's missing, what the
  generalised `__browx` channel needs beyond it. → a port-plan, judged feasible.
- [x] **Repo skeleton** — private repo, MIT licence, README, `package.json` (TS/Node, MCP SDK,
  playwright-core), `tsconfig.json`, CI (typecheck + test on Node 20 / pnpm), commit-guard hooks.

## Exit criteria

- [ ] Written go/no-go on "curated surface measurably beats raw ops" with concrete numbers.
- [ ] `ActionResult` shape ratified and written into the Phase-1 design.
- [ ] `window.__browx` helper API + transport ratified.
- [ ] Phase-1 security non-negotiables confirmed.
- [ ] Port-plan for the site-docs lifecycle code exists and is judged feasible.
- [ ] `@playwright/mcp` + `agent-browser` divergence notes written.
- [x] Private repo skeleton stood up.

## Build status (live)

- Repo created (`kalebteccom/browxai`, private), MIT-licensed, CI + commit-guard hooks in place,
  TS/Node skeleton (`src/index.ts`, `src/cli.ts` placeholders). Nothing functional yet.
- Everything else above: not started.
