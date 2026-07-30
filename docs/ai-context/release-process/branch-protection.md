# Branch protection — required ruleset configuration

This document captures the GitHub branch-ruleset configuration that the
owner needs to apply to `main` in the GitHub UI. It is the source of truth
for what the release pipeline assumes — every CI / OIDC trust property
falls over if branch protection lapses.

## Why a ruleset (not legacy branch protection)

Legacy branch protection can be bypassed via push-trigger workflows that
auto-approve from a PAT secret (`jeremylong/Bypassing-Required-Reviews`
PoC). Rulesets close that path: bypass is named-account-scoped and audited.

## `main` ruleset (required)

**Status: partially applied.** The ruleset named `main` exists and is
`active`. What is live, and what is deliberately still open, is recorded in
"Applied vs pending" at the end of this section — read that before assuming a
property is enforced.

Apply at: GitHub repo → Settings → Rules → Rulesets → New ruleset → "main".

- **Target branches:** `main`.
- **Bypass list:** empty. No admin bypass. No PAT bypass.
- **Restrict creations / updates / deletions:** restrict deletions; restrict
  force pushes.
- **Require linear history:** on (squash + merge only; no merge commits
  from PRs to keep blame clean).
- **Require signed commits:** on.
- **Require a pull request before merging:**
  - Required approvals: 1.
  - Dismiss stale pull request approvals when new commits are pushed.
  - Require review from CODEOWNERS.
  - Require approval of the most recent reviewable push.
- **Require status checks to pass:** use the exact check names GitHub
  reports, which are the job names — not `<workflow> / <job>`. Requiring a
  name that no job produces blocks every PR forever, so verify against a real
  run (`gh pr view <n> --json statusCheckRollup`) before adding one.
  - `build (22)` — the declared `engines` floor
  - `build (26)` — the current development version
  - `keystone`
  - `lint`
  - `audit`
  - `secret-scan`
  - `zizmor`
  - `package-contents`
  - `CodeQL` (added once default setup is enabled — sibling task)
  - Require branches to be up to date before merging: on.
- **Allowed merge methods:** squash only, which is what "require linear
  history" above implies.

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

Deliberately **not** yet enforced, because each one can lock the repo:

- **Required approvals: 1 + review from CODEOWNERS.** There are two admin
  accounts, so this is satisfiable, but it makes every merge a two-account
  operation. Turn on once the second maintainer is a separate human rather
  than a second account held by the same person; until then it buys audit
  trail, not review.
- **Require signed commits.** Nothing in the current history is verifiably
  signed. Enable only alongside a signing key on every account that pushes,
  or the first push after enabling is rejected with nothing to fall back on.

## Path-scoped ruleset (`.github/**`)

A second ruleset, scoped to `.github/**`, layered on top:

- **Target paths:** `.github/**`, `package.json`, `pnpm-lock.yaml`,
  `pnpm-workspace.yaml`, `.npmrc`, `.npmignore`, `LICENSE`, `SECURITY.md`,
  `THIRD_PARTY_NOTICES.md`, `tsconfig.json`, `tsconfig.build.json`,
  `eslint.config.js`, `.githooks/**`.
- **Required reviewer:** `@rowinbot` (matches `.github/CODEOWNERS`).
- **Same status-check requirement** as the `main` ruleset.

This is defense in depth versus a PR that silently amends CODEOWNERS — the
path-scoped ruleset still demands `@rowinbot` even if CODEOWNERS itself
gets temporarily mis-edited.

## GitHub Environment: `release`

The `release.yml` workflow's `publish` and `publish-plugins` jobs reference
`environment: release`. The environment must be configured before the first
release runs:

- **Required reviewers:** `@rowinbot` (plus one additional Kalebtec org
  member once secondary-maintainer staffing lands; until then, single
  reviewer is acceptable as a launch posture).
- **Deployment branches:** `main` and `release/*` only. No fork branches.
- **Environment secrets:** none. OIDC removes the need for `NPM_TOKEN`;
  there is no scenario in which this environment should hold secrets.
- **Wait timer:** off at v1.0; promote to a 5-minute wait if abuse signals
  appear in adopter telemetry.

## npm trusted-publisher binding

Configured per-package on `npmjs.com` → package → Settings → Trusted
Publisher. Each `browxai` and `@browxai/plugin-*` record binds to:

- Provider: GitHub Actions
- Org / repo: `kalebteccom/browxai`
- Workflow filename: `release.yml` (exact match, case-sensitive)
- Environment: `release`

After the first successful OIDC publish, enable **"Require 2FA and disallow
tokens"** per-package. This makes phishable long-lived tokens impossible;
only OIDC + interactive 2FA can publish from that point forward.

## Org-level Actions policy (apply once per org)

- **Allowed actions:** "Allow `actions/*` + `github/*` + selected actions"
  — explicit allowlist matching the SHA-pinned actions in `ci.yml`,
  `quality.yml`, `release.yml`, `dependabot-auto-merge.yml`.
- **Require SHA-pinned actions:** on (GitHub Aug 2025 changelog).
- **Default workflow permissions:** read-only on `GITHUB_TOKEN`.
- **Fork PR workflows:** require approval for all outside collaborators.
- **Send write tokens / secrets to workflows from fork PRs:** off.

## What we accept (gaps)

- **Reproducibility matrix is best-effort.** The `release.yml`
  `reproducibility` job builds dist/ on a second runner and diffs. If a
  legitimate non-deterministic step (e.g. timestamp embedded in a banner)
  surfaces during the v1.0 rollout, the gap promotes to a `SECURITY.md`
  aspiration entry rather than the gate being loosened.
- **First-publish bootstrap.** The OIDC trusted-publisher binding cannot
  be created until the package exists on npm. The first publish goes via
  an interactive `npm publish` from a maintainer with 2FA hardware key,
  with a `0.0.1-rc.0` tag to validate the workflow shape without burning
  `latest`. Subsequent publishes are OIDC-only.

See also:

- `.github/workflows/release.yml`
- `.github/CODEOWNERS`
- `.github/BOT_ALLOWLIST.md`
- `SECURITY.md` (sibling-owned)
- `RELEASING.md` (sibling-owned)
