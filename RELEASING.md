# Releasing browxai

browxai follows [semver](https://semver.org/). What counts as a breaking vs.
additive change to the **stable surface** is defined in the
[Stability & semver](docs/tool-reference.md) policy — read it before choosing
a version bump.

- **patch** — bug fixes; no stable-surface change.
- **minor** — additive stable-surface change, or any change confined to the
  off-by-default capability lanes (`unstable`, etc.).
- **major** — a breaking change to the stable surface (also needs a changelog
  entry + a deprecation note; no silent breaks).

## Steps

1. Ensure `main` is green: `pnpm typecheck && pnpm test && pnpm build`, and
   `pnpm test:keystone` (real-browser end-to-end).
2. Update `CHANGELOG.md` — move items under a new `## [X.Y.Z]` heading with the date.
3. Bump `version` in `package.json` (and the `VERSION` constant in `src/server.ts`
   — they must agree).
4. Commit (`chore: release vX.Y.Z`) and tag: `git tag vX.Y.Z && git push --tags`.
5. `npm publish` — `prepublishOnly` re-runs typecheck + test + build first.
   Publishing requires npm auth (and 2FA if enabled on the account).
6. Create the GitHub release from the tag, pasting the `CHANGELOG.md` section.

## Documentation site

The docs site (`docs/`, VitePress) deploys to GitHub Pages automatically via
`.github/workflows/docs.yml` on every push to `main` — no manual step. Preview
locally with `pnpm docs:dev`.
