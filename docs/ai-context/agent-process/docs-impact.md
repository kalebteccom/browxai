# Docs-impact pass

Every behavior-change diff verifies the corresponding documentation is updated **in the same change**.

## Checklist

For a diff that touches the public surface, confirm before pushing:

- [ ] **`docs/tool-reference.md`** — tool row updated (input/output shape, capability, defaults).
- [ ] **`docs/threat-model.md`** — capability row updated; for new off-by-default capabilities, a new row.
- [ ] **`docs/plugin-authoring.md`** — only if the plugin manifest contract changed.
- [ ] **`docs/plugins.md`** — only if first-party plugin behaviour changed.
- [ ] **Capability table in `AGENTS.md`** — only if the capability lattice changed.
- [ ] **`CHANGELOG.md`** — entry under `## Unreleased ### Added` / `Changed` / `Fixed` / `Deprecated`.
- [ ] **`docs/ai-context/architecture/capability-posture-map.md`** — only if posture changed.

For a diff that touches discipline (commit rules, daemon-restart, etc.):

- [ ] **`AGENTS.md`** — if the rule needs to apply across harnesses.
- [ ] **`docs/ai-context/agent-process/<topic>.md`** — the discipline note.

## When no docs update is required

State why in the PR description: e.g. "internal refactor, no surface change, no discipline change." Don't silently skip the pass.

## Why this matters

Stale public docs poison adopter integration. Stale agent-process docs poison the next agent's session. The docs-impact-auditor agent (see `.agents/skills/docs-impact-auditor.md`) runs at PR time as a backup.

## Related

- [`code-quality.md`](code-quality.md)
- [`../architecture/documentation-contracts.md`](../architecture/documentation-contracts.md)
