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

## Release ritual checklist

1. Verify `pnpm typecheck && pnpm test && pnpm test:keystone && pnpm build && pnpm lint && pnpm format:check` all pass.
2. Promote `## Unreleased` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`.
3. Bump `version` in root `package.json`. That is the only place the host
   version lives — the server's `VERSION` export (MCP handshake, SDK client
   identity) is derived from `package.json` at module load
   (`src/util/version.ts`), so there is no second constant to keep in sync.
4. If a plugin under `packages/plugins/*` changed, hand-bump its own
   `package.json#version` in the same commit (see "Workspace plugin
   publishing" below).
5. Commit: `chore(release): vX.Y.Z`.
6. Sign and push the tag: `git tag -s vX.Y.Z && git push origin main --tags`.
7. Watch the Actions UI; approve the `release` environment when prompted.
   Publishing happens **only** through `release.yml` — never run
   `npm publish` / `pnpm publish` locally (see "OIDC trusted publishing").
8. After publish succeeds, verify `npm install browxai@X.Y.Z` from a clean
   machine and run `npm audit signatures`.
9. Create the GitHub Release from the tag, pasting the `CHANGELOG.md`
   section; the workflow attaches `sbom.cdx.json` automatically.

## Documentation site

The public docs site is an Astro + Starlight build in `website/` (which
syncs its content from `docs/` at build time), deployed by **Netlify** on
every push to `main` per `netlify.toml` — no manual step and no GitHub
Actions involvement. Preview locally with `pnpm docs:dev`; build with
`pnpm docs:build`. Site-related launch gates live in
[`docs/public-flip-checklist.md`](docs/public-flip-checklist.md).

## Release authority

- `@rowinkaleb` is the sole release authority.
- A breakglass account `@kalebtec-breakglass` is available only in emergencies (loss of primary maintainer access).

## OIDC trusted publishing

Releases go out via `.github/workflows/release.yml`, which uses a GitHub Actions OIDC token to authenticate to the npm registry. No long-lived publish token is stored in the repository, and no human or agent ever runs a publish command locally (`AGENTS.md` lists `npm publish` / `pnpm publish` as forbidden). The publish jobs run in a deployment environment named `release` that requires a manual approval before they can execute.

## Provenance and SBOM

- Every published artifact is signed with `--provenance` via the OIDC pipeline. The attestation is logged to the Sigstore transparency log and can be verified with `npm audit signatures`.
- The release workflow generates `sbom.cdx.json` (CycloneDX format) and attaches it to the GitHub Release alongside `THIRD_PARTY_NOTICES.md`.

## Keystone is a hard prerequisite

`pnpm test:keystone` must pass before a release is cut. If keystone is red, no release.

## Workspace plugin publishing

The `@browxai/plugin-*` packages under `packages/plugins/*` are versioned
independently of the host: bump a plugin's `package.json#version` by hand in
the change that warrants it (there is no Changesets or other automation).
Every `vX.Y.Z` tag runs the `publish-plugins` job, which loops over the
plugin packages and publishes each with `npm publish --provenance` — but
only after a registry existence check, so plugin versions that already
shipped under an earlier tag are skipped rather than failing the release.
Each plugin has its own trusted-publisher binding configured on the npm
side.

## Deprecation policy

- For a critical issue discovered within 72 hours of publish, and where the package has no dependents that would break: unpublish and republish a patched version.
- For anything older or with dependents: use `npm deprecate <pkg>@<version> "Upgrade to <patched>."`. Never unpublish to free a package name.
