# Public flip — operational checklist

The literal click-by-click sequence the owner works through on flip day. Tick
each box as you go. Designed to be opened on one screen with the npm and
GitHub UIs on the other.

> Planning-level companion: [`docs/public-flip-checklist.md`](../../public-flip-checklist.md)
> tracks the pre-flight artefact closure — it answers _"are we ready to
> flip?"_. This document answers _"how do I flip?"_.

Cross-references used throughout:

- Branch ruleset config: [`branch-protection.md`](./branch-protection.md)
- Release-cutting steps: [`../../../RELEASING.md`](../../../RELEASING.md)
- Vuln reporting channel: [`../../../SECURITY.md`](../../../SECURITY.md)
- Universal OSS security baseline (canonical lives in the portfolio repo
  under `projects/oss-security/guidelines/universal-baseline.md`)

---

## 1. Pre-flip code-state verification

- [ ] `pnpm lint` — 0 errors, 0 warnings
- [ ] `pnpm test` — 1602/1602 passing
- [ ] `pnpm build` — clean
- [ ] `zizmor --persona=auditor --min-severity=high .github/workflows/` — 0 high-severity findings
- [ ] All pre-flip governance, lint convergence, and CI-hardening work
      merged to `main`
- [ ] `CHANGELOG.md` `## Unreleased` matches what is about to release (no
      stale entries, no missing ones)
- [ ] All governance docs present and final-reviewed: `AGENTS.md`,
      `SECURITY.md`, `CONTRIBUTING.md`, `RELEASING.md`, `MAINTAINERS.md`,
      `CODE_OF_CONDUCT.md`, `THIRD_PARTY_NOTICES.md`
- [ ] Root `package.json` + 4 plugin `package.json` files bumped to the
      publish target (default: `0.7.1` for the stub rehearsal, `1.0.0-rc.0`
      for the first real RC)

## 2. Pre-flip git-history scrub

- [ ] `git log --all --grep="secret\|password\|token\|api[_-]key" -i`
      returns nothing operationally relevant
- [ ] `git ls-files | grep -iE '\.(env|pem|key|p12|pfx|crt)$'` shows nothing
      committed
- [ ] `git grep` for secret patterns (`sk-`, `ghp_`, `AKIA`, `xoxb-`, etc.)
      across the tracked tree returns clean
- [ ] Spot-check the last ~20 commits for adopter-internal hostnames,
      personal paths, or Kalebtec-internal references

## 3. GitHub repo settings (the moment of flipping)

- [ ] Settings → General → Danger Zone → **Change visibility → Public**
      _(this is the flip)_
- [ ] Settings → Environments → create `release`:
  - [ ] Required reviewers: owner _(free on public repos now)_
  - [ ] Deployment branches and tags → restrict to tag pattern `v*.*.*`
  - [ ] No environment secrets _(OIDC removes the need)_
- [ ] Settings → Rules → Rulesets → branch ruleset for `main` per
      [`branch-protection.md`](./branch-protection.md) (signed commits,
      CODEOWNERS review, no admin bypass, no force push, no deletion)
- [ ] Settings → Rules → Rulesets → branch ruleset for `release/*` — same
      rules as `main`
- [ ] Settings → Actions → General → Workflow permissions →
      "Read repository contents and packages permissions" +
      **uncheck** "Allow GitHub Actions to create and approve pull requests"
- [ ] Settings → Pages → configure if the docs site goes live now
      (see `.github/workflows/docs.yml` setup)

## 4. npm Trusted Publisher binding (5 packages)

- [ ] Log in to `npmjs.com` as the `browxai` org owner (org registered; enforce "Require 2FA" before the first publish)
- [ ] For packages that don't yet exist on npm, use the org-level
      **pending trusted publisher** flow
- [ ] Configure for each of the five packages:
  - [ ] `browxai`
  - [ ] `@browxai/plugin-example`
  - [ ] `@browxai/plugin-figma`
  - [ ] `@browxai/plugin-tldraw`
  - [ ] `@browxai/plugin-excalidraw`
- [ ] Binding values (identical for all five):
  - Repository owner: `kalebteccom`
  - Repository name: `browxai`
  - Workflow filename: `release.yml`
  - Environment name: `release`

<!-- TODO: the exact npm web UI navigation path for "pending publishers" is
     unverified at the time of writing. Owner should screenshot the path
     during flip and feed the captures back into this doc for future
     projects. -->

## 5. First OIDC publish (rehearsal or real)

- [ ] Bump versions: root `package.json` + all 4 plugin `package.json` files
      to the target
- [ ] Update `CHANGELOG.md` with the release entry (promote `## Unreleased`
      to `## [X.Y.Z] - YYYY-MM-DD`)
- [ ] Create + commit on a `release/<version>` branch
- [ ] Tag `v<version>` on the commit (matches the `v*.*.*` workflow trigger)
- [ ] Push the tag → `release.yml` triggers
- [ ] Watch the workflow in GitHub Actions
- [ ] Approve the `release` environment deployment when prompted
- [ ] Verify each of the 5 packages published successfully via
      `npm view <name>` (look for the bumped version under `dist-tags.latest`)

Full release ritual + Changesets handling for plugins:
[`RELEASING.md`](../../../RELEASING.md).

## 6. Post-publish hardening

- [ ] For each of the 5 published packages: npm web → package → Settings →
      **"Require 2FA and disallow tokens"** → ON
- [ ] If this was a **stub** publish (e.g. `0.7.1` placeholder), deprecate
      each: `npm deprecate <name>@<version> "Pre-release stub. Use v1.x."`
- [ ] Verify provenance attestation for each:
      `npm view <name> --json | jq .dist.attestations`
- [ ] Verify the Sigstore transparency log shows the publish event
- [ ] (Optional) trigger the typosquat-claims workflow per
      `projects/oss-security/typosquat-pre-claims.md` in the portfolio repo

## 7. Adopter readiness

- [ ] `README.md` is the right entry point — leads with **what browxai is**
      plus a quickstart, not internal jargon
- [ ] `SECURITY.md` vuln-reporting channel is real and monitored — see
      [`SECURITY.md`](../../../SECURITY.md)
- [ ] [`docs/security-best-practices-for-adopters.md`](../../security-best-practices-for-adopters.md)
      linked from `README.md`
- [ ] `AGENTS.md` discoverable for AI-driven contributors
- [ ] Issue templates exist (`.github/ISSUE_TEMPLATE/`) — or explicitly note
      they don't yet (candidate for a post-flip follow-up)
- [ ] PR template exists (`.github/PULL_REQUEST_TEMPLATE.md`) — or note that
      it doesn't yet

## 8. Rollback plan

**Publish breaks adopters:**

- [ ] Within 72h of publish: `npm unpublish` + republish patched
- [ ] Beyond 72h: `npm deprecate <pkg>@<version> "Upgrade to <patched>."`
      — never `unpublish` after the 72h window

**Public flip surfaces a leak:**

- [ ] Settings → General → Danger Zone → **Change visibility → Private**
      (reverts visibility immediately — but assume anything exposed during
      the window is permanently exposed: git history, CI logs, and the
      dependency graph were all public)
- [ ] Audit what was exposed during the public window
- [ ] Document the incident in `projects/oss-security/incident-log.md`
      (portfolio repo)

**Branch rule emergency override:** NO — there is no admin bypass on the
`main` or `release/*` rulesets (universal-baseline rule 26). If a rule must
genuinely change, it changes via PR + ruleset edit, not by bypass.

## 9. Communication

- [ ] _(Intentionally blank — owner decides channels: launch tweet, blog
      post, OSS-news submission, etc.)_
- [ ] Notify FanFest of public availability (early adopter; sign-off on
      adopter-report attribution)
