# Public flip checklist (v1.0)

Ordered checklist for the v1.0 public flip. Open a tracking issue for each item; close as you complete.

## Pre-flight: Phase 14 deliverables merged

- [ ] `AGENTS.md`, `CLAUDE.md` pointer, `.cursor/`, `.codex/`, `.agents/` (Phase 14c)
- [ ] `docs/ai-context/` subtree complete (Phase 14c)
- [ ] `SECURITY.md`, `CODE_OF_CONDUCT.md`, `MAINTAINERS.md`, `CONTRIBUTING.md`, `RELEASING.md` (Phase 14b)
- [ ] `docs/plugin-governance.md`, `docs/security-best-practices-for-adopters.md` (Phase 14b)
- [ ] Per-plugin `LICENSE` files + `"author"` fields in plugin `package.json` (Phase 14b)
- [ ] `THIRD_PARTY_NOTICES.md` regenerated from current `pnpm-lock.yaml`
- [ ] Prettier, ESLint, `.githooks/`, `quality.yml`, `release.yml`, CODEOWNERS, Dependabot config (Phase 14a)

## Pre-flight: Phase 15 deliverables merged

- [ ] All 64 items in `impl-docs/security-baseline-for-phase-15.md` closed
- [ ] Lint baseline clean: zero `// eslint-disable`, `as any`, `// @ts-ignore` without justification across `src/`, `test/`, `packages/`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm test:keystone`, `pnpm build`, `pnpm lint`, `pnpm format:check`, `pnpm audit:prod` all green

## Pre-flight: owner-driven setup (out-of-repo)

- [ ] WebAuthn enrolled on the maintainer's npm account
- [ ] Breakglass npm account created with separate keys + email
- [ ] `@kalebtec` org scope claimed on npm with "Require 2FA" enforced
- [ ] `@browxai` defensive scope claimed
- [ ] Typosquat package names pre-claimed and deprecated (see baseline doc)
- [ ] npm trusted-publisher configuration set per package (repo + workflow + `release` environment binding)
- [ ] GitHub `release` environment configured (required reviewer, branch restriction)
- [ ] Domain renewal calendar reminders set

## Pre-flight: final sanity sweeps

- [ ] Run a secret scan on the full git history; resolve any findings
- [ ] Grep the tracked tree for personal paths, adopter-internal hostnames, Kalebtec-internal references
- [ ] Read `CHANGELOG.md` end-to-end as a stranger would; remove anything stale or internal
- [ ] Verify `.claude/hooks/` scripts have no internal references

## Flip-day ordered actions

1. Promote `## Unreleased` in `CHANGELOG.md` to `## [1.0.0] - YYYY-MM-DD`.
2. Bump `package.json` version to `1.0.0`.
3. Commit `chore(release): v1.0.0`.
4. Sign and push tag: `git tag -s v1.0.0 && git push origin main --tags`.
5. Watch the GitHub Actions run; approve the `release` environment gate when prompted.
6. `release.yml` publishes via OIDC + uploads SBOM + creates the GitHub Release.
7. Verify `npm install browxai@1.0.0` from a clean machine. Run `npm audit signatures`.
8. After the first OIDC publish succeeds, enable "Require 2FA and disallow tokens" on every published package on the npm side.
9. In GitHub repo settings: branch protection on `main` with required CI, required reviews, no force-push, signed commits. Verify CODEOWNERS protections on `.github/`, manifests, license, release workflow.
10. Flip repository visibility to public.
11. Post the launch announcement.

## Docs site go-live (browxai.com)

The docs site is an Astro + Starlight app in `website/`, deployed to GitHub
Pages by `.github/workflows/docs.yml`. That workflow is `workflow_dispatch`-only
until the steps below land, so a private repo with Pages disabled does not
red-flag every push. The published pages for the canonical docs are generated
from `docs/*.md` at build time by `website/scripts/sync-docs.mjs`; `docs/` stays
the single source of truth.

1. Smoke-test the build while still private: `gh workflow run docs.yml` and
   confirm the `build` job is green (the `deploy` job needs Pages enabled).
2. Point DNS for `browxai.com`:
   - Apex `A` records to the GitHub Pages IPs (verify against GitHub's current
     published set): `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
     `185.199.111.153`. Add the matching `AAAA` records for IPv6.
   - `www` `CNAME` to `kalebteccom.github.io` (www 301s to the apex).
3. Enable Pages: Settings -> Pages -> Source = "GitHub Actions".
4. Set the custom domain to `browxai.com`, wait for the DNS check to pass, then
   enable "Enforce HTTPS". The `website/public/CNAME` file is preserved into the
   build output, so the domain sticks across deploys.
5. Restore the auto-publish trigger in `.github/workflows/docs.yml`: change
   `on: workflow_dispatch` to also include `push: branches: [main]`.
6. Verify: `https://browxai.com` loads, the search box works, `www` redirects to
   the apex, and a shared link renders the `og.png` social card.

## Post-flip monitoring (first 30 days)

- Watch the security disclosure channel.
- Watch for unusual install patterns.
- Be ready for the first community PR; respond within 7 days.
- Track first-month metrics: install count, GitHub stars, issue volume, first dependent packages.
