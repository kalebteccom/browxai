# Commit discipline

Single-line conventional-commit subjects, ≤72 characters, no body. Enforced by `.claude/hooks/block-long-commits.sh` on visible `git commit -m` / `--message=` invocations.

## Subject format

`type(scope): subject` or `type: subject`. Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

## What goes in the commit, what goes elsewhere

- Subject: what changed, in 72 chars.
- The _why_ goes in the PR description, the CHANGELOG entry, or the relevant `docs/ai-context/` note. The commit body field stays empty.
- No bug-tracker links in the subject.

## Staging

Stage files explicitly: `git add <paths>`. Never `git add .` or `git add -A`: it sweeps in secrets, generated artifacts, and unrelated workspace junk.

## No internal tracker IDs in source or comments

Ticket / plan / round / PR refs (`W-X#`, `Round-N`, `ask #N`, `TICKET-N`, `JIRA-N`, `#1234`, `ROLLBACK-SAFETY-PLAN`, etc.) are project-management artifacts, not code context. They rot, they mean nothing to a future reader, and they belong in the commit/PR body. State the actual reason instead: write _why_ the code is the way it is, not _which ticket asked for it_.

One exception: load-bearing identifier schemes tied to enforcing tests, like an `INV-N` invariant tag whose literal text the test discovers. browxai has none today. The rule shape is written down so future invariant work doesn't blow up the auditor.

A PR-time `tracker-id-auditor` agent (see `.agents/skills/tracker-id-auditor.md`) regex-scans diffs as a backup to the ESLint custom rule.

## Cycle boundaries

A cycle = any logically complete unit of change: initial capture, refinement round, phase transition, open-question close-out. One cycle → one commit, pushed. Don't batch a week of work into one commit. Per-cycle history is the point.

## Related

- [`code-quality.md`](code-quality.md): the full quality gate.
- [`docs-impact.md`](docs-impact.md): what docs to touch on a behavior change.
