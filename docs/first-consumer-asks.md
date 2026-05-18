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
| W-E3 | Ref/selector resolution can't address visually-located targets (canvas, custom-painted UIs, dismiss-empty-space). | Extend the action target shape from `{ ref \| selector \| named }` to also accept `coords: {x, y}` (CSS pixels, viewport-relative). `click` / `hover` honour it; fill/press/select don't (input-driving still needs a resolved element). No parallel `*_at` tools. | **impl-done 2026-05-15** |

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

## Round-6 asks (post-shipping, 2026-05-15 — screenshot-less authed-SPA report)

Source: `docs/screenshotless-flows-report-2026-05-15.md`. After round-5, plain-input
writes and known-safe batches stopped requiring screenshots. The remaining screenshot
dependency concentrated in **proving semantic state after actions that target custom
controls inside repeated layouts**. The eight literal asks in the report collapse into
six primitives plus an ergonomics fix.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| W-F1 | Nodes in repeated structures lose their structural neighborhood, so serialised snapshots can't answer "what row/column is this in?". | Structural-context annotations on `snapshot()`/`find()` nodes: `context: { collection, rowKey, column, rowText }`. Generic detector — semantic table/grid roles, repeated-sibling-of-same-shape, header-aligned columns. No table-specific helpers. **Foundational; F2/F4 reference these annotations.** | **impl-done 2026-05-15** |
| W-F2 | `ActionResult.element` describes the direct action target, not the *logical thing that changed* (owning combobox, containing row, coordinate-hit element). | Extend the post-action probe with `ownerControl?` (label, kind, `displayTextBefore`/`displayTextAfter`, `changed`) and `container?` (kind, rowKey, contextText, changed). For `coords` targets, add `hit` (elementFromPoint before/after, owner ancestor, focus change). Owner detection via `aria-controls`/`aria-labelledby`/labelled ancestor; container via the F1 detector. **Also reframes coords as a first-class peer of ref/selector for canvas / WebGL / painted UIs — not an apologetic "escape hatch".** | **impl-done 2026-05-15** |
| W-F3 | Custom combobox/listbox selection by coords or type+Enter can't be semantically confirmed; `select` only handles native `<select>`. | `choose_option({ target, option, exact? })`: opens target, waits for listbox/menu/portal, picks the resolved option element matching `option` text, returns the F2-shaped probe. Generic combobox/listbox/menu — not record-entry-specific. | **impl-done 2026-05-15** |
| W-F4 | `find()` is action-target resolution; overloading it for presence/absence verification gets unrelated candidates. | `text_search({ text, exact?, scope?, includeHidden? })` read-only tool returning `{ count, matches: [{ ref, text, context, bbox, clipped }] }`. The verification primitive, separate from `find()`. | **impl-done 2026-05-15** |
| W-F5 | Action windows summarise network counts but not "did a mutation succeed and what shape did it write back". | `ActionResult.network.mutations: [{ method, urlPattern, status, responseShape, durationMs }]` for write-shaped requests in the action window. `responseShape` is *just the top-level key names* of the response — no values. Bounded and redacted by default. Full body inspection ships separately as `network_body({ requestId })` under a higher-risk capability. | **impl-done 2026-05-15** |
| W-F6 | Batch results are hard to audit; failures don't fail until the model parses the result back. | Each `batch` call accepts optional `label` (echoed verbatim in result for cross-referencing) and optional `expect` predicate (`valueEquals`, `displayTextIncludes`, `controlDisplayTextIncludes`, `containerTextIncludes`, `controlChanged`). Failed expect counts as call failure and respects `stopOnError`. Minimal DSL — not an assertion language. | **impl-done 2026-05-15** |
| W-F7 | `screenshot` returns full-resolution PNG; multimodal agents need to trade file size vs fidelity for context budget. | Add `quality: 0-100` (for JPEG), `format: "png" \| "jpeg"`, `scale: "css" \| "device"` to the `screenshot` tool. Defaults unchanged (PNG, device-scale). Multimodal-agent ergonomics — does not introduce OCR or screenshot-driven inference; the agent's own vision capability does that. | **impl-done 2026-05-15** |

**Sequencing:** F1 (foundational — context detector) → F2 (uses F1 for `container`;
also lands the coords-as-first-class doc reframe) → F3 (uses F2's `ownerControl`) →
F4 (uses F1's `context` in matches) → F5 (independent) → F6 (depends on F2's
`displayTextAfter` / `value` for `expect` predicates) → F7 (independent ergonomics).

**Out of scope for round-6:**

- **Screenshot OCR / vision-from-server** — multimodal agents bring their own vision;
  browxai stays in the structured-state domain. F7 lets the agent tune what it sees
  without us inferring on the page.
- **Unbounded network response bodies by default** — F5 stays redacted (keys only).
  A separate `network_body({ requestId })` tool under a higher-risk capability can
  expose full bodies opt-in; that's a future, gated addition, not part of F5.
- **App-specific helpers** (record-entry / timesheet / form-grid / dated rows) —
  the F1 structural-context detector is the primitive; consumers compose against
  it. No `record_grid_row()` helpers.
- **Auto-screenshot fallback** — if a probe is ambiguous, return that ambiguity to
  the caller; don't paper over it with a screenshot under the hood.

## Round-8 asks (post-shipping, 2026-05-15 — Phase-2 non-Claude-consumer verification)

Source: `docs/adoption-report-nonclaude-spa-2026-05-15.md`. Non-Claude MCP client
(Codex) drove browxai end-to-end against a real authed SPA — calibration walk,
recording, two site-docs flows produced. **Verdict "gappy green":** the
non-Claude-consumer leg of Phase-2 close is materially passed. The remaining
Phase-2-close gate is the headless-CI keystone (the runbook's other open item).
Five asks surfaced — one 🔴 blocker for non-Claude clients running this loop
themselves, three 🟡 quality issues, one 🟢 polish.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-G1** 🔴 | BYOB `byob_action` confirm hook is **operator-driven** (human at DevTools issues `__browx.confirm(true)`), but verification paths and any non-Claude MCP client with no human at the wheel can't drive that loop from within a blocked tool call. Dropping `byob_action` from `BROWX_CONFIRM_REQUIRED` entirely is the workaround, not the fix. | MCP-callable session pre-approval: `approve_actions({ scopes, ttlSeconds? })`. The client invokes once at session start with scopes like `["byob_action"]`. Confirm hooks check the pre-approval store first; auto-approve when active, fall back to page-side `__browx.confirm` outside the TTL. Auditable (each pre-approval logged with scope + TTL). Pairs with `browxai init --mcp-client codex` writing the looser default into the workspace `.mcp.json` for full-headless setups. | **impl-done 2026-05-15** |
| **W-G2** 🟡 | Multiple Playwright clients attaching to the same long-lived tab inject helpers; when one disconnects, stale-binding errors (`__browx_send` / `__siteDocs_capture` missing) keep firing from helper references still on the page. | `BrowxBridge.detach()` now (a) flips a server-side `detached` flag — the binding handler quiet-drops incoming payloads instead of routing them into rejected waiters; (b) installs `window.__browx_no_binding = true` in every attached context's pages; (c) the in-page `send()` checks the flag and routes through the DOM-attribute fallback path instead of calling the now-detached exposeBinding glue. Silences the "Function `__browx_send` is not exposed" console noise the verification run flagged. `__siteDocs_capture` is site-docs's binding; same pattern recommended there. | **impl-done 2026-05-15** |
| **W-G3** 🟡 | Attached-mode `find()` reports `bbox: null` / `actionable: "off-screen"` for elements plainly visible in the BYOB Chrome viewport. Pure correctness bug, not a new primitive. | Narrowed `page/bbox.ts` overflow check to **only** clip on `overflow: hidden` / `clip` (previously also clipped on `auto` / `scroll`, which collapsed bboxes for layouts whose body/html or scroll-container used `overflow: auto`). Added document-element fallback when `window.innerWidth/innerHeight` read zero, and last-resort un-clipped client rect when both probes fail. `session/byob.ts` now consults `Page.getLayoutMetrics` alongside `Runtime.evaluate` before deciding to install the 1280×800 default override. | **impl-done 2026-05-15** |
| **W-G4** 🟡 | `find()` ranking under-weights icon-only controls — when sibling icon tabs share testId-token overlap, the correct candidate is in the list but not first. Discovery is fine; ranking is the gap. | (a) `scoreNode` amplifies per-testId-token weight from +2 to +3 when `name` is empty + `testId` is non-empty (the icon-only signature). (b) `dom-walk`'s `nameFor()` now falls back to `el.getAttribute("title")` after textContent — icon-only buttons commonly carry their visible label there, and surfacing it makes the standard name-based scoring apply. | **impl-done 2026-05-15** |
| **W-G5** 🟢 | Recorder draft YAML preserves failed exploratory actions (timed-out / blocked calls), producing not-commit-ready output. | Diagnosis: failed actions were already filtered by `ok && recorder.active()`. The "untargeted" entries the report flagged were **coord-mode click/hover** that succeeded mechanically but had no ref/selector/hint — flow files can't mechanically replay coords, so they don't belong in the draft. Fix: gate also requires the action either be non-targeted (navigate / goBack / goForward) OR carry a replayable target (descriptor `ref`/`selector` or `recordingHint`). Skipped coord steps surface a structured `warnings:` entry on the `ActionResult` so the agent knows the step wasn't recorded. | **impl-done 2026-05-15** |

**Sequencing:** G1 first (🔴 blocker — until it lands every non-Claude adopter
pays the same paper cut) → G3 (visible-but-off-screen breaks `actionable`
trust for everyone) → G2 (binding hygiene) → G4 (ranking tweak) → G5 (recorder
cleanup).

**Phase-2 verification milestone:** the 2026-05-15 non-Claude-consumer run is
the Phase-2-close non-Claude-consumer requirement from `AGENT-RUNBOOK.md`. With
G1 shipped, the loop becomes clean (no `__browx.confirm` plumbing). Phase-2
close still gates on the **headless-CI keystone** — the runbook's other open
verification item.

## Round-11 asks (post-shipping, 2026-05-18 — round-10 verification re-report)

Source: the same second consumer's Round-2 verification pass (sanitised into
`docs/adoption-report-mobilechat-2026-05-18.md` § "Round 2"). All three
round-10 primitives confirmed working live; the run surfaced one correctness
bug and one small bounded additive.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-J1-fix** 🔴 | `wait_for({ text })` documents *substring* matching but the impl lowered to Playwright's quoted/exact-ish `text=` engine — a short token inside a longer string timed out. Doc-vs-behaviour mismatch (introduced in round-10). | Switch the matcher to `page.getByText(text)` (substring, case-insensitive, trimmed — Playwright default) `.first().waitFor({ state:"visible" })`. Behaviour now matches the documented contract; substring is also the more useful readiness-gating semantic. | **impl-done 2026-05-18** |
| **W-K1** 🟢 | `sample` over long high-rate windows (e.g. 3 s @ rAF ≈ 360 pts) serialises large; the agent only needs the *signal* (did it move? bounds? when did it first change?), not every point. | Optional `sample({ summary?: true })` → server-side reduction of the already-collected fixed-metric series: `{ count, min, max, first, last, distinctCount, firstChangeTMs }` instead of the full `series`. Pure reduction — **no agent JS, no eval surface** (consistent with W-J3's bounded design). `summary` always included; `series` omitted only when `summary:true`. | **impl-done 2026-05-18** |

**Hygiene (durable, not an ask):** adopters/agents keep dropping raw
client-named `FIELD-REPORT-*.md` in the repo root; the repo is heading
public. Added a `.gitignore` rule (`FIELD-REPORT-*.md`, `*-field-report.md`)
so a raw report can never be accidentally committed — the canonical committed
form is always a sanitized `docs/adoption-report-*.md`.

**Sequence:** W-J1-fix → W-K1.

## Round-10 asks (post-shipping, 2026-05-18 — second-consumer field report)

Source: `docs/adoption-report-mobilechat-2026-05-18.md` — a **second
non-site-docs consumer** (a Claude Code agent) drove browxai on a real authed
SPA and closed a deployed-build bug the test suite structurally could not
catch. Strong validation of the P2.5 + round-6/8/9 surface (device+viewport
+incognito, `eval_js`, `ActionResult.element.hit`, `network.mutations`,
`coords`, session lifecycle all singled out). This is the strongest
**Phase-3 trigger #4** ("a real demand signal — a second non-site-docs
consumer actually using it") datapoint so far — logged in portfolio progress;
does not on its own close the trigger.

Friction reframed to problem classes. The arbitrary-JS items are deliberately
**not** turned into general primitives — `eval_js` (gated behind the `eval`
capability) stays the single arbitrary-JS loophole.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-J1** 🔴 | SPA readiness gating: `wait_for` only accepts a target (ref/selector/named/coords) — no "wait until this text appears" mode; agents hand-roll shell-sleep + poll. | Extend `wait_for` with an optional `text` predicate — polls until the given visible text appears (or `timeoutMs`). Keeps existing target modes. **No `jsExpr` mode** — arbitrary-JS waits stay `eval_js`'s domain (the one gated loophole). | **impl-done 2026-05-18** |
| **W-J2** 🟡 | `find()` returns confident off-screen/clipped candidates and never surfaces the visible one; all-non-visible top-N is a strong "wrong match" signal that isn't flagged. | Visibility-aware ranking: stable-partition `actionable:true` ahead of non-visible; when *all* top-N are non-visible, emit a `warnings` entry. **Capability-aware** — names `coords` only when `action` enabled, `eval_js` only when `eval` enabled (never points at a disabled tool). | **impl-done 2026-05-18** |
| **W-J3** 🟢 | Frame-aligned metric sampling (scroll-drift / jank / CLS) is hand-rolled in-page every run. | `sample({ target?, metric, durationMs, everyFrame?\|intervalMs? })` → `{ metric, scope, mode, count, series:[{tMs,value}], truncated? }`. `metric` is a **fixed enum** (scroll*/client*/bbox* for a target; document scroller for window — bbox* needs a target). browxai supplies the fixed in-page rAF/interval loop — **no agent-supplied JS** (would re-open the loophole W-J1 closed). Caps 30 s / 2000 pts. Capability: `read`. | **impl-done 2026-05-18** |

**Not browxai's:** bulk tool-schema preload — MCP-client schema deferral
(`ToolSearch`) is a client feature; browxai already advertises its full
surface. Workaround: `ToolSearch "+browxai"` bulk-loads. Documented, not built.

**Out of scope by design:** a Vue/React framework-state bridge — production
builds deliberately strip introspection, and a framework-specific hook
violates the design-for-the-problem-class rule (no library/framework
coupling). The behavioural-proxy approach is the documented recipe.

**Sequence:** W-J1 → W-J2 → W-J3.

## Round-9 asks (post-shipping, 2026-05-18 — e2e-verification primitives)

Source: an external bug-list reference (a sibling project's staging-blocker
findings) read **only** for the *classes* of defects an agent must live-verify
— no app-specific content enters the codebase. The recurring pattern: large
green unit-test suites, prod-broken behaviour caught only by live multi-user
observation of realtime + scroll + responsive-layout state. Reframed to
generalized primitives. Multi-user isolation (P2.5 sessions), disabled/
actionable state (`find().actionable` + W-F2), and the `scroll` action are
already covered — these six are the genuine gaps.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-H1** 🔴 | Realtime correctness is unverifiable — browxai sees HTTP via `network_read` but is blind to WebSocket / SSE frames. A general class (chat, multiplayer, collaborative editing, live dashboards): the only ground truth is the frame stream. | `ws_read({ session, urlPattern?, limit? })` read tool + per-action WS/SSE-frame slice in `ActionResult.network`. CDP `Network.webSocketFrame{Sent,Received}` + EventSource. Bounded/redacted like the existing network surface. Capability: `read`. | **impl-done 2026-05-18** |
| **W-H6** 🟡 | A session renders at Playwright's default desktop viewport with no device profile — responsive / touch / DPR-dependent behaviour can't be exercised at all. | Three composing layers on the P2.5 model: `open_session({ viewport?, device? })` (explicit dims, or a Playwright `devices` preset → viewport+DPR+mobile+touch+UA); `defaultViewport`/`defaultDevice` in the ConfigStore precedence chain; `set_viewport({ session, width, height })` mid-session resize → `ActionResult`. Honest limits: full device emulation is creation-time only (Playwright context constraint); best-effort on `attached`. | **impl-done 2026-05-18** |
| **W-H2** 🟡 | Scroll/pagination verification needs geometry the agent can't read ("scrollHeight grew X→Y", "pinned to bottom"). `scroll` mutates but reports no metrics. | `scroll`/`set_viewport` `ActionResult.element.scroll` reports `{ x, y, scrollWidth, scrollHeight, clientWidth, clientHeight, atTop, atBottom }` for the scrolled container (container-mode) or document (window/into-view/wheel/resize). Makes prepend / pinned-to-bottom assertable without `eval_js`. | **impl-done 2026-05-18** |
| **W-H3** 🟡 | Layout-break + control-state bugs (a flex row losing a child → misalignment; `cursor-wait` vs `cursor-not-allowed`; label clips/overflows) need computed style + box geometry the curated surface doesn't expose. | `inspect({ ref\|selector\|named, styles? })` read tool → `{ found, box, styles (whitelisted + extras), overflowing:{x,y}, visible, childCount }`. Generalizes visible-rect to "is this visually broken". Capability: `read`. | **impl-done 2026-05-18** |
| **W-H5** 🟡 | Asserting an exact payload field in a realtime/HTTP body needs response *bodies*, not just the W-F5 key-shape. The deferred gated tool; this is its validating use case. | `network_body({ session, requestId })` under a new **off-by-default** `network-body` capability (loud startup warning). Returns the bounded (256 KB) full body. `requestId` now surfaced on `network_read` / `ActionResult.network.requests[]`. Pairs with W-H1 for realtime payloads. | **impl-done 2026-05-18** |
| **W-H4** 🟢 | Transient-UI timing bugs (two toasts in N seconds; "notification never broadcast") need observation of appear/disappear over a window with no driving action. | `watch({ session, durationMs, sampleMs? })` — *samples* transient regions across the window (so appear-and-vanish is caught, not just endpoint-diffed) + console/network/ws slices. Each region gets `appearedAtMs`/`disappearedAtMs`. Capability: `read`; ≤60 s. | **impl-done 2026-05-18** |

**Sequence:** W-H1 → W-H6 → W-H2 → W-H3 → W-H5 → W-H4.

**Out of scope:** forged-auth / programmatic state-seeding is the *test
harness's* job, not browser control — browxai drives the browser; seeding
state is the consumer's. No app-specific assertion helpers — the primitives
are generic; consumers compose verification logic on top.

## Round-7 (forward-looking) — interaction-vocabulary expansion + cross-OS

Captured 2026-05-15. Not shipping in round-6 — these are roadmap items raised once
the screenshot-less observability work surfaced that browxai's *interaction* surface
is narrower than its *observation* surface. Today's vocabulary is `click` (with
`button: left|right|middle`), `fill`, `press` (Playwright key syntax), `hover`,
`select`, and `coords`-mode click/hover. That's enough for forms; it's not enough
for canvas apps, web3 / WebGL viewers, drawing tools, kanban boards, multi-select
grids, or any flow that depends on modifier-held actions.

| # | Problem class | Provisional primitive |
|---|---|---|
| W-G1 | No drag-and-drop. Kanban move, file drag-upload, canvas pan, slider scrub, range-select all rely on a press-move-release sequence the current vocabulary can't express. | `drag({ from, to, steps?, modifiers?, button? })`. Both endpoints accept the full target shape (ref / selector / named / coords). Optional `steps` controls intermediate `mouse.move` frames so drag-aware code (sortable lists, canvas) sees motion. Optional `modifiers` applies a held-modifier set during the drag. |
| W-G2 | Modifier-keyed clicks/hovers (Shift-click range-select, Ctrl/Cmd-click open-in-new-tab, Alt-click context override) can't be expressed. | Add `modifiers?: Array<"Shift" \| "Control" \| "Alt" \| "Meta" \| "ControlOrMeta">` to `click` / `hover` / `drag`. Maps directly to Playwright's `modifiers` arg. `ControlOrMeta` handles the cross-OS shortcut convention (Cmd on macOS, Control elsewhere) without per-platform branching in agent code. |
| W-G3 | Holding *non-modifier* keys during an action (F-to-fill in some drawing tools, Space-to-pan in canvas viewers, Q-to-rotate in 3D tools) — Playwright's modifier set only covers Shift/Control/Alt/Meta. | `key_chord({ hold: ["KeyF"], action: { tool, args } })` — depresses the given physical key codes via CDP `Input.dispatchKeyEvent` (rawKeyDown / keyUp), runs the inner action, then releases. Generic — any key, any wrapped action. |
| W-G4 | Multi-key sequences (Ctrl+Shift+P → "find file" → Enter) are expressible as several `press` calls but pay a round trip each and lose atomicity. | `key_sequence({ keys: ["Control+Shift+P", "Tab", "Enter"], inter? })` — one ActionResult; optional `inter` ms delay between presses for shortcut UIs that debounce. |
| W-G5 | Cross-OS shortcut conventions diverge (Cmd vs Ctrl, different default key bindings for select-all / copy / paste / undo / find / refresh, IME keyboard layouts). Today the caller has to know the host OS. | Adopt `ControlOrMeta` as the documented default modifier in `key_sequence` / `key_chord` / `modifiers`. Optional `os` param on these tools (`"auto" \| "mac" \| "windows" \| "linux"`) to force-pin the resolution; `"auto"` (default) infers from `BROWX_HOST_OS` env override → `process.platform` → reasonable defaults. Document the IME / dead-key constraint explicitly; do **not** silently transform text inputs. |

**Sequencing thoughts (non-binding):** G2 lands cheaply on top of the existing
target-shape work (a `modifiers` array passed through to Playwright). G1 is the
biggest unlock for canvas / kanban apps and should pair with W-F2's coords-evidence
so drag *endpoints* are inspectable. G3 needs CDP-level key dispatch — independent
of G1/G2. G4 + G5 ship together as the keyboard-vocabulary pair.

**Out of scope here too:**

- App-specific "drag this card to that column" helpers — the primitive is generic
  drag with coord/ref endpoints.
- A full keyboard-emulation layer for IME / dead-key / multi-byte input — flag the
  limitation, don't paper over it.
- An OS-detection daemon that watches the host for state changes — `os: auto` reads
  once per session, that's enough.

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
