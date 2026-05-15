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
| 12 | 🟡 | **Raise `wait_for.timeoutMs` schema cap.** | **impl-done 2026-05-15** — cap raised from 120 000 ms to 600 000 ms in `server.ts`. |
| 13 | 🟡 | **`selectorHint` disambiguation when the bare hint matches multiple DOM nodes.** | **impl-done 2026-05-15** — `disambiguateHint()` in `find.ts`: when `page.locator(hint).count() > 1`, promotes to `…:visible`, falling through to `:nth-match(…, 1)` if needed. Folded into the W-D1 land. |
| 14 | 🟡 | **`find()` scoring should weight test-attribute string matches more heavily** — especially for `<input>` / non-button elements. | **impl-done 2026-05-15** — `scoreNode` rewritten in `find.ts`: exact testId match +15, substring +10, per-token testId hit +2 (was +1), input-shaped role + testId-token match +3 bonus. Tokens of length < 2 ignored. `confidenceFloor` (W-A3) emits "no confident candidate" warning. |
| 15 | 🟢 | **CDP-attached `bbox: null + clipped: true` for plainly-visible elements.** | **impl-done 2026-05-15** — `session/byob.ts` probes the attached page's viewport at attach time; if zero, sets a 1280×800 default via `Emulation.setDeviceMetricsOverride`. |
| 16 | 🟢 | **Docs: `stability` semantics + `find()` query-matching surface.** | **impl-done 2026-05-15** — `tool-reference.md` `find` section now has explicit "Stability semantics" + "What find() matches against" + "Disambiguation" + "Actionable predicate" + "`confidenceFloor`" paragraphs. |

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

| # | Group | Severity | Ask (short) | Status |
|---|---|---|---|---|
| W-A1 | snapshot perf | 🟡 | **Scoped snapshots** — `snapshot({ scope: <ref>, maxNodes: N, omit: [<patterns>] })`. | **impl-done 2026-05-15** — `serialise` extended with `maxNodes` / `omit` + `findByRef`; `snapshot` tool exposes all three. |
| W-A2 | snapshot perf | 🟡 | `snapshotDelta` modes that **actually scope**. | **impl-done 2026-05-15** — `buildSnapshotDelta` now serialises just the action-ref subtree + appeared regions when `scoped_snapshot` is honoured; `tree_diff` falls back to the same shape (full unified diff still deferred). |
| W-A3 | find ergonomics | 🟡 | `find({ contextRef, confidenceFloor })`. | **impl-done 2026-05-15** — both flags wired through `find.ts` + `server.ts`. |
| W-A5 | tokens | 🟢 | Console-error summarisation in `ActionResult.console`. | **impl-done 2026-05-15** — `summariseConsoleErrors` in `actionresult.ts`: first-line + `truncated_chars` + warnings. |
| W-A6 | ergonomics | 🟢 | Smarter `mode` defaults. | **impl-done 2026-05-15** — default auto-promotes to `none` when no nav/structure change. |
| W-B1 | new primitive | 🟡 | **`eval_js({ expr, returnType })`**. | **impl-done 2026-05-15** — new tool in `server.ts`; security-warned in description (return value is page-controlled). |
| W-B2 | new primitive | 🟢 | `screenshot({ ref, describe: true })`. | **impl-done 2026-05-15** — emits a one-line caption (`role "name" [<attr>="…"] bbox=… [not-visible|disabled]`) alongside the PNG. |
| W-B5 | helper kinds | 🟡 | `await_human({ kind: confirm|choose|input })`. | **impl-done 2026-05-15** — bridge + `__browx` page script extended with `confirm` / `choose` / `input` / `respond` methods; `await_human` MCP tool handles all four kinds. `pick_element` (in-page hover-pick overlay) still deferred — needs shadow-DOM banner. |
| W-B6 | CLI helper | 🟢 | **`browxai init <workspace>`**. | **impl-done 2026-05-15** — `src/cli/init.ts`: creates `.browxai/`, writes workspace-scope `.mcp.json` with both MCP entries, sniffs codebase for dominant test-attribute convention. |
| W-B7 | CLI helper | 🟢 | **`browxai chrome [start|stop|status]`**. | **impl-done 2026-05-15** — `src/cli/chrome.ts`: persistent profile at `$BROWX_WORKSPACE/chrome-profile/`, PID in `chrome.pid`, `--insecure` opt-in. |
| W-C1 | refs | 🟢 | Persistent **named refs**. | **impl-done 2026-05-15** — `RefRegistry.nameRef/refByNameLookup/listNames`; `name_ref` + `list_named_refs` MCP tools; action target shape accepts `named:` alongside `ref`/`selector`. |
| W-C2 | recording | 🟢 | Calibration-walk → flow-file scaffold. | **impl-done 2026-05-15 (Phase 2)** — `Recorder` in `src/page/recording.ts`; `start_recording` / `end_recording` / `record_annotate` MCP tools; YAML draft includes locators block (with `stability: medium\|low — review` flags) + steps with selectorHint-derived targets. |
| **W-D1** | **find quality** | 🔴 *(per author leverage)* | **`actionable` predicate on `find()` results**. | **impl-done 2026-05-15** — `FindCandidate.actionable: true \| "disabled" \| "off-screen" \| "covered"`; `probeActionable()` uses Playwright `isVisible() + isEnabled() + bbox`. `"covered"` reserved (elementFromPoint check deferred). |
| W-D3 | env check | 🟢 | `browxai doctor`. | **impl-done 2026-05-15** — `src/cli/doctor.ts`: build / workspace / test-attrs / cdp-attach reachability / chromium binary, with one-line fixes per ✗. |

**Not browxai's:** A4 inline halt-screenshot ref (site-docs writes the halt), B3 `flow_lint`, B4 `--start-from`/`--cdp`, C3 annotation nudge, C4 `flow tree`. **Not anyone's**: D2 pre-seeded fixture (target-app's BE).

## Round-5 asks (post-shipping, 2026-05-15 — non-Claude-consumer pain points)

Source: in-conversation feedback from a non-Claude MCP client run. Three concrete pain
points where the curated surface forces wasteful loops or has no answer at all:

Each ask was reframed from the consumer's literal request to the underlying problem
class — primitives must compose, not accumulate one-off helpers.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| W-E1 | Post-action state isn't observable enough → callers screenshot to confirm writes landed. | Enrich the `ActionResult.element` probe with the actual post-action DOM `value` (not the requested-value echo), `valueRequested` for comparison, `displayText` (visible text of the closest labelled wrapper — covers chip-style selects, badge pickers, custom dropdowns that clear the underlying input on commit), and `checked` for checkbox/radio. | **impl-done 2026-05-15** |
| W-E5 | Stable refs lose provenance, so the locator engine routes DOM-walk-origin refs to weak role-style locators that don't actually exist. | Every ref records its source (`a11y` \| `dom` \| `both`); `locatorFor()` chooses by provenance — a11y refs use role/name locators, DOM-walk refs use the structural CSS path captured at walk time. | **impl-done 2026-05-15** |
| W-E4 | Selectors are global, but most targets are positional within structure (rows, cards, panels). `find()` already accepts `contextRef`; actions don't, forcing brittle global selectors. | Extend the action target shape with `contextRef` so any `selector` resolves *within* that subtree. Same shape as `find()`. Selector composition is the primitive, not row-aware helpers. | **impl-done 2026-05-15** |
| W-E2 | MCP forces one round-trip per call; agents pay model-tokens per result when sequences are known-safe. | `batch({ calls, stopOnError? })` runs N calls server-side and returns `{ completed, failedAt, results }`. `stopOnError: true` default; whitelist forbids nested `batch` and human-blocking tools; no parallel mode. | **impl-done 2026-05-15** |
| W-E3 | Ref/selector resolution can't address visually-located targets (canvas, custom-painted UIs, dismiss-empty-space). | Extend the action target shape from `{ ref \| selector \| named }` to also accept `coords: {x, y}`. `click` / `hover` / `press` accept it uniformly; no parallel `*_at` tools. Documented as the escape hatch. | **impl-pending** |

**Sequencing:** W-E1 (done) → W-E5 (foundational; fixes correctness for ref routing,
everything else benefits) → W-E4 (scope via existing target shape) → W-E2 (batch on
top of a settled per-tool result shape) → W-E3 (coords on top of a settled target
shape). All before Phase-3 public-release work.

**Out of scope:**

- A general `dom_inspect(ref)` query primitive — `eval_js` already covers it; we don't
  need another way in.
- Coordinate-based `fill` / `press` content — coordinates address the *target*, not
  the *input*. Once a target is resolved, refs/selectors are correct.
- Auto-batch across rounds — `batch` stays explicit; implicit grouping is a debugging
  nightmare.
- Row-aware / table-aware helpers — `contextRef + selector` covers the case
  generically.

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
