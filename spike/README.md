# Phase-0 spike — throwaway MCP server

Purpose: produce the **go/no-go number** for "does a curated `find()` + `ActionResult` surface make an agent measurably more reliable than raw navigate/click/snapshot?" — the last Phase-0 exit criterion (`PHASE-0.md`). Throwaway code; deletion-on-sight after the number is written down.

Two surfaces in one server, picked by env at startup:

| `BROWX_SPIKE_SURFACE=raw` | `BROWX_SPIKE_SURFACE=curated` |
|---|---|
| `navigate`, `click(selector)`, `fill(selector, value)`, `snapshot` (full a11y JSON dump), `screenshot`, `console_read`, `network_read` | adds `find(query)`; `snapshot` is compact text w/ `[ref=eN]`; `click`/`fill` accept `ref` *or* `selector`; actions return an `ActionResult`-lite (navigation + console_errors_since); refs persist across snapshots |

Every tool call is appended to `$BROWX_WORKSPACE/spike-runs/<task>.<surface>.<ts>.jsonl` (default `~/.browxai/spike-runs/`). Nothing is written to the cwd — see the no-trace contract in `AGENT-RUNBOOK.md`. Post-hoc analysis derives "tool-calls per task" / "failed actions" / "find→click loops" from these.

## Run

```bash
pnpm install
pnpm spike:install-browser            # downloads Chromium

# one run per (surface, task) — BROWX_WORKSPACE must point outside any consumer repo:
BROWX_WORKSPACE=~/.browxai BROWX_SPIKE_SURFACE=raw     BROWX_SPIKE_TASK=task01 pnpm -s spike
BROWX_WORKSPACE=~/.browxai BROWX_SPIKE_SURFACE=curated BROWX_SPIKE_TASK=task01 pnpm -s spike
# (and repeat for task02)
```

The server speaks MCP over stdio. Configure your MCP client (Claude Code, etc.) to spawn it — see `AGENT-RUNBOOK.md` at the repo root for the recipe, **including how to register the server so nothing lands in a consumer repo (target-app etc.)**.

Headless mode: `BROWX_SPIKE_HEADLESS=1`. Workspace: `BROWX_WORKSPACE` (default `~/.browxai/` — never `cwd`). Profile dir override: `BROWX_SPIKE_PROFILE_DIR=…` (still absolute, default `$BROWX_WORKSPACE/spike-profile`).

## What it deliberately doesn't do

- **Not** the real browxai design (which is in `docs/phase-1-design.md`). The curated surface here is a hand-rolled simplification — a useful approximation of `find()` + `ActionResult`, enough to test the premise; the production version uses a different ranking and the full `ActionResult` shape from the design note.
- No BYOB / CDP-attach (the spike is managed-launch only — same as the design's Phase-1 default; the BYOB lifecycle is Phase 1 proper, not this spike).
- No `awaitHuman` / `__browx` helper channel. Login is out of scope; tasks use public sites.
- No token-budgeting / truncation. Both surfaces just emit what they emit; the raw surface is *meant* to be verbose so the bloat shows up.

## Analyse

After both surfaces have run on both tasks (≥ 4 JSONL files in `$BROWX_WORKSPACE/spike-runs/`):

```bash
BROWX_WORKSPACE=~/.browxai pnpm tsx spike/analyze.ts
```

Prints a per-task, per-surface summary table; writes `summary.md` + `summary.json` into the same workspace dir. The headline number for Phase 0's go/no-go is "tool-calls + failed-actions to completion, curated vs. raw, per task".
