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
  feature, build the _generic primitive_ for the underlying problem, not the
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
3. Open a PR using the template; describe the _why_.

## Reporting issues

Use the issue templates. For security-sensitive reports, please contact the
maintainers privately rather than opening a public issue.

## Developer Certificate of Origin (DCO)

We require contributors to sign off on commits with `git commit -s`. This adds a `Signed-off-by:` trailer that attests you wrote (or have the right to contribute) the change under the project's license. We use DCO instead of a CLA. The DCO text lives at https://developercertificate.org/.

## No internal tracker identifiers in code

Project-management identifiers (`W-X#`, `Round-N`, ticket numbers, etc.) do not belong in source code or code comments. They belong in commit messages and PR descriptions. State the reason directly in the comment, not the ticket number. ESLint enforces this rule across the repo. An exception applies for `INV-N`-style identifier schemes tied to specific enforcing tests; browxai has none of these today.

## Page-side function pattern

Tools that ship code into the browser page (for example `dom_export`, `element_export`) must use a real TypeScript function literal with `/// <reference lib="dom" />` at the file head. They must not pass stringified arrow expressions to `page.evaluate` or `locator.evaluate`. The keystone test at `test/keystone/<name>.keystone.test.ts` is the regression gate. ESLint enforces the rule pattern; the keystone enforces the behavior.

## Adding a workspace plugin

To add a new plugin under `packages/plugins/<name>/`:

1. Create `package.json` with the `"browxai"` manifest field (`apiVersion`, `browxaiVersion`, `namespace`, `register`, `capabilities[]`, `trust`, `dependsOn[]`).
2. Add `schema.d.ts` declaring the tool I/O types.
3. Add `README.md` (purpose, capabilities, configuration).
4. Add `LICENSE` (MIT, identical to root).
5. Add `src/index.ts` exporting `register(api)`.
6. Add tests.
7. Add a row in the host `CHANGELOG.md` under `### Plugins`.

See `docs/plugin-authoring.md` and `docs/plugin-governance.md` for details on the manifest contract and trust tiers.

## Workspace-rooted paths

Every transient path browxai writes lives under `$BROWX_WORKSPACE` (default `~/.browxai/`). Code uses `resolveWorkspacePath` as the chokepoint; nothing writes to `$HOME`, `cwd`, or `/tmp` directly. Internal Kalebtec paths do not appear in code, comments, tests, or public docs.

## Issue label conventions

We use these label families on issues and PRs:

- `capability::<name>` — points at a capability (`eval`, `fs`, `network-body`, etc.)
- `phase::triage`, `phase::accepted`, `phase::in-progress`
- `severity::critical|high|normal|low`
- `area::core|plugins|docs|keystone`
- `kind::bug|feat|chore|security|proposal`

## Branch naming

Use `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, or `test/<slug>`. Draft PRs are welcome. One maintainer approval is required. Squash-merge is the default.

## Bot allowlist

See `.github/BOT_ALLOWLIST.md` for the bots installed on this repo. New GitHub Apps that require write access require owner approval and a rationale entry in `SECURITY.md`.
