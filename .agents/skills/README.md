# Shared agent skills — browxai

Cross-harness shared definitions. `AGENTS.md` (repo root) is the operating rules; this directory holds reusable per-domain skill / agent definitions that every harness adapter draws from.

Today's scope: the eight expert agents listed below. Browxai does not yet have a corpus of additional shared skills — this is the substrate for future ones.

## Convention

- One file per role: `<role-name>.md` (kebab-case).
- YAML frontmatter declares `name`, `description`, `model`, `tools`.
- Body: role definition, scope, success criteria, what NOT to do.
- The Claude and Codex agent registries (`.claude/agents/`, `.codex/agents/`) mirror these files. Treat this directory as the source of truth; the mirrors are convenience copies for harness auto-discovery.

## Agents

- `tool-author.md`
- `plugin-author.md`
- `keystone-writer.md`
- `capability-gate-auditor.md`
- `security-reviewer.md`
- `docs-impact-auditor.md`
- `release-engineer.md`
- `tracker-id-auditor.md`
