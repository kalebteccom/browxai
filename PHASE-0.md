# Phase 0 — Discovery & validation — **closed 2026-05-13**

> Canonical roadmap: `kalebteccom/project-ideas` → `projects/agent-browser-bridge/roadmap.md`.
> Phase 1 lives in `AGENT-RUNBOOK.md` at the root of this repo.

**Goal (as delivered).** Nail down the design details of owning the Playwright/CDP transport
ourselves; produce divergence notes vs. prior art; produce a site-docs lifecycle port-plan;
stand up the repo skeleton. (Originally also intended a curated-vs-raw spike A/B — see
"Re-sequencing" below.)

## Re-sequencing 2026-05-13

The Phase-0 plan originally included a synthetic curated-vs-raw spike A/B on public sites
to produce a "premise" go/no-go. site-docs (the first consumer) filed its six asks on the
same day, formally committing to adopt browxai as its calibration driver, and the real
evaluation moved into **Phase 1** as the site-docs adoption run on a real authed target. The
synthetic A/B was going to be a weaker signal than the real adoption by a committed consumer
— so the spike-verdict exit criterion was dropped and Phase 0 closed without it.

The **spike harness** in `spike/` stays as **optional reference** — it's a working
two-surface MCP server an agent can drive for a sanity-check if useful. See
`spike/AGENT-RUNBOOK.md`. It's not a gate for anything.

## Deliverables (all in this repo)

- [x] **`docs/divergence-notes.md`** — what browxai borrows from `@playwright/mcp` and Vercel
  `agent-browser`, six point-by-point divergences, the ref-scheme-compat rule, a Phase-1
  watch list. Citations included.
- [x] **`docs/phase-1-design.md`** — the implementer-facing Phase-1 design. Module layout,
  the one-serialisation/one-ref-scheme coherence constraint, the full `ActionResult` shape
  + build steps, `window.__browx` + `awaitHuman` over `page.exposeBinding` w/ polling
  fallback, session lifecycle + Phase-1 security non-negotiables + the no-trace
  consumer-repo contract, MCP server wiring. Draft — pushable-back-on if Phase 1 forces a
  change.
- [x] **`docs/site-docs-lifecycle-port-plan.md`** — ~600–700 LOC inventoried; what ports,
  what needs generalisation (including *inverting* the security flags default), what's out
  of scope (`runFlow` etc. become consumers, not part of browxai), a concrete ~150–250-LOC
  first-PR slice, open risks.
- [x] **`docs/first-consumer-asks.md`** — status board for the six site-docs asks (#1–#6),
  each mapped to a section of `docs/phase-1-design.md`. Canonical asks doc:
  `automated-site-documentation-bot/docs/browxai-asks.md`.
- [x] **Repo skeleton** — private, MIT, `package.json` (TS/Node ESM, `@modelcontextprotocol/sdk`
  1.29 + `playwright-core` 1.60 + `zod`), `tsconfig.json`, GitHub Actions CI (typecheck +
  test on Node 20 / pnpm), `.claude/hooks/block-{ai-attribution,long-commits}.sh` commit
  guards, `.gitignore`.
- [x] **Spike harness** (optional reference) — `spike/server.ts` + `spike/browser.ts` +
  `spike/log.ts` + `spike/analyze.ts`, two task scripts in `spike/tasks/`,
  `spike/AGENT-RUNBOOK.md`. Typecheck clean.

## Exit criteria

- [x] `ActionResult` shape ratified. — `docs/phase-1-design.md`
- [x] `window.__browx` helper API + transport ratified. — `docs/phase-1-design.md` §4
- [x] Phase-1 security non-negotiables confirmed. — `docs/phase-1-design.md` §5
- [x] Port-plan for the site-docs lifecycle code exists and is judged feasible. —
      `docs/site-docs-lifecycle-port-plan.md`
- [x] `@playwright/mcp` + `agent-browser` divergence notes written. — `docs/divergence-notes.md`
- [x] First-consumer asks #1–#6 adopted into the design. — `docs/first-consumer-asks.md`
- [x] Private repo skeleton stood up.
- ~~[ ]~~ ~~Written go/no-go on "curated surface measurably beats raw ops" with concrete
  numbers from the spike.~~ **Dropped 2026-05-13** — replaced by the Phase-1 site-docs
  adoption run as the real evaluation. See the portfolio roadmap's decisions log.

## What's next

**Phase 1 starts.** Implement the first-consumer asks on the canonical `browxai` server and
drive site-docs's discovery/calibration end-to-end through it. Hand-off doc:
`AGENT-RUNBOOK.md` at the root of this repo.
