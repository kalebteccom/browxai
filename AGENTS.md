# browxai — agent operating guide

Authoritative, agent-agnostic working rules for this repository. Every harness loads this file (Claude Code via `CLAUDE.md`, Cursor via `.cursor/rules/00-substrate.mdc`, Codex via `.codex/config.toml`, and any AGENTS.md-conformant harness directly). **Per-harness pointers reference this file; they never duplicate its content.** When a rule changes here, every harness picks it up on the next session — no per-harness edits required.

## Substrate at a glance

browxai is an MCP-native, model-agnostic, agentic-first browser-control server on Playwright/CDP. It owns the full Playwright/CDP transport — managed profiles, attach-to-existing-Chrome (BYOB), authenticated sessions, headed and headless — and exposes a **curated** agent-first tool surface, not raw Playwright. Single npm package with a workspace plugins layer (`packages/plugins/*`); the public site is published from `docs/`.

## Operating rules

- **Commits.** Single-line conventional-commit subjects (`type(scope): subject` or `type: subject`), **≤72 characters**, no body, **no AI-attribution trailers**. The repo's `.claude/hooks/block-*.sh` enforces this on visible `git commit -m` invocations. Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.
- **Package manager.** Use `pnpm` (≥9). Never `npm` or `yarn`. The repo declares `packageManager: "pnpm@9.0.0"` via Corepack.
- **Filenames.** kebab-case for all new files and directories.
- **Preserve user work.** Never run `git reset`, `git checkout <path>`, `git clean`, or `git revert` without explicit user request. If a working tree looks broken, surface it — don't sweep it.
- **Search with `rg`.** Prefer `rg` / `rg --files` over `grep` / `find` for searching.
- **Code is the source of truth.** Before naming an API, import, schema field, config key, or generated type — read the file. Plan snippets, memory, and old review notes can be stale. Hallucinated APIs are a recurring failure mode.
- **No internal tracker IDs in source or comments.** Ticket / plan / round / PR refs (`W-X#`, `Round-N`, `ask #N`, `TICKET-N`, `JIRA-N`, `#1234`) are project-management artifacts, not code context — they rot, mean nothing to a future reader, and belong in the commit/PR body. State the actual reason instead: write _why_ the code is the way it is, not _which ticket asked for it_. Exception: load-bearing identifier schemes tied to enforcing tests (e.g. `INV-N`-style invariant tags). browxai has none today; the rule shape is documented for future-proofing.

## Commands the agent must not run

Agents reading this file must not invoke the commands below unless the operator explicitly authorizes the specific invocation in the same session.

| Pattern                                                             | Decision       | Why                                                                                                                                |
| ------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm publish`, `npm publish`                                       | forbidden      | Releases go through OIDC trusted publishing in `release.yml`. No human or agent runs publish locally.                              |
| `npm install -g <anything>`                                         | prompt         | Global installs are a typosquat vector and route around the project lockfile.                                                      |
| `git push --force` (and `--force-with-lease` to protected branches) | forbidden      | Branch ruleset rejects this server-side; the agent layer is defense-in-depth.                                                      |
| `pnpm install-browser`                                              | explicit allow | Documented Playwright/Chromium fetch — the legit exception to `--ignore-scripts`. Must not be blocked by any blanket install rule. |
| `gh pr merge --admin`                                               | forbidden      | Bypasses branch protection and CODEOWNERS review.                                                                                  |
| `curl <url> \| bash`, `wget <url> \| bash`                          | forbidden      | Unverified pipe-to-shell is the Codecov-2021 class. Fetch + SHA-256 verify instead.                                                |
| `git reset --hard`                                                  | forbidden      | Never discard local work. Use a targeted revert if asked.                                                                          |
| `git checkout -- <path>`                                            | forbidden      | Never overwrite local files with checkout.                                                                                         |
| `git clean`                                                         | prompt         | Deletes untracked work; needs explicit operator review.                                                                            |
| `rm -rf`                                                            | prompt         | Recursive deletion needs explicit operator review.                                                                                 |

Enforcement is idiomatic per harness: hard-blocks in [`.codex/rules/default.rules`](.codex/rules/default.rules) (Codex DSL) and [`.claude/hooks/block-forbidden-commands.sh`](.claude/hooks/block-forbidden-commands.sh) (Claude `PreToolUse`); advisory in [`.cursor/rules/01-forbidden-commands.mdc`](.cursor/rules/01-forbidden-commands.mdc) (Cursor has no hook system — the model is expected to respect the rule).

## Repo map

- `src/cli.ts`, `src/cli/` — the `browxai` bin and subcommands.
- `src/server.ts` — MCP server, tool registry composition, capability gates wired in here.
- `src/page/` — per-tool handlers and page-side functions (`actions.ts`, `dom-export.ts`, `bbox.ts`, `compose.ts`, `archive.ts`, `coverage.ts`, …). One tool = one file. Page-side functions run inside the browser context.
- `src/session/` — session lifecycle, managed profiles, BYOB attach, persistent vs. incognito modes.
- `src/util/` — capability gate (`capabilities.ts`), workspace path resolution (`workspace.ts`), secrets masking (`secrets.ts`), config store, deadlines, url sanitizer, no-trace contract.
- `src/plugin/` — plugin runtime (loader, namespace registry, dependsOn resolver, capability composition).
- `src/sdk/` — typed SDK surface (in-process, stdio-child, socket-attached transports).
- `src/helper/` — shared internals for handlers.
- `src/policy/` — origin allow/blocklist, confirmation hooks, capability lattice.
- `harness/` — `driving-browxai/SKILL.md` (portable "drive browxai well" agent skill) + per-harness adapters (`adapters/claude-code/`, `adapters/codex/`, `adapters/pi/`).
- `packages/plugins/{example, figma, tldraw, excalidraw}/` — workspace plugins demonstrating the v0.7 plugin contract.
- `docs/` — public adopter contract (tool-reference, threat-model, plugin-authoring, plugins, sdk, getting-started, byo-vision, capabilities), published via the Astro + Starlight site in `website/` (Netlify).
- `docs/ai-context/` — agent-facing routing layer. Discipline, architecture notes, lessons captured. **Never published to the docs site.** Read before touching the corresponding area.
- `docs/rfcs/` — numbered design RFCs.
- `test/` — keystone tests (real Chromium) and investigation tests.
- `dist/` — build output; the `browxai` bin is `dist/cli.js`. Built by `pnpm build`.

## Capability posture map

Safe by default — no auto-broadening. Every off-by-default capability has a per-tool keystone test asserting the gate blocks when the capability is not granted.

| State           | Capability         | Notes                                                                                        |
| --------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| ON by default   | `read`             | snapshot, find, text_search, inspect, console_read, network_read (metadata only), screenshot |
| ON by default   | `navigation`       | navigate, go_back, go_forward, reload                                                        |
| ON by default   | `action`           | click, fill, select, drag, scroll, hover, press, wait_for                                    |
| ON by default   | `human`            | confirmation hooks, await_human                                                              |
| OFF + loud-warn | `eval`             | `eval_js`, `poll_eval` — arbitrary JS in page context                                        |
| OFF + loud-warn | `network-body`     | full response bodies + interception                                                          |
| OFF + loud-warn | `byob-attach`      | attach to user's existing Chrome (no managed profile)                                        |
| OFF + loud-warn | `clipboard`        | OS clipboard read/write                                                                      |
| OFF + loud-warn | `file-io`          | `upload_file`, downloads to workspace                                                        |
| OFF + loud-warn | `secrets`          | `register_secret`, secret materialization at egress                                          |
| OFF + loud-warn | `extensions`       | install/inspect Chrome extensions                                                            |
| OFF + loud-warn | `stealth`          | anti-fingerprint posture tweaks                                                              |
| OFF + loud-warn | `captcha`          | captcha solver glue                                                                          |
| OFF + loud-warn | `device-emulation` | viewport / UA / geolocation overrides beyond defaults                                        |
| OFF + loud-warn | `diagnostics`      | recorder, perf_audit, coverage, layout_thrash_trace, memory_diff                             |
| OFF + loud-warn | `canvas`           | canvas-app eval routing (figma / tldraw / excalidraw plugins)                                |

Per-capability rationale, ActionResult shape, and threat-model rows live in [`docs/threat-model.md`](docs/threat-model.md) and [`docs/ai-context/architecture/capability-posture-map.md`](docs/ai-context/architecture/capability-posture-map.md).

## Stable surface + semver

`docs/tool-reference.md` "Stability & semver" is the canonical statement. Frozen surface today: tool names, documented input/output shapes, `ActionResult` shape, default capability set. Anything behind an off-by-default capability is explicitly experimental and not covered.

- A change to the stable surface resets the "API stable ~1 week" clock. Capability-gated or behaviour-only changes do not.
- Config-input deprecation is graceful via the `RETIRED_*` registry pattern (canonical implementation: `RETIRED_CAPABILITIES` in `src/util/capabilities.ts`). The parser accepts the retired value, ignores it, and emits a non-fatal deprecation warning that says what to do instead. Genuine typos still error loudly. Full removal only at a major version bump with a CHANGELOG entry. See [`docs/ai-context/release-process/retired-registry-pattern.md`](docs/ai-context/release-process/retired-registry-pattern.md).

## Build + run discipline — the dist-rebuild trap

The MCP server runs the compiled `dist/cli.js`. **Source changes are NOT live until `pnpm build`.** A stale `dist/` that predates a config-parser change can crash the server at MCP handshake.

- After any source change, rebuild `dist/`.
- A running Claude Code / Codex / Pi session holds the daemon process in memory — Node's `import()` is one-shot at boot. Any `dist/` rebuild after the daemon started means the running daemon is executing stale code. **Restart the daemon and surface the new PID explicitly to the operator** before declaring the change verified.
- Before pushing: `pnpm typecheck && pnpm test && pnpm test:keystone && pnpm lint && pnpm format:check && pnpm build` — all exit 0. CI runs the same gate.

See [`docs/ai-context/agent-process/dist-rebuild-discipline.md`](docs/ai-context/agent-process/dist-rebuild-discipline.md).

## Page-side function pattern

Server-owned, fixed in-page functions only — agent-supplied JS is gated behind `eval_js` capability and never the default path. A page-side function MUST be a **real TypeScript function literal** with `/// <reference lib="dom" />` at the file head, NOT a stringified arrow expression.

The dom*export / element_export bug class is the root-cause lesson: a stringified arrow expression evaluates to a function \_value*, CDP cannot serialize functions across the boundary, and the return becomes `undefined`. Keystone tests against real Chromium are the regression gate. Unit tests with a mocked `locator.evaluate` silently pass when the page-side code is broken.

Do not loosen the keystone gate. See [`docs/ai-context/page-side-functions/dom-export-trap.md`](docs/ai-context/page-side-functions/dom-export-trap.md).

## Tool registration

Adding a new MCP tool:

1. Gate definition — Zod schema for input + output in the tool handler file.
2. Capability map entry — declare which capability gates the tool, default ON or OFF.
3. Handler implementation — under `src/page/<tool>.ts` (page-touching) or `src/session/` (session-scope). Returns an `ActionResult`.
4. Registry — register in `src/server.ts` via the existing `register()` composition.
5. Threat-model row — `docs/threat-model.md`.
6. Keystone test — real Chromium, asserting both success and capability-blocked paths.
7. Tool reference — `docs/tool-reference.md` row.
8. CHANGELOG entry — `## Unreleased ### Added`.

See [`docs/ai-context/tool-registration/server-tool-registry.md`](docs/ai-context/tool-registration/server-tool-registry.md).

## Workspace + paths

All file IO is `$BROWX_WORKSPACE`-rooted, never `cwd`. The chokepoint is `resolveWorkspacePath` in `src/util/workspace.ts`. The no-trace contract (recorded session artifacts leave no trace outside the workspace) is enforced by tests in `src/util/no-trace.test.ts`. Any new code path that touches the filesystem MUST go through `resolveWorkspacePath`.

## Worktree conventions

Parallel agents that modify the same working tree collide. Dispatch multi-agent work into git worktrees under `.claude/worktrees/` (or `<repo-parent>/<repo>-worktrees/<phase>/`). One agent = one worktree = one branch. Sibling agents declare ownership boundaries up front to avoid file conflicts at merge.

## Documentation contracts

Three doc surfaces with distinct contracts:

- **`docs/`** — public adopter contract. Published to browxai.com by Netlify via the Astro + Starlight site in `website/` (which syncs an allowlisted set of `docs/*.md` at build time). Every public behavior change updates `docs/tool-reference.md`, `docs/threat-model.md`, `docs/plugin-authoring.md`, `docs/plugins.md`, etc.
- **`docs/ai-context/`** — agent-facing routing layer. Discipline + architecture notes + lessons. **NOT published.** Read before touching the relevant area. Subtree IA: `agent-process/`, `architecture/`, `tool-registration/`, `page-side-functions/`, `recorder-and-replay/`, `plugin-runtime/`, `secrets-and-egress/`, `testing/`, `release-process/`, `adopter-reports/`, `investigations/`.
- **Colocated `README.md`** — per-package and per-subdirectory internal contracts (e.g. `packages/plugins/<name>/README.md`).

Every behavior-change diff includes a docs-impact pass: update `docs/tool-reference.md`, the relevant `docs/threat-model.md` row, the relevant capability table, AGENTS.md if a rule changed, and CHANGELOG. See [`docs/ai-context/agent-process/docs-impact.md`](docs/ai-context/agent-process/docs-impact.md).

## Adopter-feedback loop

Adopter reports become surface changes through this lane:

1. Report lands as `docs/ai-context/adopter-reports/<YYYY-MM-DD>-<slug>.md`.
2. Triage: each ask gets a verdict (in v0.x surface / behind capability / RFC / declined).
3. Capability lane: anything posture-broadening goes off-by-default with a capability gate.
4. Keystone coverage: a regression test in `test/` against real Chromium.
5. CHANGELOG entry + `docs/tool-reference.md` row.
6. The originating adopter report's "durable lessons captured" section points at the resulting CHANGELOG entry or roadmap item.

Current reports: see [`docs/ai-context/adopter-reports/`](docs/ai-context/adopter-reports/).

## Multi-harness auto-discovery

`AGENTS.md` is the single source of truth. Per-harness pointer files reference this file and never duplicate content:

- **Claude Code:** `CLAUDE.md` at repo root — three-line pointer to `AGENTS.md`. Claude-Code-specific addenda (hooks, Skills) live under `.claude/`.
- **Cursor:** `.cursor/rules/00-substrate.mdc` — MDC frontmatter with `alwaysApply: true`, body `@AGENTS.md`.
- **Codex:** `.codex/config.toml` references `AGENTS.md` as the canonical rules file. Expert agent definitions live in `.codex/agents/`.
- **AGENTS.md-conformant harnesses** (future): load `AGENTS.md` directly. No further config needed.
- **Shared skills:** `.agents/skills/` holds per-domain skill definitions reusable across every harness adapter.

Adding a new harness: place a pointer file in the harness's discovery location, reference `AGENTS.md`. Do not copy rules.

## Expert agents

Repository-bundled expert agent definitions live in three mirrored locations:

- `.claude/agents/<name>.md` — Claude Code subagent registry.
- `.codex/agents/<name>.md` — Codex agent registry (format under iteration; see directory README).
- `.agents/skills/<name>.md` — cross-harness source of truth for non-harness-specific role logic.

Current agents: `tool-author`, `plugin-author`, `keystone-writer`, `capability-gate-auditor`, `security-reviewer`, `docs-impact-auditor`, `release-engineer`, `tracker-id-auditor`.

## Quality gate contract

All of the following must exit 0 on a clean branch:

```
pnpm typecheck
pnpm test
pnpm test:keystone
pnpm lint
pnpm format:check
pnpm build
```

Every behavior-change diff verifies this gate locally before pushing — never push and hope CI catches it. CI runs the same gate; a CI failure on push is a self-inflicted wound.

## Related

- [`SECURITY.md`](SECURITY.md) — vulnerability reporting + threat model summary.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor workflow + DCO/CLA posture.
- [`RELEASING.md`](RELEASING.md) — release ritual.
- [`docs/ai-context/README.md`](docs/ai-context/README.md) — agent-facing routing layer index.
