## Summary

What this changes and **why** (the why matters more than the what).

## Type

- [ ] Bug fix
- [ ] New / changed tool surface
- [ ] Docs
- [ ] Internal (refactor / tests / tooling)

## Surface impact

- [ ] No change to the **stable** surface, **or** —
- [ ] Stable-surface change — `CHANGELOG.md` updated, semver bump noted, deprecation handled
- [ ] New surface lands behind an off-by-default capability

## Checklist

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` green
- [ ] `pnpm test:keystone` run (if page interaction / sessions / capabilities touched)
- [ ] `docs/tool-reference.md` updated for any surface change
- [ ] Conventional, single-line commit subject(s) ≤72 chars
