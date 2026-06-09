# Codex agent definitions — browxai

Mirrored copies of the expert agent definitions also present in `.claude/agents/` and `.agents/skills/`. The canonical role logic is `.agents/skills/<name>.md`; this directory holds the Codex-flavoured copy so Codex picks them up via its own discovery path.

The Codex agent-file format is still under iteration. Until the format stabilizes upstream, files here mirror the Claude shape (markdown body with YAML frontmatter declaring `name`, `description`, `model`, `tools`). When Codex publishes a stricter schema (TOML or otherwise), convert these files in a follow-up cycle — the role content stays; only the wrapper format changes.

## Agents

- `tool-author.md` — adding a new MCP tool end-to-end.
- `plugin-author.md` — scaffolding a workspace plugin per the v0.7 contract.
- `keystone-writer.md` — regression-gate keystone tests for page-side function changes.
- `capability-gate-auditor.md` — verifying off-by-default capability discipline.
- `security-reviewer.md` — security checklist on egress/secrets/workspace/capability diffs.
- `docs-impact-auditor.md` — docs-impact verification on behavior-change diffs.
- `release-engineer.md` — the release ritual.
- `tracker-id-auditor.md` — scanning diffs for tracker IDs.
