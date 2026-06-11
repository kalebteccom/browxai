# Code quality standards

The bar every plan, review, and implementation must aim for. **Elegance and pragmatism over speed and convenience.** Worth a small delay in implementation time to leave the codebase better than it was found.

## Global quality gate

Every repository change — feature, fix, refactor, hotfix — must leave the global gate clean. Clean means all of the following exit 0:

```
pnpm typecheck
pnpm test
pnpm test:keystone
pnpm lint
pnpm format:check
pnpm build
```

CI runs the same gate (see `.github/workflows/`). Pushing a diff that the local gate would reject is a self-inflicted CI failure. The Phase-15 zero-ignores discipline (no `// @ts-ignore`, no `eslint-disable` without justified comment) applies on top of this gate.

If a residual issue remains (e.g. an external dependency emits a warning you can't suppress), document the owner and reason in the PR — don't leave unexplained global debt.

## Commit subject contract

- Conventional Commit subjects: `type(scope): subject` or `type: subject`.
- Allowed types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.
- Single-line, **≤72 characters**, no body, no AI-attribution trailers.
- Hooks enforce this on visible `git commit -m` / `--message=` invocations.
- Use `--no-edit` only when amending or rebasing a commit whose existing subject already satisfies the contract.

Rationale: terse, scannable git log; AI trailer noise dilutes attribution; ticket / round / plan references rot — state the why in the PR description or in `docs/ai-context/`, not the commit body.

## Improve existing code

When a change touches existing code, look for cleaner abstractions, dead code removal, better naming, fixing inconsistencies. Small, scoped refactors directly adjacent to the work belong in the **same** PR. Large refactors deserve a dedicated PR.

A plan that only adds new code on top of a messy foundation is a bad plan.

## Call out bad patterns

When you encounter anti-patterns, tech debt, or suboptimal approaches in existing code while reviewing, **explicitly call them out** in your feedback and reference the relevant area's `docs/ai-context/` discipline.

**Always suggest an alternative** — don't just flag the problem. Describe the better approach and why it's better.

## Prefer elegant solutions

Choose the simplest correct solution. Avoid over-engineering **and** avoid lazy shortcuts that create tech debt. When multiple valid approaches exist, present the alternatives with trade-offs and recommend one. If implementing a feature the right way takes slightly longer but produces meaningfully better code, **always prefer the right way** and note the trade-off.

## Verify, don't assume

Read the actual file before naming APIs, imports, config keys, generated fields, schemas, or deployment behavior. Plan snippets, memory, and old review notes can be stale. Hallucinated APIs / paths / signatures are a recurring failure mode — verifying takes seconds; debugging a hallucinated reference takes hours.

## Comments discipline

Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader.

- Don't explain WHAT the code does — well-named identifiers do that.
- Don't reference the current task / fix / callers ("used by X", "added for the Y flow", "handles the case from PR #123") — that belongs in the PR description.
- **No internal tracking identifiers in code or comments.** Ticket / plan / round / PR refs (`W-X#`, `Round-N`, `ask #N`, `TICKET-N`, `JIRA-N`, `#1234`, `ROLLBACK-SAFETY-PLAN`, `Security-RECOMMENDED-1`, etc.) are project-management artifacts, not code context — they rot, mean nothing to a future reader, and belong in the commit/PR body. State the actual reason instead: write _why_ the code is the way it is, not _which ticket asked for it_. Example: `// Kept as a zombie for safe rollback; remove in a follow-up cleanup` — not `// Kept per ROLLBACK-SAFETY-PLAN Rule 1`.
- **Exception — load-bearing identifier schemes** like `INV-N` invariant tags whose literal text the test discovers. browxai has none today; the rule shape is documented for future-proofing.

A PR-time `tracker-id-auditor` agent (see `.agents/skills/tracker-id-auditor.md`) regex-scans diffs as a backup to the ESLint custom rule.

## Documentation and public-surface hygiene

The "no internal tracking identifiers" rule is not limited to code comments. It applies to every surface a **user or a calling agent** reads: the published docs (`docs/*.md` that ship to browxai.com), the tool descriptions and capability warnings in `src/` that reach the MCP client, the README, and CHANGELOG entries.

The reader cares what a tool does **today**, not how it got there. Strip the provenance:

- **Roadmap phase tags** — `(Phase 8)`, `Phase-2.5`, `Pre-Phase-7`. Describe current behavior, not the internal phase that shipped it.
- **Wishlist / tracker IDs** — `(Wishlist W-D3.)`, `_(W-F4)_`, `W-H5`. Provenance for the team, noise to a user.
- **Decision history** — "revised down from ~1 month by owner decision 2026-05-20", "baseline cut 2026-05-19", "every adoption round reset the clock". The current rule is the documentation; how it was reached is git history.
- **Dead-feature and futures callouts** — "(deferred)", "(queued as a future cycle)", "(Tracked: … — see feedback_X)", or describing a removed feature. If it does not ship, do not mention it; if it is planned, it does not belong in the reference for what ships.
- **Memory / internal-doc pointers** — `see feedback_chrome_child_dies_with_server`. State the fact inline or link a public doc; never expose an internal memory slug.

Write the fact, not the provenance: "Capability `eval` is off by default", not "the `eval` capability (Phase 2, W-L3, revised by owner decision …) is off by default". Cross-references to other **public** docs (`see docs/threat-model.md`) are reader-useful navigation, not internal tracking, and are fine.

Internal working docs under `docs/ai-context/` and `docs/rfcs/` are exempt — phase and decision history are legitimate context there. The line is simple: **anything a user or calling agent can read must be clean.**

## No half-finished implementations

- Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Validate at system boundaries (user input, external APIs, MCP wire, Playwright/CDP edge).
- Don't add features, refactor, or introduce abstractions beyond what the task requires. Three similar lines is better than a premature abstraction.
- Don't use feature flags or backwards-compatibility shims when you can change the code. Avoid `// removed`, `// kept for compat`, `_var` re-exports.

## SOLID, applied to modern TypeScript

browxai's architecture leans on SOLID with TypeScript-idiomatic interpretations. Concrete examples from the codebase:

### Single responsibility — one tool, one file

- Per-tool handler files: `src/page/click.ts`, `src/page/dom-export.ts`, `src/page/archive.ts`, etc. One tool = one file. Pages-side function + handler wrapper + types live together.
- Capability gating is separated from tool logic: `src/util/capabilities.ts` owns the gate; the handler owns dispatch. A tool handler MUST NOT inline its own capability check beyond calling the shared gate.
- `src/server.ts` is **registry composition only** — no business logic. It wires the tool registry, composes gates, and exposes the MCP surface.

### Open–closed — extend without modifying

- Phase-10's `perf_audit` pluggable analyser registry is the canonical example: new categories (LCP, CLS, layout-thrash, memory) attach to an internal registry; the public `perf_audit` surface is unchanged. New analysers add by extending the registry, not by editing `perf_audit`'s handler.
- Phase-8's plugin runtime is substrate-level OCP: an external package adds tools via `register(api)` without any change to the browxai core.

### Liskov — substitutable contracts

- Page-side function signatures are uniform across every tool that runs JS in the page: `(arg: SerializableInput) => SerializableResult`. The dom_export / element_export bug was an LSP violation — a "function" that didn't honor the contract (a stringified arrow expression that evaluated to a function value, not a function call). See [`../page-side-functions/dom-export-trap.md`](../page-side-functions/dom-export-trap.md).
- ActionResult is the universal return shape for every action tool. A handler that returns a partial / non-conforming shape is an LSP violation that breaks downstream agent loops.

### Interface segregation — narrow contracts, optional fields

- `ElementProbe` carries optional fields per probe-kind rather than one fat interface. A handler asks for what it needs; nothing else is paid for.
- `BrowxaiClientWithPlugins<Schema>` extends a narrow `BrowxaiClient` base via the SDK type-gen seam — adopters who don't use plugins never see the plugin surface.
- Plugin manifests declare narrow per-tool schemas, not god-tools that dispatch on an inner `op` parameter. (`canvas_query({adapter, op, args})` is a deliberate exception at the canvas-substrate layer, not a pattern to copy elsewhere.)

### Dependency inversion — depend on the abstraction

- Server handlers depend on abstract `Page` / `BrowserContext` (Playwright types), not concrete browser implementations. Swapping CDP backends doesn't change handler code.
- The SDK depends on a `Transport` abstraction, not WebSocket / stdio specifics. The three transports (in-process, stdio-child, socket-attached) all conform.
- The plugin runtime's `PluginApi` interface is dependency-inverted by design — plugins call `api.callTool(...)` and `api.registerTool(...)`, never reach into browxai internals.

## Workspace plugin discipline

Adding a new `packages/plugins/<name>/` follows the contract in `docs/plugin-authoring.md`. The discipline that makes the plugin model trustworthy:

- **The substrate team MUST NOT reach into substrate to fix plugin-app-side breakage.** If a Figma update breaks the figma plugin, the fix stays in the plugin. The substrate's job is to keep the plugin runtime contract stable; the plugin's job is to track its host app.
- A new plugin: package.json with browxai manifest, `schema.d.ts`, `src/index.ts` with `register(api)`, README, LICENSE, tests, CHANGELOG row in the host changelog.

## Related

- [`commit-discipline.md`](commit-discipline.md)
- [`dist-rebuild-discipline.md`](dist-rebuild-discipline.md)
- [`docs-impact.md`](docs-impact.md)
- [`../testing/qa-patterns.md`](../testing/qa-patterns.md)
- [`../page-side-functions/dom-export-trap.md`](../page-side-functions/dom-export-trap.md)
