# Bot allowlist

Stub. Authoritative rationale lives in `SECURITY.md` (sibling-owned). This
file is the at-a-glance list maintainers consult before installing any
GitHub App or Action with broad scope.

## Allowed

- **Dependabot** — GitHub-native, `pull_request`-triggered, no secrets
  exposure to PR-derived code. Auto-merge constrained to dev-deps patches
  with a 7-day cooldown via `.github/workflows/dependabot-auto-merge.yml`.
- **CodeQL (default setup)** — GitHub-native, no secrets, results gated
  on PR status check.
- **GitHub Secret Scanning + push protection** — free for public repos;
  enable both.

## Forbidden (no exceptions without an explicit decisions-log entry)

- **Snyk** — installs as a GitHub App requiring org-wide write; rotates PR
  author identity onto humans without consent (the "escalate to a bad
  author" pattern).
- **Sonatype** — same shape as Snyk.
- **Mend.io** — same shape; overlaps Renovate.
- **Socket.dev** GitHub App — useful supply-chain heuristics, but the App
  scope is too broad; use the CLI in CI instead.
- **Codecov / Coveralls** — coverage is a developer-local metric; the 2021
  Codecov supply-chain incident is not worth re-introducing.
- **Renovate (Mend.io)** — redundant with Dependabot; broader app scope.
- **CLA assistant, third-party labelers, Mergify, PrettierBot** — each is a
  new write-permission third party; the GitHub-published `actions/labeler`
  covers labeling needs without an App install.
- **Vercel / Netlify / Cloudflare Pages** — browxai is an npm package, no
  preview deploy needed; preview-deploy bots have historically leaked env
  vars to fork-PR builds.
- **Third-party AI / agent GitHub Apps with `id-token: write`** — including
  Claude Code GitHub Action (CVE 2026, prompt-injection-via-comments →
  OIDC token theft, patched but the class persists).

See `SECURITY.md` (sibling-owned) for the rationale and the disclosure
channel. Anything outside this list requires a written justification logged
there before install.
