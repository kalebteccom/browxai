# Agent runbook — browxai Phase 1

> Hand this doc to an MCP-capable coding agent (Claude Code, Codex, anything that drives the
> filesystem + a shell + git). It explains what Phase 1 ships, the work that gates it, the
> rules that constrain it, and what "done" looks like.
>
> **You are the agent.** This document addresses you in the second person.
>
> Repo: `kalebteccom/browxai` (private; MIT; will go public per the spec's 4-condition
> trigger in Phase 3). Canonical design lives in the portfolio repo `kalebteccom/project-ideas`
> → `projects/agent-browser-bridge/` (`spec.md`, `roadmap.md`, `progress.md`). When this
> repo's docs conflict with the portfolio, the portfolio wins — and you should fix the
> conflict in *both*.

## What Phase 1 ships, in one paragraph

A standalone MCP server (`browxai`, stdio transport) built on `playwright-core` + CDP that
exposes a curated, agentic-first, token-efficient browser-control surface — `snapshot`,
`find`, the `ActionResult` action primitives, `screenshot`, `consoleRead`, `networkRead`,
and `awaitHuman` — and that **site-docs's discovery/calibration drives end-to-end on a real
authed target** in place of Claude-in-Chrome. That adoption run *is* the real evaluation;
there's no separate A/B (the original Phase-0 spike was demoted 2026-05-13 and deleted once
the canonical server reached parity).

## The no-trace consumer-repo contract (read this first)

browxai is designed to be **invoked from inside any other repo without leaving traces in
it**. Concretely:

- The browxai *implementation* lives at its own checkout (referred to below as `<browxai>`).
- All **transient state** — the managed-profile Chromium dir, captured `storageState`,
  logs, screenshots, helper artefacts — lives in a **`BROWX_WORKSPACE` directory outside
  any consumer repo**, default `~/.browxai/`.
- A consumer repo (for site-docs: a per-app workspace alongside the app repo; never the
  app repo itself) is **never** written to by browxai. After a session, `git status` in any
  consumer / target repo is clean. This is also a Phase-1 *exit criterion* in the
  roadmap — verify it.

Two MCP-client configuration patterns satisfy this — pick one. **Never** drop a `.mcp.json`
inside a consumer repo just because that's where your editor is open.

- **(A)** User-scope MCP registration in `~/.claude.json`'s `mcpServers` — available from
  any project session; nothing touches the consumer repo.
- **(B)** A workspace-scope `.mcp.json` *inside the `BROWX_WORKSPACE` dir* (outside any
  consumer repo); open your Claude Code session against that workspace dir, not against the
  consumer repo.

Either way, the **`cwd` of the spawned MCP server is the browxai repo** (so pnpm finds the
deps), but the **`BROWX_WORKSPACE` env points at the workspace dir or `~/.browxai/`**, where
all transient state goes. The consumer repo is never in either path.

## The work, in priority order

Six concrete asks from site-docs (the first consumer) are what Phase 1 delivers. **Full
spec for each:** `automated-site-documentation-bot/docs/browxai-asks.md` (canonical) and
this repo's `docs/first-consumer-asks.md` (browxai-side status board mapping each ask to a
section of `docs/phase-1-design.md`). Sequenced 1→6:

1. 🔴 **CDP-attach via `BROWX_ATTACH_CDP=<loopback-endpoint>`** on the canonical MCP server.
   Treat the attached browser as **not-owned** — on shutdown, detach but *don't* close the
   browser and *don't* reset its storage. Loopback only (refuse non-`127.0.0.1` hosts).
   Startup log: `attached=<endpoint> owner=external`. This is the unblocker — without it,
   site-docs can't drive browxai against an already-authed Chrome.

2. 🔴 **Stable canonical entrypoint** `browxai` — `pnpm browxai` script + `browxai` npm bin
   pointing at `dist/cli.js`. Curated surface as default; no `BROWX_SPIKE_*` env vars on
   this path. The spike entrypoint has already been deleted (the canonical does the same
   job better); restore from git if a side-by-side ever becomes useful.

3. 🔴 **storageState handoff** — falls out of #1 for free: when browxai is attached, a
   consumer reads `storageState()` off the same Chrome with no extra MCP tool needed. Make
   sure attaching doesn't break that — site-docs's `capture-auth --cdp <endpoint>` uses
   `Playwright.BrowserContext.storageState()` on the same target. (A `dump_storage_state`
   MCP tool for the `managed`-mode case is Phase 2 — *don't* build it in Phase 1.)

4. 🟡 **`find().selectorHint` quality bar** — preference order
   `data-testid` > role+name > stable-text-on-stable-role > stable-structural > positional
   (last resort), with a per-candidate `stability ∈ "high"|"medium"|"low"` flag. `data-testid`
   list is configurable (also `data-test`, `data-cy`, …).

5. 🟡 **Visible-rect bbox** in `find()` / `snapshot()` evidence — `getBoundingClientRect()`
   ∩ each `overflow !== visible` ancestor ∩ viewport; `bbox: null` + `clipped: true` when
   fully clipped. Match site-docs's runtime bbox so calibration-time bbox = execution-time
   bbox for the same selector.

6. 🟢 **Workspace co-location** — doc-only ask: `BROWX_WORKSPACE` is already env-var-rooted;
   confirm it accepts a nested path like `$SOME_CONSUMER_WORKSPACE/.browxai/` and document
   the pattern.

The full Phase-1 design (module layout, exact `ActionResult` JSON shape, ref scheme, the
`window.__browx` helper, security non-negotiables, MCP wiring, the no-trace contract) is
in **`docs/phase-1-design.md`**. The site-docs lifecycle code to port (~600–700 LOC across
`playwright-instrumented-browser.ts` / `playwright-driver.ts` / `auth.ts`) is inventoried in
**`docs/site-docs-lifecycle-port-plan.md`**, including a concrete ~150–250-LOC first-PR
slice. Read both before opening `src/`.

## Where to look

- **`docs/phase-1-design.md`** — the implementer-facing design. Module layout (`src/{session,
  page,helper,util}/…`), the one-serialisation/one-ref-scheme coherence constraint, the
  full `ActionResult` shape, the `__browx` helper + `awaitHuman` over `page.exposeBinding`
  with polling fallback, session lifecycle + the Phase-1 security non-negotiables + the
  no-trace contract, MCP server wiring. Draft — push back here if the asks force a change.
- **`docs/site-docs-lifecycle-port-plan.md`** — what lifts from site-docs (3 launch modes,
  `storageState()` localStorage-merge, `LocalStorageStateCache`, primitive ops) and what
  doesn't (`runFlow`, doc-pack, calibrate, viewer). Includes a first-PR slice (~150–250 LOC):
  managed-launch + `goto`/`screenshot` + a stub `snapshot()` + an `@modelcontextprotocol/sdk`
  stdio server with `navigate`/`snapshot`/`screenshot` tools + a vitest smoke test on
  `example.com`.
- **`docs/divergence-notes.md`** — what to borrow from `@playwright/mcp` (a11y-tree-as-
  snapshot, `--caps`/origin-flag *ideas*) and Vercel `agent-browser` (`tree_diff` mode,
  stable refs across snapshots); six point-by-point divergences with the why.
- **`docs/first-consumer-asks.md`** — status board for the six asks.
- **`spec.md` / `roadmap.md` in the portfolio** — source of truth for *what* and *why*.
- **`automated-site-documentation-bot/docs/browxai-asks.md`** — the canonical ask sheet from
  site-docs (the long form of the six items above).
- **`automated-site-documentation-bot/docs/agent-runbook.md`** — site-docs's own runbook;
  its Step 4 pre-stages the swap "drive `--cdp` Chrome with Playwright directly" →
  "spawn browxai (attached to that same Chrome) and drive it via MCP." Worth reading so you
  know what shape the consumer is calling you in.

## Ground rules

- **Stay on TS/Node, ESM, Node ≥20.** `playwright-core` for browser, `@modelcontextprotocol/sdk`
  for MCP. Already in `package.json`.
- **Idiomatic, clean code.** Thin `src/index.ts`, focused modules under `src/{session,page,
  helper,util}/`. Match the surrounding style as the codebase grows; tests alongside
  (`*.test.ts`, vitest). Typecheck + tests on Node 20 / pnpm in CI (already wired).
- **stderr is the only logging channel.** stdout is the MCP wire — anything written there
  corrupts the protocol. Imports of `console.log` in `src/` are bugs.
- **Page content is untrusted.** `snapshot` / `find` / `ActionResult.snapshotDelta` output
  is attacker-controlled. The server does not interpret it; no promptable ranking
  heuristics; the tool descriptions tell the host agent the same. Phase 2 hardens this
  further (capability toggles, allowlist, confirmation hooks); Phase 1 only needs the
  posture and the docs.
- **Two session modes only in Phase 1.** `managed` (default; dedicated profile at
  `$BROWX_WORKSPACE/profile/`; normal Chrome flags; sandbox on) and `byob`
  (`BROWX_ATTACH_CDP=…`; off by default; loud one-time warning; not-owned). The
  ephemeral / per-session managed-profile dir is fine too.
- **No-trace contract verification.** Add a CI test (or at minimum a manual checklist step)
  that spawns the server with `cwd=/tmp/fake-consumer-repo` (an empty git repo) and asserts
  `git -C /tmp/fake-consumer-repo status --porcelain` is empty after exercising the tools.
- **Commits.** Single-line conventional-commit subjects, ≤72 chars, no body, no AI trailer
  (the `.claude/hooks/` guards enforce this — they'll reject you if you try). One logical
  change per commit; push when a commit is logically complete. Don't `git add .` — stage
  explicitly.
- **When the design fights you, fix the design.** If implementing an ask forces a change
  to `docs/phase-1-design.md` or to the portfolio `spec.md` / `roadmap.md`, update *all* of
  them — they have to agree. Mirror the change into the portfolio's `progress.md` per the
  repo's cycle rule.
- **If you get blocked, surface it.** Don't grind for 50 tool-calls on a Playwright timeout
  or a CDP attach failure. Write a `docs/blockers/<topic>.md`, push the branch, summarise
  in the chat so the human can unblock.

## Definition of done — Phase 1

Phase 1 closes when every box in the roadmap's Phase-1 exit criteria is ticked
(`projects/agent-browser-bridge/roadmap.md` § Phase 1 — read it). The headline ones:

- [ ] site-docs's discovery/calibration runs end-to-end through browxai on ≥1 real target
      site, no Claude-in-Chrome in the loop, with a real `httpOnly` session.
- [ ] `BROWX_ATTACH_CDP` end-to-end on the canonical entrypoint: site-docs drives an
      already-authed external Chrome through browxai *without a second login*.
- [x] Canonical `browxai` entrypoint is the documented invocation; spike entrypoint deleted.
- [ ] `find().selectorHint` preference order + `stability` flag implemented; visible-rect
      bbox in `find()` / `snapshot()` evidence; locators transcribe mechanically into
      site-docs flow-files with no manual re-selecting.
- [ ] `snapshot()`, `find()`, `ActionResult`, `screenshot`, `console`/`network` reads,
      `awaitHuman` all implemented and exercised by the calibration run.
- [ ] No-trace contract holds against any consumer repo (`git status` clean).
- [ ] Tool reference docs exist (the curated surface + output shapes).

When all are green, sync back to the portfolio (`progress.md` + roadmap status + portfolio
table), open the `/gpd:advance-stage` conversation, and we move into Phase 2 (the security
hardening / non-site-docs-consumer phase).

## When the human asks "is Phase 1 starting?"

It is once:
- [ ] `pnpm install` succeeds in the browxai repo.
- [ ] `pnpm typecheck` passes.
- [ ] You've read `docs/phase-1-design.md`, `docs/site-docs-lifecycle-port-plan.md`,
      `docs/first-consumer-asks.md`, and the portfolio `spec.md` + `roadmap.md`.
- [ ] You have a `BROWX_WORKSPACE` dir picked outside any consumer repo (or the default
      `~/.browxai/`).
- [ ] You've opened the first-PR-slice scope from the port-plan and have a sense of where
      `src/session/managed.ts` + `src/server.ts` come from.

Open a branch (`feat/<short>`), pick ask #1 or the first-PR slice as the first cycle, and
go. One cycle = one commit; commit + push when logically complete; sync the portfolio
`progress.md` at each cycle boundary.
