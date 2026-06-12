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

## Release authority

- `@rowinbot` is the sole release authority.
- A breakglass account `@kalebtec-breakglass` is available only in emergencies (loss of primary maintainer access).

## OIDC trusted publishing

Releases go out via `.github/workflows/release.yml`, which uses a GitHub Actions OIDC token to authenticate to the npm registry. No long-lived publish token is stored in the repository. The publish job runs in a deployment environment named `release` that requires a manual approval before it can execute.

## Provenance and SBOM

- Every published artifact is signed with `--provenance` via the OIDC pipeline. The attestation is logged to the Sigstore transparency log and can be verified with `npm audit signatures`.
- The release workflow generates `sbom.cdx.json` (CycloneDX format) and attaches it to the GitHub Release alongside `THIRD_PARTY_NOTICES.md`.

## Keystone is a hard prerequisite

`pnpm test:keystone` must pass before a release is cut. If keystone is red, no release.

## Workspace plugin publishing

The workspace plugins under `@browxai/plugin-*` are versioned independently via Changesets. The same `release.yml` handles all packages in one pass; each package has its own trusted-publisher binding configured on the npm side.

## Deprecation policy

- For a critical issue discovered within 72 hours of publish, and where the package has no dependents that would break: unpublish and republish a patched version.
- For anything older or with dependents: use `npm deprecate <pkg>@<version> "Upgrade to <patched>."`. Never unpublish to free a package name.

## Release ritual checklist

1. Verify `pnpm typecheck && pnpm test && pnpm test:keystone && pnpm build && pnpm lint && pnpm format:check` all pass.
2. Promote `## Unreleased` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`.
3. Bump `version` in root `package.json` (and any other places where the version is duplicated; CI verifies).
4. Commit: `chore(release): vX.Y.Z`.
5. Sign and push the tag: `git tag -s vX.Y.Z && git push origin main --tags`.
6. Watch the Actions UI; approve the `release` environment when prompted.
7. After publish succeeds, verify `npm install browxai@X.Y.Z` from a clean machine and run `npm audit signatures`.
8. Create the GitHub Release from the tag; attach `sbom.cdx.json` and `THIRD_PARTY_NOTICES.md` (the workflow does this automatically).
