# Codex agent definitions — browxai

Codex expert agents for this repo, in Codex's native TOML schema. Each file is the Codex-format mirror of the canonical Claude-skill version in `.agents/skills/<name>.md` — the role content is the same; only the wrapper format differs. Don't edit these in isolation: change `.agents/skills/<name>.md` first, then re-mirror.

The repo-root `AGENTS.md` is the single source of truth for cross-harness rules. These agents add role-specific framing on top of that base.

## Agents

- `tool-author.toml` — Tool / MCP / Surface — adding a new MCP tool end-to-end.
- `plugin-author.toml` — Plugin / Adapter / Workspace — scaffolding a workspace plugin per the v0.7 contract.
- `keystone-writer.toml` — Keystone / Regression / Chromium — regression-gate keystone tests for page-side function changes.
- `capability-gate-auditor.toml` — Gate / Capability / Posture — verifying off-by-default capability discipline.
- `security-reviewer.toml` — Security / Egress / Secrets — security checklist on egress/secrets/workspace/capability diffs.
- `docs-impact-auditor.toml` — Docs / Audit / Changelog — docs-impact verification on behavior-change diffs.
- `release-engineer.toml` — Release / Ship / Tag — the release ritual.
- `tracker-id-auditor.toml` — Tracker / Lint / Comments — scanning diffs for tracker IDs.
- `architecture-fitness-auditor.toml` — Fitness / Arch / Laws — running the fitness suite + dependency graph + budgets against boundary diffs.

## See also

- `.agents/skills/<name>.md` — canonical Claude-skill version (source of truth).
- `.claude/agents/<name>.md` — Claude harness mirror (same `.md` shape).
- `AGENTS.md` — cross-harness rule base.
