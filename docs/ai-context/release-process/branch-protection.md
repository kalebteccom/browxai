# Branch protection

Branch protection rules on `main` are configured by Phase 14a (tooling + CI track) and documented in `RELEASING.md`. This page is the agent-facing pointer.

## What is enforced

- Required status checks: the full quality gate (`pnpm typecheck && pnpm test && pnpm test:keystone && pnpm lint && pnpm format:check && pnpm build`).
- Required review: at least one maintainer approval before merge.
- No direct push to `main`; all changes go through a PR.
- Force-push protection.

## What this means for agents working on a branch

- Open a PR against `main`; CI runs the quality gate automatically.
- Do not attempt to push directly to `main`.
- Do not request a maintainer to disable protection for a one-off — instead, fix the underlying gate failure.

## Related

- [`../agent-process/code-quality.md`](../agent-process/code-quality.md) — the full quality gate.
- [`../agent-process/dist-rebuild-discipline.md`](../agent-process/dist-rebuild-discipline.md) — pre-push verification.
- [`../../../RELEASING.md`](../../../RELEASING.md) — release ritual.
