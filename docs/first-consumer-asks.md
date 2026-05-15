# First-consumer asks (site-docs → browxai)

> Tracks the concrete asks site-docs (browxai's first real consumer) has filed. The **canonical
> integration contract** across both rounds lives in the site-docs repo at `docs/browxai-asks.md`
> (rewritten 2026-05-13 as a two-round contract after the target-app adoption run). This file is the
> **browxai-side status board** and the mapping into our spec/roadmap/design.
>
> Hand-off was logged 2026-05-13 in the portfolio progress for `agent-browser-bridge`.

Status legend: **design** = absorbed into `docs/phase-1-design.md` / spec / roadmap · **impl-pending** = also implemented (or the cheap part is) · **impl-done** = fully shipped · **deferred** = not in current phase.

## Phase-1 asks (pre-shipping, from `automated-site-documentation-bot/docs/browxai-asks.md`)

| # | Severity | Ask (short) | Status | Lives in browxai design at |
|---|---|---|---|---|
| 1 | 🔴 | CDP-attach via `BROWX_ATTACH_CDP` on the canonical server; treat attached Chrome as not-owned. | impl-done (Phase 1) — adoption-run flagged it's **not the default**; see ask #9 | `phase-1-design.md` §5 + §5a |
| 2 | 🔴 | Stable canonical entrypoint: `pnpm browxai` / `browxai` bin (curated surface default; no env-flag tooling required). | impl-done (Phase 1) | `phase-1-design.md` §0 + `package.json` `bin` |
| 3 | 🔴 | `storageState` handoff to site-docs's headless `run`. Phase-1: falls out of #1 (consumer reads it off the attached Chrome via `BrowserContext.storageState()` — no MCP tool needed). Phase-2: optional `dump_storage_state` MCP tool for the managed-mode case. | impl-done (Phase-1 shape; no code needed). 📅 adoption-gated for the re-run · deferred (Phase-2 `dump_storage_state`) | `phase-1-design.md` §5a + roadmap Phase 2 |
| 4 | 🟡 | `find().selectorHint` preference order: `data-testid` > role+name > stable text > stable structural > positional (last resort). Surface `stability: "low"` when only tier-4-or-worse. | impl-done (tiers 1,2,5; tiers 3,4 Phase-1.5) — adoption-run flagged a tier-1 weighting issue, see ask #10 | `phase-1-design.md` §2b |
| 5 | 🟡 | Visible-rect bbox in `find()` / `snapshot()` evidence: intersect with `overflow !== visible` ancestors + viewport; `bbox: null` + `clipped: true` when fully clipped. Matches site-docs's runtime computation. | impl-done (Phase 1) | `phase-1-design.md` §2a |
| 6 | 🟢 | Allow nesting `BROWX_WORKSPACE` under a consumer's workspace (e.g. `$SITE_DOCS_WORKSPACE/.browxai/`). | impl-done (env-var-rooted everywhere) | `phase-1-design.md` §4a |

## Phase-1.5 asks (post-shipping, from the 2026-05-13 target-app adoption-run report)

| # | Severity | Ask (short) | Status |
|---|---|---|---|
| 7 | 🔴 | **Snapshot DOM-walk fallback** when the a11y tree is empty / shallow. The target-app adoption found `snapshot()` returning `RootWebArea [ref=e3]` only (`truncated: false`) on a fully-hydrated SPA. With this, `find()` degrades to tier-5 / `low` on any non-semantically-marked-up app — **blocks the canonical discovery use case**. Minimum shape: walk the DOM in addition to the a11y tree, emit interactive elements (`[role]`, `button`, `[data-testid]`, `[onclick]`, `input`, `[tabindex]`, …) as nodes with `[ref=eN]`; refs still come from the existing stable-key scheme. | **impl-done 2026-05-13** — `src/page/dom-walk.ts` + `compose.ts`; runs every snapshot; merged into the tree with `source: dom|both|a11y` markers; refs share the stable-key scheme; `find()` picks up DOM-walk-only candidates. |
| 8 | 🔴 | **Snapshot `data-attribute` projection** — a `snapshot` mode (or supplementary view) that lists every visible element with `data-testid` / `data-test` / `data-cy` / `data-qa` / project-conventional data-attrs set, treated as tier-1 / stability `high` even when no role wrapper exists. Adoption-run showed this would have legitimately beaten source-code grep on target-app (grep can't tell you which testids are *mounted right now*). | **impl-done 2026-05-13** — same plumbing as #7. Configurable via `BROWX_TEST_ATTRIBUTES` (`src/util/config.ts`); default set + project conventions like `data-type` configurable per-adopter. |
| 9 | 🟡 | **Auto-default `BROWX_ATTACH_CDP` when `localhost:9222` is reachable** (or some `browxai doctor` that prints the missing setup). The user-scope MCP install I shipped doesn't set `BROWX_ATTACH_CDP`, so adopters re-login each session even when the runbook's `--cdp` Chrome is already running. Alternative shape: a tiny per-tool-call `--use-existing-chrome-if-running` flag, or persistent profile by default so the second login is at most one-time. | **workaround live 2026-05-13** — dual user-scope MCP registration (`browxai` + `browxai-attached`) shipped (see runbook). Auto-default / `browxai doctor` still wanted; deferred. |
| 10 | 🟡 | **`selectorHint` tier-1 (`data-testid` / well-known data-attrs / project conventions like `data-type`) must not gate on a role wrapper.** The current tier-1 path requires the a11y enrichment pass to attach a testId to a roled node; on heavy SPAs that path is empty. With ask #7 / #8 landing, ensure tier-1 stays first when the node was found via DOM walk too. | **impl-done 2026-05-13** — `buildSelectorHint` now emits `[<testIdAttr>="…"]` with the matched attribute name; tier-1 fires regardless of role (tested against `role=div` and `role=generic`). |
| 11 | 🟢 | **Surface a "low-content snapshot" warning** when the snapshot tree has fewer than N interactive descendants — adopters currently misread `truncated: false` + one-line root as "the page is empty" rather than "the a11y tree is sparse on this codebase, you may want the DOM-walk fallback." | **impl-done 2026-05-13** — `compose.ts` emits a structured warning when a11y has < 5 interactive descendants, naming the count and the DOM-walk supplementation. |

Also flagged but **not a browxai ask** (consumer-of-browxai problem on the site-docs side): the *path to first `find()` call on a real authed app* is gated by long backend ops (target-app's script + audio generation is 6–15 min). A `site-docs warm "$WORKSPACE" --to <flow>` that parks a hydrated CDP Chrome for browxai to attach to would unblock this on the consumer side; tracked in the site-docs runbook, not here.

## Round-3 asks (post-shipping, from the 2026-05-15 re-adoption-run report)

The re-adoption run (`docs/adoption-report-2026-05-15.md`) **closed the Phase-1 headline exit criterion** — `find()` exercised against the augmented snapshot, one new the feature area flow file calibrated entirely through `browxai-attached`, no-trace contract held, replay determinism intact. The verdict was **WIN**. Five small follow-on asks surfaced — three 🟡 surgical, two 🟢 polish — none architectural.

| # | Severity | Ask (short) | Status |
|---|---|---|---|
| 12 | 🟡 | **Raise `wait_for.timeoutMs` schema cap.** Currently capped at 120 000 ms; backend-async ops on dev-SPA targets routinely exceed that (target-app script generation ≈ 3 min). Adopter had to poll `wait_for` twice. Options: raise to ~600 000 ms (10 min), or add `pollIntervalMs` so the primitive polls internally to a higher cap, or document the polling idiom in `tool-reference.md`. Compare with site-docs's own `timeout_ms` which is unbounded. | Phase-1.5 — schema-only change, no semantic risk |
| 13 | 🟡 | **`selectorHint` disambiguation when the bare hint matches multiple DOM nodes.** When `find()` returns the visible candidate via its snapshot interaction-filter but the emitted `selectorHint` (`[data-type="x"]`) matches multiple DOM nodes (e.g. a visible button + a hidden DOM sibling), mechanical transcription into a flow-file re-introduces the round-6 hidden-duplicate `boundingBox` hang. Fix: when find() detects duplicates, append `:visible` / `:nth-match(..., 1)` / another disambiguator to the hint. The engine already *knows* the bare hint is ambiguous — fold that knowledge into the emitted string. | Phase-1.5 — detect duplicate-selector-singleton-match inside find(); ~20 LOC |
| 14 | 🟡 | **`find()` scoring should weight test-attribute string matches more heavily** — especially for `<input>` / non-button elements. Exact testid in query (`app-common-time-input-seconds`) failed to surface the matching `<input>` because the role+name surface is empty for inputs (no `aria-label`; just a placeholder/value). Options: score testId-value matches independently of role/name; boost when `role == "input"` AND test-attribute value matches a query keyword; emit a `warnings: ["no candidate scored confidently"]` when no top-3 candidate exceeds a score floor so the agent knows to fall through to snapshot. | Phase-1.5 — scoring change in `find()`; needs iterations + tests |
| 15 | 🟢 | **CDP-attached `bbox: null + clipped: true` for plainly-visible elements.** Every `find()` candidate's `bbox` came back null on the BYOB path even for elements visible in the attached Chrome. Runtime-side (managed-mode + site-docs's annotation halo placement) is byte-correct. Likely the attached CDP context has no default viewport; setting one or reading `Page.viewportSize()` and threading through the viewport-intersect step would close the parity. | Phase-1.5 — viewport plumbing in `src/session/byob.ts` |
| 16 | 🟢 | **Docs: `stability` semantics + `find()` query-matching surface.** Two confusion points cost ~1h this round: (a) `stability: "high"` means "disambiguator on this snapshot," not "survives content/test-attr rotation" — an asset-card with `[data-testid="library-asset-container-<id>"]` is high-stability for *this* snapshot but content-keyed for the next. (b) `find()` matches on `name` (accessible name) + `role` + test-attribute *values*; queries like "brain/voice icon" for icon-only tabs without these textual surfaces miss. Either document explicitly in `tool-reference.md`, or surface a `stabilityKind: "structural"|"content-keyed"` on the find result (heuristic: testId looks numeric / UUID-like → content-keyed). | Phase-1.5 — docs-only or tiny shape addition |

## Forward-looking wishlist (round-4, 2026-05-15)

Source: `docs/wishlist-2026-05-15.md` — adopter's forward-looking improvements list,
*pairs with* the round-3 adoption-run report. None of these blocked any single run;
collectively they're what would make the loop faster/leaner across many runs.
Browxai-side items only; site-docs-side wishes (`flow_lint`, `--start-from`, annotation
nudge, `flow tree`, …) are handled separately on that side.

The author's top-3 leverage picks: **D1 + A1 + B4** (B4 is site-docs's). For browxai:
**D1 (`actionable` on `find()` results) is the single highest-leverage addition** —
catches a class of failures at calibration-time instead of run-time and folds together
two of the round-3 🟡 asks.

| # | Group | Severity | Ask (short) | Where it lands |
|---|---|---|---|---|
| W-A1 | snapshot perf | 🟡 | **Scoped snapshots** — `snapshot({ scope: <ref>, maxNodes: N, omit: [<patterns>] })`. Current snapshots routinely emit 200–500 nodes when 5 are wanted; scoped cuts ~7–10k tokens → ~500–1.5k. Author's #2 leverage pick. | extends `snapshotDelta.scope` Phase-1.5 work; new `scope`/`maxNodes`/`omit` params on top-level `snapshot()` |
| W-A2 | snapshot perf | 🟡 | `snapshotDelta` modes that **actually scope** — `tree_diff` emits just the changed subtree (or `appeared:`/`removed:` only). Today falls back to full + warning. Make scoped the natural default. | folds into existing Phase-1.5 `snapshotDelta.scope` + `tree_diff` items |
| W-A3 | find ergonomics | 🟡 | `find({ contextRef, confidenceFloor })` — limit ranking to descendants of a ref; emit `warnings: ["no candidate scored confidently above N"]` instead of always returning 3–5 low-quality hits. | extends round-3 ask #14 (find scoring) and ask #11 (warnings shape) |
| W-A5 | tokens | 🟢 | Console-error summarisation in `ActionResult.console` — single React stack-trace was ~1500 tokens. Mirror the existing `network.requests omitted (count … > cap)` pattern: short summary + `truncated_chars: N` + `console_read` for full. | new field on `ActionResult.console` |
| W-A6 | ergonomics | 🟢 | Smarter `mode` defaults across action primitives — heuristic: emit `tree_diff` when `structure.appeared/removed` is non-empty, else nothing. | tied to W-A2 |
| W-B1 | new primitive | 🟡 | **`eval({ expr, returnType })`** — controlled JS-eval primitive (or narrower `dispatch({ event, target })`). Adopter dropped 30-line `.cjs` scripts in `/tmp` *three times* across the session for a single page-side function call. Page-content concerns apply to the return value (trust boundary preserved); the call originates from the (trusted) agent. | new MCP tool; security-warned (Phase-2 capability-toggle territory) |
| W-B2 | new primitive | 🟢 | `screenshot({ ref, describe: true })` — alt-text alongside the PNG so the agent can skip vision-reading when just confirming "yes the button is there." | extension to `screenshot` tool |
| W-B5 | helper kinds | 🟡 | `await_human({ kind: "confirm" | "input" })` — lost ~3–4 turns waiting for the user to type "Done!". Already on the deferred Phase-1.5 list; the wishlist confirms it's high-leverage. | promotes the pre-existing "await_human kinds beyond acknowledge" item up the queue |
| W-B6 | CLI helper | 🟢 | **`browxai init --consumer <workspace>`** — one-command setup: creates `<workspace>/.browxai/`, registers both MCP entries user-scope, sniffs the codebase for `data-type`/`data-testid` ratio to pick `BROWX_TEST_ATTRIBUTES` order, prints the resolved config. Replaces the hand-typed `claude mcp add-json` dance. | new CLI subcommand |
| W-B7 | CLI helper | 🟢 | **`browxai chrome [start|stop]`** — own the `--cdp` Chrome lifecycle. `start --persistent` uses the right flags + a stable profile location (logins survive across sessions); `stop` clean teardown. Reduces the 4-flag Chrome-launch ceremony to a one-liner. | new CLI subcommand |
| W-C1 | refs | 🟢 | Persistent **named refs** across snapshots — `name_ref({ ref, name })` rebinds across snapshots; `click({ named })` carries small anchor sets session-wide. Today refs are per-snapshot stable but bare `eN`s aren't memorable across rounds. | extends `RefRegistry` (already stable-key based; the named-alias layer is small) |
| W-C2 | recording | 🟢 | Calibration-walk → flow-file scaffold — `start_recording({ flow_name })` / `end_recording()` emits a draft `flow-file.yaml` with locators from the top-ranked `find()` candidate per step. Cuts ~15–20 min/flow of YAML hand-writing. | spans browxai (recording) + site-docs (YAML shape); cross-cutting |
| **W-D1** | **find quality** | 🔴 *(per author leverage)* | **`actionable` predicate on `find()` results** — return `actionable: boolean \| "disabled" \| "covered" \| "off-screen"` alongside `stability` / `bbox`. Closes the calibration-time vs run-time gap that bit twice in round 3 (`<input disabled>` halts that the snapshot already "saw"). The single **highest-leverage** change in this wishlist; folds together two of the round-3 🟡 asks. | new field on `FindCandidate`; ~10–20 LOC behind a Playwright `isVisible()` + `isEnabled()` + a small `elementHandle.evaluate(coversTest)` triple |
| W-D3 | env check | 🟢 | `browxai doctor` — environment & connectivity check (build present? both MCP entries registered? `--cdp` Chrome reachable? `BROWX_TEST_ATTRIBUTES` set? `BROWX_WORKSPACE` writable?). Already deferred from round-2 ask #9; wishlist re-prioritises. | new CLI subcommand |

**Not browxai's:** A4 inline halt-screenshot ref (site-docs writes the halt), B3 `flow_lint`, B4 `--start-from`/`--cdp`, C3 annotation nudge, C4 `flow tree`. **Not anyone's**: D2 pre-seeded fixture (target-app's BE).

**Author's stated "not"-list** worth quoting:

- Replacing site-docs `run` with browxai entirely — buys nothing, loses determinism. The discovery/execution split is right.
- Tier-3/4 selectorHints — already Phase-1.5-deferred; the author observed tier-1 + tier-2 carry ~95% of the load on heavy-`data-attr` codebases.
- Standalone session-wide `network_read` buffer — the `ActionResult.network` per-action slice was sufficient.

## Sequencing

**Phase 1 (delivered 2026-05-13):** asks 1–6 in numbered order. #1+#2 were the
unblockers; #3 fell out of #1 for free in its Phase-1 shape; #4+#5 landed with the
`find()` implementation; #6 is doc-only.

**Phase 1.5 round-2 (2026-05-13):** #7+#8+#10+#11 ✅ shipped same day as the adoption
report that surfaced them; #9 🟡 workaround live (dual MCP registration), full
auto-default deferred.

**Phase 1.5 round-3 (opened 2026-05-15 by the re-adoption-run report — Phase 1 itself
is closed):** #12+#13+#14+#15+#16. #14 is the highest-leverage of the three 🟡 (it's
the gap between "find() ranked what I asked for" and "find() ranked something else and
I read the testid off the snapshot"); #13 prevents a known stack-overflow trap;
#12 is a schema-only knob. None are gating.

**Wishlist round-4 (opened 2026-05-15 alongside the adoption report; forward-looking
not gating):** **W-D1 is the headline** (the author's own top pick), **W-A1** is the
biggest token-cost reduction. The CLI-helper items (W-B6, W-B7, W-D3) share design
space and naturally batch. W-B5 promotes the pre-existing `await_human`-kinds item.

**Phase 1.5 (next, opened 2026-05-13 by the adoption-run report):** ask #7 (DOM-walk
fallback) is the priority — it unblocks the canonical discovery use case on real-world
SPAs and gates `find()` from being usefully exercised. #8 (data-attribute projection)
lands cheaply on top of #7's plumbing. #9 (auto-attach default) is independently small
and high-friction-reducing. #10 carries with the tier-3/4 selectorHint work already
called out for Phase 1.5. #11 is a one-line warning.

## Out of scope (per site-docs)

- Anything Phase-2-shaped on browxai's roadmap (full security/sandbox, learned `find()`
  ranking, headless lifecycle, multi-tenant).
- Replacing site-docs's **execution** mode with browxai — execution stays deterministic
  Playwright, no agent, no MCP, no inference. browxai is **discovery / calibration only**
  on the site-docs side.
