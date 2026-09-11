# Branch protection: required ruleset configuration

This document captures the GitHub branch-ruleset configuration that the
owner needs to apply to `main` in the GitHub UI. It is the source of truth
for what the release pipeline assumes. Every CI / OIDC trust property falls
over if branch protection lapses.

## Why a ruleset (not legacy branch protection)

Legacy branch protection can be bypassed via push-trigger workflows that
auto-approve from a PAT secret (`jeremylong/Bypassing-Required-Reviews`
PoC). Rulesets close that path: bypass is named-account-scoped and audited.

## `main` ruleset (required)

Status: partially applied. The ruleset named `main` exists and is `active`.
What is live, and what is deliberately still open, is recorded in "Applied vs
pending" at the end of this section, so read that before assuming a property
is enforced.

Apply at: GitHub repo → Settings → Rules → Rulesets → New ruleset → "main".

| Ruleset setting                          | Value                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target branches                          | `main`                                                                                                                                                                       |
| Bypass list                              | empty: no admin bypass, no PAT bypass                                                                                                                                        |
| Restrict creations / updates / deletions | restrict deletions; restrict force pushes                                                                                                                                    |
| Require linear history                   | on (squash + merge only, so PRs never land a merge commit and blame stays clean)                                                                                             |
| Require signed commits                   | on                                                                                                                                                                           |
| Require a pull request before merging    | required approvals: 1; dismiss stale pull request approvals when new commits are pushed; require review from CODEOWNERS; require approval of the most recent reviewable push |
| Require status checks to pass            | the checks listed below, with "require branches to be up to date before merging" on                                                                                          |
| Allowed merge methods                    | squash only, which is what "require linear history" above implies                                                                                                            |

For the status checks, use the exact names GitHub reports. Those are bare job
names; a `<workflow> / <job>` string never matches, and requiring a name that
no job produces blocks every PR forever. Verify against a real run
(`gh pr view <n> --json statusCheckRollup`) before adding one.

- `build (22)`: the declared `engines` floor
- `build (26)`: the current development version
- `keystone`
- `lint`
- `audit`
- `secret-scan`
- `zizmor`
- `package-contents`
- `CodeQL` (added once default setup is enabled; sibling task)

### Applied vs pending

Live on `main` today:

| Property                                                 | State               |
| -------------------------------------------------------- | ------------------- |
| Restrict deletions                                       | enforced            |
| Restrict force pushes (`non_fast_forward`)               | enforced            |
| Require linear history                                   | enforced            |
| Require a PR before merging                              | enforced            |
| Squash-only merges                                       | enforced            |
| The eight status checks above, branch must be up to date | enforced            |
| Bypass list                                              | empty, as specified |

Two properties are deliberately still open, because each one can lock the
repo.

Required approvals of 1 plus review from CODEOWNERS: there are two admin
accounts, so this is satisfiable, but it makes every merge a two-account
operation. Turn it on once the second maintainer is a separate human rather
than a second account held by the same person. Until then it buys audit
trail, not review.

Required signed commits: nothing in the current history is verifiably signed.
Enable only alongside a signing key on every account that pushes, or the
first push after enabling is rejected with nothing to fall back on.

## Path-scoped ruleset (`.github/**`)

A second ruleset, scoped to `.github/**`, layered on top:

- Target paths: `.github/**`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `.npmrc`, `.npmignore`, `LICENSE`, `SECURITY.md`,
  `THIRD_PARTY_NOTICES.md`, `tsconfig.json`, `tsconfig.build.json`,
  `eslint.config.js`, `.githooks/**`.
- Required reviewer: `@rowinbot` (matches `.github/CODEOWNERS`).
- The same status-check requirement as the `main` ruleset.

This is defense in depth versus a PR that silently amends CODEOWNERS. The
path-scoped ruleset still demands `@rowinbot` even if CODEOWNERS itself
gets temporarily mis-edited.

## GitHub Environment: `release`

The `release.yml` workflow's `publish` and `publish-plugins` jobs reference
`environment: release`. The environment must be configured before the first
release runs:

- Required reviewers: `@rowinbot`, plus one additional Kalebtec org member
  once secondary-maintainer staffing lands. Until then a single reviewer is
  an acceptable launch posture.
- Deployment branches: `main` and `release/*` only. No fork branches.
- Environment secrets: none. OIDC removes the need for `NPM_TOKEN`, and there
  is no scenario in which this environment should hold secrets.
- Wait timer: off at v1.0; promote to a 5-minute wait if abuse signals appear
  in adopter telemetry.

## npm trusted-publisher binding

Configured per-package on `npmjs.com` → package → Settings → Trusted
Publisher. Each `browxai` and `@browxai/plugin-*` record binds to:

- Provider: GitHub Actions
- Org / repo: `kalebteccom/browxai`
- Workflow filename: `release.yml` (exact match, case-sensitive)
- Environment: `release`

After the first successful OIDC publish, enable "Require 2FA and disallow
tokens" per-package. That makes phishable long-lived tokens impossible. From
that point forward, only OIDC plus interactive 2FA can publish.

## Org-level Actions policy (apply once per org)

- Allowed actions: "Allow `actions/*` + `github/*` + selected actions", an
  explicit allowlist matching the SHA-pinned actions in `ci.yml`,
  `quality.yml`, `release.yml`, `dependabot-auto-merge.yml`.
- Require SHA-pinned actions: on (GitHub Aug 2025 changelog).
- Default workflow permissions: read-only on `GITHUB_TOKEN`.
- Fork PR workflows: require approval for all outside collaborators.
- Send write tokens / secrets to workflows from fork PRs: off.

## What we accept (gaps)

The reproducibility matrix is best-effort. The `release.yml`
`reproducibility` job builds dist/ on a second runner and diffs. If a
legitimate non-deterministic step surfaces during the v1.0 rollout, say a
timestamp embedded in a banner, the gap promotes to a `SECURITY.md`
aspiration entry and the gate stays where it is.

First-publish bootstrap is the other gap. The OIDC trusted-publisher binding
cannot be created until the package exists on npm. The first publish goes via
an interactive `npm publish` from a maintainer with 2FA hardware key, with a
`0.0.1-rc.0` tag to validate the workflow shape without burning `latest`.
Subsequent publishes are OIDC-only.

See also:

- `.github/workflows/release.yml`
- `.github/CODEOWNERS`
- `.github/BOT_ALLOWLIST.md`
- `SECURITY.md` (sibling-owned)
- `RELEASING.md` (sibling-owned)
