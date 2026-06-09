# Adopter reports

Field reports from agents and teams driving browxai against real workloads. Time-ordered. Each report drove (or is driving) surface changes through the adopter-feedback loop described in `AGENTS.md`.

## Loop

1. Report lands as `<YYYY-MM-DD>-<slug>.md`.
2. Triage: each ask gets a verdict (in v0.x surface / behind capability / RFC / declined).
3. Capability lane: posture-broadening asks go off-by-default with a capability gate.
4. Keystone coverage: regression test against real Chromium.
5. CHANGELOG entry + `docs/tool-reference.md` row.
6. The originating report's "durable lessons captured" section points at the resulting CHANGELOG entry or roadmap phase.

## Reports

- [`2026-05-19-fanfest-qa.md`](2026-05-19-fanfest-qa.md) — multi-day agentic QA campaign against FanFest contest/simulfest. Surfaced backgrounded-tab control, `approve_actions` discoverability, and several missing primitives. FanFest team and individual contributor names retained per explicit owner sign-off (2026-06-09).
- [`2026-05-20-codex.md`](2026-05-20-codex.md) — Codex run against Clipro authenticated SPA: persistent profile, drag-reorder, eval_js/poll_eval state inspection, CSV upload via hidden file input.
- [`2026-05-20-codex-fileio.md`](2026-05-20-codex-fileio.md) — second Codex run after enabling capability-gated tools (`upload_file`, `drag preflight`, `poll_eval`).
