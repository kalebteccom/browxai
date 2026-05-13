# First-consumer asks (site-docs → browxai)

> Tracks the concrete asks site-docs (browxai's first real consumer) has filed. The **canonical
> integration contract** across both rounds lives in the site-docs repo at `docs/browxai-asks.md`
> (rewritten 2026-05-13 as a two-round contract after the target-app adoption run). This file is the
> **browxai-side status board** and the mapping into our spec/roadmap/design.
>
> Hand-off was logged 2026-05-13 in the portfolio progress for `agent-browser-bridge`.

Status legend: **design** = absorbed into `docs/phase-1-design.md` / spec / roadmap · **impl-pending** = also implemented (or the cheap part is) · **impl-done** = fully shipped · **deferred** = not in current phase.

## Phase-1 asks (pre-shipping, from `automated-site-documentation-bot/docs/browxai-asks.md`)

| # | Severity | Ask (short) | Status | Lives in browxai design at |
|---|---|---|---|---|
| 1 | 🔴 | CDP-attach via `BROWX_ATTACH_CDP` on the canonical server; treat attached Chrome as not-owned. | impl-done (Phase 1) — adoption-run flagged it's **not the default**; see ask #9 | `phase-1-design.md` §5 + §5a |
| 2 | 🔴 | Stable canonical entrypoint: `pnpm browxai` / `browxai` bin (curated surface default; no env-flag tooling required). | impl-done (Phase 1) | `phase-1-design.md` §0 + `package.json` `bin` |
| 3 | 🔴 | `storageState` handoff to site-docs's headless `run`. Phase-1: falls out of #1 (consumer reads it off the attached Chrome via `BrowserContext.storageState()` — no MCP tool needed). Phase-2: optional `dump_storage_state` MCP tool for the managed-mode case. | impl-done (Phase-1 shape; no code needed). 📅 adoption-gated for the re-run · deferred (Phase-2 `dump_storage_state`) | `phase-1-design.md` §5a + roadmap Phase 2 |
| 4 | 🟡 | `find().selectorHint` preference order: `data-testid` > role+name > stable text > stable structural > positional (last resort). Surface `stability: "low"` when only tier-4-or-worse. | impl-done (tiers 1,2,5; tiers 3,4 Phase-1.5) — adoption-run flagged a tier-1 weighting issue, see ask #10 | `phase-1-design.md` §2b |
| 5 | 🟡 | Visible-rect bbox in `find()` / `snapshot()` evidence: intersect with `overflow !== visible` ancestors + viewport; `bbox: null` + `clipped: true` when fully clipped. Matches site-docs's runtime computation. | impl-done (Phase 1) | `phase-1-design.md` §2a |
| 6 | 🟢 | Allow nesting `BROWX_WORKSPACE` under a consumer's workspace (e.g. `$SITE_DOCS_WORKSPACE/.browxai/`). | impl-done (env-var-rooted everywhere) | `phase-1-design.md` §4a |

## Phase-1.5 asks (post-shipping, from the 2026-05-13 target-app adoption-run report)

| # | Severity | Ask (short) | Status |
|---|---|---|---|
| 7 | 🔴 | **Snapshot DOM-walk fallback** when the a11y tree is empty / shallow. The target-app adoption found `snapshot()` returning `RootWebArea [ref=e3]` only (`truncated: false`) on a fully-hydrated SPA. With this, `find()` degrades to tier-5 / `low` on any non-semantically-marked-up app — **blocks the canonical discovery use case**. Minimum shape: walk the DOM in addition to the a11y tree, emit interactive elements (`[role]`, `button`, `[data-testid]`, `[onclick]`, `input`, `[tabindex]`, …) as nodes with `[ref=eN]`; refs still come from the existing stable-key scheme. | **impl-done 2026-05-13** — `src/page/dom-walk.ts` + `compose.ts`; runs every snapshot; merged into the tree with `source: dom|both|a11y` markers; refs share the stable-key scheme; `find()` picks up DOM-walk-only candidates. |
| 8 | 🔴 | **Snapshot `data-attribute` projection** — a `snapshot` mode (or supplementary view) that lists every visible element with `data-testid` / `data-test` / `data-cy` / `data-qa` / project-conventional data-attrs set, treated as tier-1 / stability `high` even when no role wrapper exists. Adoption-run showed this would have legitimately beaten source-code grep on target-app (grep can't tell you which testids are *mounted right now*). | **impl-done 2026-05-13** — same plumbing as #7. Configurable via `BROWX_TEST_ATTRIBUTES` (`src/util/config.ts`); default set + project conventions like `data-type` configurable per-adopter. |
| 9 | 🟡 | **Auto-default `BROWX_ATTACH_CDP` when `localhost:9222` is reachable** (or some `browxai doctor` that prints the missing setup). The user-scope MCP install I shipped doesn't set `BROWX_ATTACH_CDP`, so adopters re-login each session even when the runbook's `--cdp` Chrome is already running. Alternative shape: a tiny per-tool-call `--use-existing-chrome-if-running` flag, or persistent profile by default so the second login is at most one-time. | **workaround live 2026-05-13** — dual user-scope MCP registration (`browxai` + `browxai-attached`) shipped (see runbook). Auto-default / `browxai doctor` still wanted; deferred. |
| 10 | 🟡 | **`selectorHint` tier-1 (`data-testid` / well-known data-attrs / project conventions like `data-type`) must not gate on a role wrapper.** The current tier-1 path requires the a11y enrichment pass to attach a testId to a roled node; on heavy SPAs that path is empty. With ask #7 / #8 landing, ensure tier-1 stays first when the node was found via DOM walk too. | **impl-done 2026-05-13** — `buildSelectorHint` now emits `[<testIdAttr>="…"]` with the matched attribute name; tier-1 fires regardless of role (tested against `role=div` and `role=generic`). |
| 11 | 🟢 | **Surface a "low-content snapshot" warning** when the snapshot tree has fewer than N interactive descendants — adopters currently misread `truncated: false` + one-line root as "the page is empty" rather than "the a11y tree is sparse on this codebase, you may want the DOM-walk fallback." | **impl-done 2026-05-13** — `compose.ts` emits a structured warning when a11y has < 5 interactive descendants, naming the count and the DOM-walk supplementation. |

Also flagged but **not a browxai ask** (consumer-of-browxai problem on the site-docs side): the *path to first `find()` call on a real authed app* is gated by long backend ops (target-app's script + audio generation is 6–15 min). A `site-docs warm "$WORKSPACE" --to <flow>` that parks a hydrated CDP Chrome for browxai to attach to would unblock this on the consumer side; tracked in the site-docs runbook, not here.

## Discoverability / phase-1.5 polish

- Make the `await_human` Phase-1.5 plan for `confirm`/`choose`/`input`/`pick_element` visible in the tool description, so adopters don't roll their own out-of-band convention.

## Sequencing

**Phase 1 (delivered 2026-05-13):** asks 1–6 in numbered order. #1+#2 were the
unblockers; #3 fell out of #1 for free in its Phase-1 shape; #4+#5 landed with the
`find()` implementation; #6 is doc-only.

**Phase 1.5 (next, opened 2026-05-13 by the adoption-run report):** ask #7 (DOM-walk
fallback) is the priority — it unblocks the canonical discovery use case on real-world
SPAs and gates `find()` from being usefully exercised. #8 (data-attribute projection)
lands cheaply on top of #7's plumbing. #9 (auto-attach default) is independently small
and high-friction-reducing. #10 carries with the tier-3/4 selectorHint work already
called out for Phase 1.5. #11 is a one-line warning.

## Out of scope (per site-docs)

- Anything Phase-2-shaped on browxai's roadmap (full security/sandbox, learned `find()`
  ranking, headless lifecycle, multi-tenant).
- Replacing site-docs's **execution** mode with browxai — execution stays deterministic
  Playwright, no agent, no MCP, no inference. browxai is **discovery / calibration only**
  on the site-docs side.
