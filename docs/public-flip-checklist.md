# Public flip checklist (v1.0)

Ordered checklist for the v1.0 public flip. Open a tracking issue for each item; close as you complete.

## Pre-flight: governance + multi-harness pointers

- [ ] `AGENTS.md`, `CLAUDE.md` pointer, `.cursor/`, `.codex/`, `.agents/`
- [ ] `docs/ai-context/` subtree complete
- [ ] `SECURITY.md`, `CODE_OF_CONDUCT.md`, `MAINTAINERS.md`, `CONTRIBUTING.md`, `RELEASING.md`
- [ ] `docs/plugin-governance.md`, `docs/security-best-practices-for-adopters.md`
- [ ] Per-plugin `LICENSE` files + `"author"` fields in plugin `package.json`
- [ ] `THIRD_PARTY_NOTICES.md` regenerated from current `pnpm-lock.yaml`
- [ ] Prettier, ESLint, `.githooks/`, `quality.yml`, `release.yml`, CODEOWNERS, Dependabot config

## Pre-flight: security baseline + lint convergence

- [ ] OSS security-baseline items closed
- [ ] Lint baseline clean: zero `// eslint-disable`, `as any`, `// @ts-ignore` without justification across `src/`, `test/`, `packages/`
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm test:keystone`, `pnpm build`, `pnpm lint`, `pnpm format:check`, `pnpm audit:prod` all green

## Pre-flight: owner-driven setup (out-of-repo)

- [ ] WebAuthn enrolled on the maintainer's npm account
- [ ] Breakglass npm account created with separate keys + email
- [x] `@browxai` org scope claimed on npm (org registered; enforce "Require 2FA" before the first publish)
- [ ] Old `@kalebtec/browxai-plugin-*` names retained defensively (never published; do not free them for squatting)
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

## Docs site go-live (browxai.com via Netlify)

The docs site is a static Astro + Starlight app in `website/`, deployed by
Netlify (config in `netlify.toml`). The published pages for the canonical docs
are generated from `docs/*.md` at build time by `website/scripts/sync-docs.mjs`;
`docs/` stays the single source of truth.

1. Create the Netlify site from the `kalebteccom/browxai` repo. `netlify.toml`
   already declares the build:
   - Command: `pnpm --filter @browxai/website rebuild esbuild sharp && pnpm --filter @browxai/website build`
   - Publish: `website/dist`. Node 20; pnpm via the root `packageManager` field.
   - For a private repo, grant Netlify's GitHub app read access, or do a manual
     deploy of the prebuilt output: `netlify deploy --prod --dir=website/dist`.
2. Trigger a deploy and confirm it is green. The build runs prose-guard, the
   link validator, and Pagefind - the same gates as local.
3. Add the custom domain (Netlify -> Domain management): set `browxai.com` as the
   primary domain and add `www.browxai.com`; Netlify auto-redirects www -> apex.
4. Point DNS for `browxai.com`:
   - Easiest: switch the registrar's nameservers to Netlify DNS.
   - Or external DNS: apex `ALIAS`/`A` to Netlify's load balancer
     (`apex-loadbalancer.netlify.com`), and a `www` `CNAME` to
     `<site>.netlify.app`.
5. Netlify provisions the Let's Encrypt certificate once DNS resolves; turn on
   "Force HTTPS".
6. Verify: `https://browxai.com` loads, search works, `www` 301s to the apex,
   the branded 404 renders on an unknown path, and a shared link shows `og.png`.

Netlify is the only deploy. The former GitHub Pages workflow
(`.github/workflows/docs.yml`) and the `website/public/CNAME` file have been
removed; Netlify sets the domain in its UI / `netlify.toml`.

## Post-flip monitoring (first 30 days)

- Watch the security disclosure channel.
- Watch for unusual install patterns.
- Be ready for the first community PR; respond within 7 days.
- Track first-month metrics: install count, GitHub stars, issue volume, first dependent packages.
