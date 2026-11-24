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
   Refresh the engine evidence dates in the same release PR: see
   [`docs/ai-context/release-process/engine-evidence.md`](docs/ai-context/release-process/engine-evidence.md).
3. Bump `version` in root `package.json`. That is the only place the host
   version lives — the server's `VERSION` export (MCP handshake, SDK client
   identity) is derived from `package.json` at module load
   (`src/util/version.ts`), so there is no second constant to keep in sync.
4. If a plugin under `packages/plugins/*` changed, hand-bump its own
   `package.json#version` in the same commit (see "Workspace plugin
   publishing" below).
5. Commit: `chore(release): vX.Y.Z`.
6. Sign and push the tag: `git tag -s vX.Y.Z && git push origin main --tags`.
   The release authority may instead have an agent push an annotated tag
   (`git tag -a vX.Y.Z -m "browxai vX.Y.Z" && git push origin vX.Y.Z`) when the
   signing key is unavailable. `release.yml` does not check the tag signature;
   what ties a package to its source is the npm provenance statement signed by the
   workflow run (`npm audit signatures`), so keep that check in step 8. v0.12.0
   was released this way.
7. Watch the Actions UI; approve the `release` environment when prompted.
   Publishing happens **only** through `release.yml` — never run
   `npm publish` / `pnpm publish` locally (see "OIDC trusted publishing").
8. After publish succeeds, verify `npm install browxai@X.Y.Z` from a clean
   machine and run `npm audit signatures`.
9. Create the GitHub Release from the tag, pasting the `CHANGELOG.md`
   section; the workflow attaches `sbom.cdx.json` automatically.

## macOS app (manual, on the owner's Mac)

The npm publish above is unchanged. The signed macOS app ([RFC 0012](docs/rfcs/0012-signed-macos-app.md)) is a separate artifact that the owner builds, signs, notarizes and uploads by hand, on a Mac, until a Mac CI lane exists. `release.yml` holds no signing key or notary credential and does not build the app, and a missing app never blocks an npm release. Start after step 9 above, once the tag has published and the GitHub Release exists.

The Team ID and the notary keychain profile name come from the environment (`BROWXAI_APPLE_TEAM_ID`, `BROWXAI_NOTARY_KEYCHAIN_PROFILE`). The certificate and the notary credential stay in the owner's keychain. None of them goes into the repository, a script or an issue.

1. Check out the release tag and build: `pnpm install --frozen-lockfile && pnpm build`. The app ships the `dist/` that the release workflow already built and checked for reproducibility.
2. Assemble the unsigned app with `scripts/macos/build-app.sh`. Its header comment lists its arguments and where it writes `Browxai.app`. Check that it exits 0 and that the architecture is the one you mean to ship (`lipo -archs` on the launcher and on `Contents/Resources/node/bin/node` agree).
3. To bundle the cloud host agent, download its binary and its SHA-256 from the cloud release and export `BROWXAI_CLOUD_HELPER` (the path) and `BROWXAI_CLOUD_HELPER_SHA256`. Set both or neither.
4. Sign, notarize and staple: `scripts/macos/release-app.sh <path/to/Browxai.app> X.Y.Z`. Check the output for notary status `Accepted`, a passing `stapler validate` and Gatekeeper's `Notarized Developer ID`. It writes `browxai-X.Y.Z-macos-<arch>.zip`, its `.sha256` file and the stapled app into `BROWXAI_OUT_DIR`.
5. Verify the result: `scripts/macos/verify-app.sh <out dir>/Browxai.app`, with `BROWXAI_EXPECT_TEAM_ID`, `BROWXAI_EXPECT_BUNDLE_ID=com.kalebtec.browxai` and `BROWXAI_DR_BASELINE` pointing at the designated requirement file of the previous release, kept outside the repository. The run must exit 0 with no `FAIL:` line. The first release writes the baseline file. Every later release must equal it, which keeps users' permission grants across an update.
6. Upload the zip and its `.sha256` file to the GitHub Release by hand, for example `gh release upload vX.Y.Z <zip> <zip>.sha256`. Check that the asset name is exactly `browxai-X.Y.Z-macos-<arch>.zip`, because the cask builds its download URL from it.
7. Fill the cask: `scripts/macos/make-cask.sh [--with-helper] <zip> X.Y.Z > browxai.rb`. Use `--with-helper` only when step 3 ran. The script needs no network. It stops when the zip name, the version or the `.sha256` file disagree, and prints the SHA-256 it used.
8. Update the tap: put `browxai.rb` at `Casks/browxai.rb` in the tap repository (`kalebteccom/homebrew-tap` is the proposed name, the owner creates it once, see RFC 0012, "Homebrew"), then run `brew style` and `brew audit --cask --online browxai`. On a Mac that has the previous release installed, run `brew upgrade --cask browxai`. Check that the app opens with no Gatekeeper warning, that `browxai doctor` shows the `macos-app` row as signed with the expected team id, and that earlier permission grants still apply.
9. Record the run. Like a by-hand engine run in [`docs/ai-context/release-process/engine-evidence.md`](docs/ai-context/release-process/engine-evidence.md), a macOS app release writes down the macOS version it was verified on (`sw_vers -productVersion`), the architecture, the app version and the date, in the CHANGELOG line for the release. Never record a serial number, a hostname or a certificate name. An app release with no recorded run is `not run`.

## Documentation site

The public docs site is an Astro + Starlight build in `website/` (which
syncs its content from `docs/` at build time), hosted on **Netlify**.

**It does not auto-deploy.** The Netlify project has no repository
connected — `build_settings` is empty, so `netlify.toml` is never read and
nothing rebuilds on a push to `main`. The site went five months without a
deploy before this was noticed, serving documentation that no longer matched
the code. Until a repo is connected in the Netlify UI, publishing is a
manual step in the release ritual:

```bash
pnpm docs:build     # builds website/dist, and fails on any broken internal link
pnpm docs:deploy    # pushes website/dist to production
```

Run both from the repo root. `docs:deploy` runs the Netlify CLI from a
neutral directory on purpose: invoked inside this pnpm workspace the CLI
misreads the workspace and crashes with "Netlify CLI has terminated
unexpectedly".

Preview locally with `pnpm docs:dev`. Site-related launch gates live in
[`docs/public-flip-checklist.md`](docs/public-flip-checklist.md).

## Release authority

- `@rowinbot` is the sole release authority.
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
