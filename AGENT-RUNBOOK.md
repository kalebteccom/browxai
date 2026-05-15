# Agent runbook — browxai Phase 1

> Hand this doc to an MCP-capable coding agent (Claude Code, Codex, anything that drives the
> filesystem + a shell + git). It explains what Phase 1 ships, the work that gates it, the
> rules that constrain it, and what "done" looks like.
>
> **You are the agent.** This document addresses you in the second person.
>
> Repo: `kalebteccom/browxai` (private; MIT; will go public per the spec's 4-condition
> trigger in Phase 3). Canonical design lives in the portfolio repo `kalebteccom/project-ideas`
> → `projects/agent-browser-bridge/` (`spec.md`, `roadmap.md`, `progress.md`). When this
> repo's docs conflict with the portfolio, the portfolio wins — and you should fix the
> conflict in *both*.

## What Phase 1 ships, in one paragraph

A standalone MCP server (`browxai`, stdio transport) built on `playwright-core` + CDP that
exposes a curated, agentic-first, token-efficient browser-control surface — `snapshot`,
`find`, the `ActionResult` action primitives, `screenshot`, `consoleRead`, `networkRead`,
and `awaitHuman` — and that **site-docs's discovery/calibration drives end-to-end on a real
authed target** in place of Claude-in-Chrome. That adoption run *is* the real evaluation;
there's no separate A/B (the original Phase-0 spike was demoted 2026-05-13 and deleted once
the canonical server reached parity).

## The no-trace consumer-repo contract (read this first)

browxai is designed to be **invoked from inside any other repo without leaving traces in
it**. Concretely:

- The browxai *implementation* lives at its own checkout (referred to below as `<browxai>`).
- All **transient state** — the managed-profile Chromium dir, captured `storageState`,
  logs, screenshots, helper artefacts — lives in a **`BROWX_WORKSPACE` directory outside
  any consumer repo**, default `~/.browxai/`.
- A consumer repo (for site-docs: a per-app workspace alongside the app repo; never the
  app repo itself) is **never** written to by browxai. After a session, `git status` in any
  consumer / target repo is clean. This is also a Phase-1 *exit criterion* in the
  roadmap — verify it.

Two MCP-client configuration patterns satisfy this — pick one. **Never** drop a `.mcp.json`
inside a consumer repo just because that's where your editor is open.

- **(A)** User-scope MCP registration in `~/.claude.json`'s `mcpServers` — available from
  any project session; nothing touches the consumer repo.
- **(B)** A workspace-scope `.mcp.json` *inside the `BROWX_WORKSPACE` dir* (outside any
  consumer repo); open your Claude Code session against that workspace dir, not against the
  consumer repo.

Either way, the **`cwd` of the spawned MCP server is the browxai repo** (so pnpm finds the
deps), but the **`BROWX_WORKSPACE` env points at the workspace dir or `~/.browxai/`**, where
all transient state goes. The consumer repo is never in either path.

### Dual-registration recipe (managed + BYOB) — Pattern (A) in practice

Until ask #9 lands a sensible default ("auto-attach when `127.0.0.1:9222` is reachable"),
the simplest setup is **two user-scope MCP entries**, one for each session-lifecycle mode:

```bash
# managed (default — browxai launches its own Chromium at $BROWX_WORKSPACE/profile/)
JSON='{"command":"node","args":["/path/to/browxai/dist/cli.js"],"env":{"BROWX_WORKSPACE":"/Users/<you>/.browxai"}}'
claude mcp add-json -s user browxai "$JSON"

# attached (BYOB — attaches to an externally-launched Chrome on loopback:9222)
JSON='{"command":"node","args":["/path/to/browxai/dist/cli.js"],"env":{"BROWX_WORKSPACE":"/Users/<you>/.browxai","BROWX_ATTACH_CDP":"http://127.0.0.1:9222"}}'
claude mcp add-json -s user browxai-attached "$JSON"
```

Use `browxai` for ad-hoc / first-time / public-target work. Use `browxai-attached` when
the runbook tells you to (e.g. site-docs's `capture-auth --cdp` has already launched the
auth-bearing Chrome on `:9222`); the attached browser is treated as not-owned and survives
the session.

## What's shipped (Phase 1 + Phase 1.5 done as of 2026-05-13)

Full status board: `docs/first-consumer-asks.md`. Canonical write-up of each ask: the
site-docs-side `automated-site-documentation-bot/docs/browxai-asks.md` (#1–#6) and the
adoption-run report at `docs/adoption-report-2026-05-13.md` (#7–#11).

**Phase 1 (from the pre-shipping site-docs asks):**

1. 🔴 **CDP-attach via `BROWX_ATTACH_CDP=<loopback-endpoint>` — done.** Attached browser is
   not-owned (detach-only on shutdown; no `browser.close()` / storage reset). Loopback only
   (refuses non-`127.0.0.1` hosts). Startup log: `attached=<endpoint> owner=external`.
2. 🔴 **Stable canonical entrypoint `browxai` — done.** `pnpm browxai` script + `browxai`
   npm bin → `dist/cli.js`. No `BROWX_SPIKE_*` env vars on this path. Spike deleted.
3. 🔴 **`storageState` handoff — done (in the falls-out-of-#1 shape).** When browxai is
   attached, the consumer reads `storageState()` off the same Chrome with no extra MCP tool.
4. 🟡 **`find().selectorHint` preference order + `stability` flag — done for tiers 1, 2, 5.**
   Tier 1 is **any configured `BROWX_TEST_ATTRIBUTES`** (default `data-testid, data-test,
   data-cy, data-qa` — see below). Tiers 3–4 (stable-text-on-stable-role, id/semantic) are
   Phase-1.5 polish; agents that need them should fall back to a raw `selector:` for now.
5. 🟡 **Visible-rect bbox in `find()` evidence — done.** `getBoundingClientRect()` ∩ each
   `overflow !== visible` ancestor ∩ viewport; `bbox: null` + `clipped: true` when fully
   clipped. Matches site-docs's runtime bbox.
6. 🟢 **Workspace co-location — done.** `BROWX_WORKSPACE` accepts any absolute path; nest
   it under a consumer's workspace if useful.

**Phase 1.5 (from the 2026-05-13 target-app adoption-run report):**

7. 🔴 **`snapshot()` DOM-walk fallback — done.** The a11y tree alone is sparse on
   heavy-SPA targets (Reflux/legacy-React shapes). browxai now runs a DOM walk on every
   snapshot, picking up interactive elements via `[role], button, a[href], input, select,
   textarea, [onclick], [tabindex], [contenteditable]` **plus** any element bearing a
   configured test attribute. Results merge into the a11y tree under the same root with
   `[from-dom]` / `[from-both]` source markers — refs use the existing stable-key scheme
   so the same node gets the same `eN` across both sources.
8. 🔴 **Data-attribute projection + `BROWX_TEST_ATTRIBUTES` — done.** Add your codebase's
   test-attribute convention to the env var (comma-separated, order-sensitive, first match
   wins): `BROWX_TEST_ATTRIBUTES=data-testid,data-type,data-test,data-cy,data-qa`. Flows
   through a11y enrichment, DOM walk, `selectorHint`, and locator resolution.
9. 🟡 **Auto-default `BROWX_ATTACH_CDP` — workaround live**, full auto-default deferred.
   Use the **dual-registration recipe** above: `browxai` for managed mode, `browxai-attached`
   for BYOB. When site-docs's `capture-auth --cdp http://localhost:9222` Chrome is running,
   pick `browxai-attached`.
10. 🟡 **`selectorHint` tier-1 doesn't gate on a role wrapper — done.** A `<div data-type="x">`
    on a heavy SPA gets `stability: "high"` directly. The emitted hint uses the matched
    attribute name (e.g. `[data-type="x"]`), not hardcoded `[data-testid="x"]`.
11. 🟢 **Low-content snapshot warning — done.** When the a11y tree has fewer than 5
    interactive descendants under root, `snapshot()` emits a `warnings:` block in its header
    explaining the source mix and pointing at the DOM-walk supplement.

## Still open (deferred Phase-1.5 polish)

These don't block adoption — they're polish that will close out Phase 1.5 cleanly.

- `snapshotDelta.scope` — currently returns the full tree; the actual scope-down (just the
  changed region + appeared regions) is pending.
- `mode: "tree_diff"` — falls back to `scoped_snapshot` with a warning. Wire-compat with
  Vercel `agent-browser`'s diff text format is undecided (see `docs/divergence-notes.md`).
- `await_human` `kind`s beyond `"acknowledge"` — `confirm` / `choose` / `input` /
  `pick_element` + the shadow-DOM banner UI.
- `network_read` as a session-wide buffered stream — per-action attribution via
  `ActionResult.network` is the primary surface.
- `selectorHint` tiers 3 (stable-text-on-stable-role) and 4 (id/semantic).
- Auto-default `BROWX_ATTACH_CDP` / `browxai doctor` (real auto-detection; the dual MCP
  registration is the workaround).
- No-trace CI test that spawns the server with `cwd=/tmp/fake-consumer-repo` and asserts
  the cwd is untouched.

## Adopter quick reference

**Reading a snapshot:** the header shows `url:`, `title:`, `stats:` (with
`a11yInteractive`, `domWalkEntries`, `domWalkNew`, `domWalkCombined`), and a `warnings:`
block if the a11y tree was low-content. Body lines look like:

```
role "name" [ref=eN] [<test-attr>="…"] [from-dom|from-both] [state]
```

If you see `[from-dom]` markers it means the node was found by the DOM walk only — that's
expected on heavy SPAs and you can act on those refs normally. `[from-both]` means both
the a11y tree and the DOM walk found the same element (a good sign).

**Configuring for a codebase with non-standard test attrs:** edit the MCP env block to
add your convention. For example, a codebase that uses `data-type` as a tier-1 anchor:

```jsonc
{
  "command": "node",
  "args": ["/path/to/browxai/dist/cli.js"],
  "env": {
    "BROWX_WORKSPACE": "/path/to/workspace",
    "BROWX_TEST_ATTRIBUTES": "data-testid,data-type,data-test,data-cy,data-qa"
  }
}
```

The order is meaningful — first match on a node wins. Put the most-trusted convention
first.

**When to use `find()` vs raw `selector:`:** prefer `find()` first (it returns ranked
candidates with refs you can pass back, evidence, and visible-rect bbox). Fall back to a
raw `selector:` only when `find()` returns nothing useful (e.g. when the agent already
knows the exact Playwright locator from a flow file).

**See the canonical tool reference at `docs/tool-reference.md`.**

The full Phase-1 design (module layout, exact `ActionResult` JSON shape, ref scheme, the
`window.__browx` helper, security non-negotiables, MCP wiring, the no-trace contract) is
in **`docs/phase-1-design.md`**. The site-docs lifecycle code that was ported (~600–700 LOC
across `playwright-instrumented-browser.ts` / `playwright-driver.ts` / `auth.ts`) is
inventoried in **`docs/site-docs-lifecycle-port-plan.md`**.

## Where to look

- **`docs/phase-1-design.md`** — the implementer-facing design. Module layout (`src/{session,
  page,helper,util}/…`), the one-serialisation/one-ref-scheme coherence constraint, the
  full `ActionResult` shape, the `__browx` helper + `awaitHuman` over `page.exposeBinding`
  with polling fallback, session lifecycle + the Phase-1 security non-negotiables + the
  no-trace contract, MCP server wiring. Draft — push back here if the asks force a change.
- **`docs/site-docs-lifecycle-port-plan.md`** — what lifts from site-docs (3 launch modes,
  `storageState()` localStorage-merge, `LocalStorageStateCache`, primitive ops) and what
  doesn't (`runFlow`, doc-pack, calibrate, viewer). Includes a first-PR slice (~150–250 LOC):
  managed-launch + `goto`/`screenshot` + a stub `snapshot()` + an `@modelcontextprotocol/sdk`
  stdio server with `navigate`/`snapshot`/`screenshot` tools + a vitest smoke test on
  `example.com`.
- **`docs/divergence-notes.md`** — what to borrow from `@playwright/mcp` (a11y-tree-as-
  snapshot, `--caps`/origin-flag *ideas*) and Vercel `agent-browser` (`tree_diff` mode,
  stable refs across snapshots); six point-by-point divergences with the why.
- **`docs/first-consumer-asks.md`** — status board for the six asks.
- **`spec.md` / `roadmap.md` in the portfolio** — source of truth for *what* and *why*.
- **`automated-site-documentation-bot/docs/browxai-asks.md`** — the canonical ask sheet from
  site-docs (the long form of the six items above).
- **`automated-site-documentation-bot/docs/agent-runbook.md`** — site-docs's own runbook;
  its Step 4 pre-stages the swap "drive `--cdp` Chrome with Playwright directly" →
  "spawn browxai (attached to that same Chrome) and drive it via MCP." Worth reading so you
  know what shape the consumer is calling you in.

## Ground rules

- **Stay on TS/Node, ESM, Node ≥20.** `playwright-core` for browser, `@modelcontextprotocol/sdk`
  for MCP. Already in `package.json`.
- **Idiomatic, clean code.** Thin `src/index.ts`, focused modules under `src/{session,page,
  helper,util}/`. Match the surrounding style as the codebase grows; tests alongside
  (`*.test.ts`, vitest). Typecheck + tests on Node 20 / pnpm in CI (already wired).
- **stderr is the only logging channel.** stdout is the MCP wire — anything written there
  corrupts the protocol. Imports of `console.log` in `src/` are bugs.
- **Page content is untrusted.** `snapshot` / `find` / `ActionResult.snapshotDelta` output
  is attacker-controlled. The server does not interpret it; no promptable ranking
  heuristics; the tool descriptions tell the host agent the same. Phase 2 hardens this
  further (capability toggles, allowlist, confirmation hooks); Phase 1 only needs the
  posture and the docs.
- **Two session modes only in Phase 1.** `managed` (default; dedicated profile at
  `$BROWX_WORKSPACE/profile/`; normal Chrome flags; sandbox on) and `byob`
  (`BROWX_ATTACH_CDP=…`; off by default; loud one-time warning; not-owned). The
  ephemeral / per-session managed-profile dir is fine too.
- **No-trace contract verification.** Add a CI test (or at minimum a manual checklist step)
  that spawns the server with `cwd=/tmp/fake-consumer-repo` (an empty git repo) and asserts
  `git -C /tmp/fake-consumer-repo status --porcelain` is empty after exercising the tools.
- **Commits.** Single-line conventional-commit subjects, ≤72 chars, no body, no AI trailer
  (the `.claude/hooks/` guards enforce this — they'll reject you if you try). One logical
  change per commit; push when a commit is logically complete. Don't `git add .` — stage
  explicitly.
- **When the design fights you, fix the design.** If implementing an ask forces a change
  to `docs/phase-1-design.md` or to the portfolio `spec.md` / `roadmap.md`, update *all* of
  them — they have to agree. Mirror the change into the portfolio's `progress.md` per the
  repo's cycle rule.
- **If you get blocked, surface it.** Don't grind for 50 tool-calls on a Playwright timeout
  or a CDP attach failure. Write a `docs/blockers/<topic>.md`, push the branch, summarise
  in the chat so the human can unblock.

## Definition of done — Phase 1

State as of 2026-05-13 — most boxes are now `[x]`. The headline criterion (a re-adoption
run that actually exercises `find()` on a heavy-SPA target post Phase-1.5 fixes) is the
remaining gate. Full list in `projects/agent-browser-bridge/roadmap.md` § Phase 1.

- [~] site-docs's discovery/calibration runs end-to-end through browxai on ≥1 real target
      site, no Claude-in-Chrome in the loop, with a real `httpOnly` session. — *partially
      done*: first adoption ran on the target SPA 2026-05-13 (modest win — orchestration good;
      `find()` blunted by the then-unshipped DOM-walk fallback). Phase-1.5 #7/#8/#10/#11
      shipped same day. **A re-adoption run that exercises `find()` against the augmented
      snapshot closes this.**
- [x] `BROWX_ATTACH_CDP` end-to-end on the canonical entrypoint (no second login required
      when a `--cdp` Chrome is up; see the dual-registration recipe above).
- [x] Canonical `browxai` entrypoint is the documented invocation; spike entrypoint deleted.
- [x] `find().selectorHint` preference order + `stability` flag (tiers 1, 2, 5) + visible-rect
      bbox in `find()` evidence. Tier-1 now honours `BROWX_TEST_ATTRIBUTES` and doesn't gate
      on a role wrapper. Tiers 3–4 are deferred polish; locators transcribe mechanically
      via tier-1 / tier-2 today.
- [x] `snapshot()`, `find()`, `ActionResult`, `screenshot`, `console`/`network` reads,
      `await_human(acknowledge)` all implemented. The adoption run exercises them.
- [x] No-trace contract holds against any consumer repo (`git status` clean). Verified by
      the `BROWX_WORKSPACE` env-var-rooted output paths; unit tests for the resolver. CI
      test that spawns with `cwd=/tmp/fake-consumer-repo` is deferred polish.
- [x] Tool reference docs exist (`docs/tool-reference.md`).

When the re-adoption run is green, sync back to the portfolio (`progress.md` + roadmap
status + portfolio table), open the `/gpd:advance-stage` conversation, and we move into
Phase 2 (the security hardening / non-site-docs-consumer phase).

## When the human asks "is browxai ready to use?"

It is once (this is the adopter checklist now — implementer checklist was met 2026-05-13):

- [x] `pnpm install` + `pnpm install-browser` succeeded in the browxai repo.
- [x] `pnpm typecheck` + `pnpm test` pass.
- [x] `pnpm build` produced `dist/cli.js` (executable, shebang preserved).
- [ ] You've registered browxai with your MCP client per the recipe above (either user-scope
      `~/.claude.json` or workspace-scope `.mcp.json` outside any consumer repo). Restarted
      Claude Code (or `/reload-plugins`) so the registration is live.
- [ ] If your consumer codebase has project-conventional test attributes (e.g. `data-type`),
      added them to `BROWX_TEST_ATTRIBUTES` in the env block.
- [ ] You've skimmed `docs/tool-reference.md` so you know what `[from-dom]` / `[from-both]`
      / the `warnings:` block in snapshot output mean.

Then drive your consumer flow. Report findings as a new
`docs/adoption-report-<target>-<date>.md`, mirroring the shape of the 2026-05-13 target-app one
(`What worked` / `What got in the way` / `Concrete asks, in priority order`).
