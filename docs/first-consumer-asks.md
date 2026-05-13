# First-consumer asks (site-docs → browxai)

> Tracks the six concrete asks site-docs (browxai's first real consumer) has filed against
> Phase 1. The **canonical** description (gap, why, minimum shape, how site-docs adopts) lives in
> the site-docs repo at `docs/browxai-asks.md` — read it there for the long form. This file
> is the **browxai-side status board** and the mapping into our spec/roadmap/design.
>
> Hand-off was logged 2026-05-13 in the portfolio progress for `agent-browser-bridge`.

Status legend (browxai side): **design** = absorbed into `docs/phase-1-design.md` / spec / roadmap · **impl-pending** = also implemented (or the cheap part is) · **impl-done** = fully shipped · **deferred** = not Phase 1.

| # | Severity | Ask (short) | Status | Lives in browxai design at |
|---|---|---|---|---|
| 1 | 🔴 | CDP-attach via `BROWX_ATTACH_CDP` on the canonical (canonical) server; treat attached Chrome as not-owned. | design | `phase-1-design.md` §5 + §5a |
| 2 | 🔴 | Stable canonical entrypoint: `pnpm browxai` / `browxai` bin (curated surface default; no env-flag tooling required). | impl-done (Phase 1) | `phase-1-design.md` §0 + `package.json` `bin` |
| 3 | 🔴 | `storageState` handoff to site-docs's headless `run`. Phase-1: falls out of #1 (consumer reads it off the attached Chrome). Phase-2: optional `dump_storage_state` MCP tool. | design (Phase-1 part) · deferred (Phase-2 tool) | `phase-1-design.md` §5a + roadmap Phase 2 |
| 4 | 🟡 | `find().selectorHint` preference order: `data-testid` > role+name > stable text > stable structural > positional (last resort). Surface `stability: "low"` when only tier-4-or-worse. | design | `phase-1-design.md` §3 (find) |
| 5 | 🟡 | Visible-rect bbox in `find()` / `snapshot()` evidence: intersect with `overflow !== visible` ancestors + viewport; `bbox: null` + `clipped: true` when fully clipped. Matches site-docs's runtime computation. | design | `phase-1-design.md` §2/§3 (bbox semantics) |
| 6 | 🟢 | Allow nesting `BROWX_WORKSPACE` under a consumer's workspace (e.g. `$SITE_DOCS_WORKSPACE/.browxai/`). | design (already supported — env-var-rooted) | `phase-1-design.md` §4a (no-trace contract) |

## Sequencing

Sequenced 1 → 6, per the site-docs asks doc. #1 + #2 are the unblockers; #3 follows from #1
for free in its Phase-1 shape; #4 lands as part of the Phase-1 `find()` implementation;
#5 lands with the bbox-emitting parts of `find()` / `snapshot()`; #6 is doc-only.

The canonical entrypoint name **stays** (`browxai`) regardless of the Phase-0 verdict
direction (GO / NO-GO / MIXED). Only the tools behind it move.

## Out of scope (per site-docs)

- Anything Phase-2-shaped on browxai's roadmap (full security/sandbox, learned `find()`
  ranking, headless lifecycle, multi-tenant).
- Replacing site-docs's **execution** mode with browxai — execution stays deterministic
  Playwright, no agent, no MCP, no inference. browxai is **discovery / calibration only**
  on the site-docs side.
- Blocking the Phase-0 verdict on these. They're additive.
