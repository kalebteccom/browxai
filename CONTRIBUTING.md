# Contributing to browxai

Thanks for your interest. browxai is MIT-licensed; contributions are welcome.

## Development setup

```bash
corepack enable && pnpm install
pnpm install-browser          # Chromium for playwright-core (one-time)
```

Checks (all must pass before a PR merges — CI runs them):

```bash
pnpm typecheck                # tsc --noEmit
pnpm test                     # vitest unit suite — hermetic, no browser
pnpm build                    # tsc → dist/
pnpm test:keystone            # headless end-to-end against real Chromium
```

The unit suite is fast and browser-free (Playwright is mocked). The
**keystone** (`test/keystone/`) drives a real headless Chromium end-to-end
through the actual MCP tool handlers — run it for anything touching page
interaction, the session model, or capabilities.

## Conventions

- **Commits** — single-line [Conventional Commits](https://www.conventionalcommits.org/)
  subject, **≤72 chars**, no body, no AI-attribution trailers. Repo hooks
  enforce all three; don't bypass them.
- **Design for the problem class.** When a consumer asks for a specific
  feature, build the *generic primitive* for the underlying problem, not the
  literal ask. Keep dependency / framework / app names out of code, comments,
  tests, and public docs.
- **No arbitrary-JS creep.** `eval_js` is the single arbitrary-JS loophole and
  is gated behind the `eval` capability. No other tool may accept
  agent-supplied JavaScript — in-page scripts must be fixed and server-owned.
- **Safe by default.** New dangerous surface (filesystem, network mocking,
  arbitrary evaluation, OS resources) ships **off by default** behind a
  capability — never in the default set.
- **Tests** — every behavioural change needs unit coverage; real-browser
  behaviour belongs in the keystone.

## Stability & the public surface

browxai follows semver. The **stable surface** — tool names, documented
input/output shapes, the `ActionResult` shape, the `eN` ref scheme, the
default capability set — does not change in a `patch`; an additive change is a
`minor`; a breaking change requires a `minor` bump plus a changelog entry and
a deprecation note.

New, experimental, or higher-risk tools land **behind an off-by-default
capability** (often the `unstable` lane) — that keeps them out of the stable
guarantee until they're promoted deliberately. Prefer that lane for new asks.

## Pull requests

1. Branch, make the change, add tests, keep `typecheck` / `test` / `build` green.
2. Update `docs/tool-reference.md` for any surface change, and `CHANGELOG.md`.
3. Open a PR using the template; describe the *why*.

## Reporting issues

Use the issue templates. For security-sensitive reports, please contact the
maintainers privately rather than opening a public issue.
