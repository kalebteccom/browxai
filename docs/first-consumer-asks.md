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

## Round-18 asks (post-shipping, 2026-05-20 — non-Claude media-editor run on the unstable lane)

Source: a Codex run exercising the just-shipped unstable lane (`drag`,
`poll_eval`, `eval_js`) on a media-editor SPA (raw client report NOT
committed — `.gitignore`d; signal lifted as problem classes). App / client
names stripped.

**Already resolved before this capture** (the run used a pre-fix build):
the `drag` capability-gate confusion (`get_config` showed `unstable` while
the live gate didn't) and the `point_probe` `"reading 'stack'"` crash were
both fixed 2026-05-20 — `get_config` now reports the *live enforced*
capabilities + a `capabilitiesPendingRestart` block, the disabled-tool error
spells out the restart + array-replace precedence, and `point_probe` /
`act_and_diff` use a correct in-page IIFE (a string passed to `page.evaluate`
is an expression — the `function(arg){…}` form was never called). The
`drag.to.coords` schema rendering as `string` (shared zod instance →
`$ref` dedup) is fixed too. The run also **validated** the lane: `drag`
worked reliably post-restart, `poll_eval` effective for Redux-state waits.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-R1** 🟡 | A coordinate/element `drag` that starts near an element's edge lands on a **resize/drag handle** and triggers the wrong interaction (resize instead of reorder) — the agent can't see what the press point will hit before committing. | A drag **preflight** + a centre-biased element-target press: report the top hit element + nearest draggable / resize-handle ancestors at the `from` point before moving (reuses `point_probe`'s stack logic), and an `avoidEdges`/centre-bias option for element-target drags so the press lands on the content body, not a handle. Capability `unstable` (extends `drag`). | **impl-done 2026-05-20** (`drag({preflight:true})` → `{point,hit,resizeRisk}` via `point_probe`; element targets already press the box centre — no separate `avoidEdges` math, which can't help a genuinely narrow item) |
| **W-R2** 🟡 | Setting files on a file `<input>` has no first-class tool — agents inject a `File` + `DataTransfer` via `eval_js`, a common browser-test primitive forced onto the arbitrary-JS escape hatch. | An `upload_file` action: a `ref`/`selector` to a file input + filename + MIME + content (base64) **or** a workspace-rooted path → Playwright `locator.setInputFiles()`. No agent JS. Gated by the existing off-by-default **`file-io`** capability (reserved for exactly this — its own posture class, not `unstable`). | **impl-done 2026-05-20** (`upload_file`; `content` base64 xor workspace-rooted `path` w/ escape rejection; `file-io` cap now bound to a real tool. site-docs keeps its own flow-step `upload` for the headless flow-runtime — both engines, headful + headless) |
| **W-R3** 🟢 | A genuine `point_probe` failure returns a bare `{ok:false,error}` — no coordinate / page URL for triage. | On failure return `{ ok:false, point, url, error }`; the crop path is already best-effort (never fails the probe). Small hardening on top of the crash fix. | **impl-done 2026-05-20** |

**Validated, no-op:** persistent-profile auth restore, `drag` (post-restart),
`poll_eval` for async store waits, `screenshot` `scale:"css"`+JPEG payload
sizing — all confirmed working.

**Proposed sequence:** W-R1 → W-R2 → W-R3 (all outside the stable freeze —
`unstable` / `file-io` capabilities).

## Round-17 asks (post-shipping, 2026-05-19 — multi-agent QA + media-editor QA)

Sources: a multi-agent Claude-Code QA campaign (raw client report — NEVER
committed, `.gitignore`d; signal lifted as problem classes only) and
`docs/adoption-report-media-editor-qa-2026-05-19.md` (sanitised). App /
client / framework names stripped.

**Already shipped — document, don't rebuild** (consumers didn't know): the
"act-then-capture-window" ask is `act_and_sample` (**W-N1**); the
"prefix/idle bulk teardown" ask is `close_sessions({prefix|all|idleMs})`
(**W-N2**) — only an *automatic* idle reaper would be new (folded into W-Q*
backlog, not this round).

**Phase-3 freeze decision (owner):** W-Q1–Q6 ship to the **stable** surface
this round; W-Q7–Q11 are the **capability-gated / `unstable.*` deferred
lane** (the reports themselves ask for them "behind a capability"), so the
public surface can freeze and the Phase-3 #2 stability clock can start. A
semver + stability-policy baseline is cut alongside this round.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-Q1** 🔴 | A whole bug class only reproduces when the tab is **backgrounded** (throttled `setTimeout`, paused rAF so framework enter/animation hooks never fire, on-focus refetch/stale-replay). browxai keeps the driven tab foreground, so agentic QA structurally scores these flows PASS while they're broken. | Tab-visibility control: set `document.visibilityState='hidden'` + dispatch `visibilitychange`, AND genuinely deprioritise the page via CDP so real timer/rAF throttling applies (managed/incognito; best-effort + warn on attached). Plus a composed "act → background N ms → foreground" so the triggering transition is reproducible in one call. No agent JS. | **impl-done 2026-05-19** (`tab_visibility`; `holdMs` = the composed background→return form; real throttling best-effort/headless-named) |
| **W-Q2** 🟡 | `press` drives one combo, but multi-step shortcuts are unergonomic and the agent can't tell whether the app *handled* the shortcut or what was focused/affected; copy/cut/paste are opaque (internal vs OS clipboard). | A `shortcut` action (named chord / multi-step sequence) returning observability — active element at dispatch, which `keydown`/`copy`/`paste`/`cut` listener fired, default-prevented — over the window. Capability-gated clipboard: a **per-session** clipboard model (concurrency-safe across sessions); the OS clipboard is touched **only transactionally on an explicit copy/cut/paste command**, never ambiently, and left as-is between commands. Off-by-default capability (posture class of `eval`/`network-body`). | **impl-done 2026-05-19** (`shortcut` tool; per-session `ClipboardBuffer`; OS write transactional + best-effort/zero-dep; observability works without the cap) |
| **W-Q3** 🟡 | In canvas / virtualised-timeline / painted UIs the real target isn't a clean element; agents trust a screenshot estimate of what a coordinate hit. | Read-only `point_probe({coords})`: full `elementsFromPoint` stack, each element's role/name/testId/class summary + computed pointer-events/visibility/z-index/cursor/bbox, nearest scroll container + clickable ancestor, optional small crop. Fold the hit-target stack into `click`/`hover({coords})` results (extends the existing `element.hit`). `read` cap; no agent JS. | **impl-done 2026-05-19** (`point_probe` tool: full stack + scroll/clickable ancestors + optional crop. The "fold into click/hover results" half — framed "also consider" — left as a doc cross-ref to `point_probe`; coord actions keep `element.hit`. Revisit if a consumer needs it inline.) |
| **W-Q4** 🟡 | A browxai-side context detach/teardown is indistinguishable from an app navigation/renderer crash → expensive false "CRITICAL crash" defects. | Add a `reason`/source field on the relevant error/teardown output distinguishing **app-origin** (navigation / renderer crash) from **browxai-origin** (context closed / detached / anti-wedge timeout). Pure output-shape. | **impl-done 2026-05-19** (`ActionResult.failure:{source,hint}`; `classifyFailure` shared classifier; browxai-teardown checked first since a false app-crash defect is the costly mistake) |
| **W-Q5** 🟢 | Agents read a no-op click as a human "confirmation gate" and mark real features unverified, when the actual requirement was calling `approve_actions` (or it's a selector problem). | Not a primitive: the blocked-action error must explicitly say "call `approve_actions` to enable action tools" (not language implying a human approver), surfaced in the **first** error, not only docs. | **impl-done 2026-05-19** (`denyContent` hint rewritten: explicit `approve_actions` call, "gated not broken", "not a human wall / not a selector fail") |
| **W-Q6** 🟢 | `eval_js` `el.click()` doesn't fire framework (`@click`/synthetic) handlers → recurring false "feature broken" negatives. | Not a primitive: prominent tool-level doc + a soft warning in `eval_js` output when `.click()` is detected (use the `click` tool for trusted-equivalent dispatch). | **impl-done 2026-05-19** (eval_js description ⚠ + regex-detected soft `warning` on the result) |
| **W-Q7–Q11** ⚪ | Heavier media-editor / race-condition QA surface: scoped network route mocking with delay/reorder (Q7), pointer gestures `drag`/`mouse_*`/`double_click` (Q8 — overlaps the deferred Round-7 interaction-vocab backlog), scoped `act_and_diff` class/style/selection diff (Q9), `act_and_wait_for_network` + bounded `poll_eval` (Q10), region screenshots / named visual refs / cross-session capture / session-report export (Q11). | **Deferred capability-gated / `unstable.*` lane** — explicitly out of the stable freeze. Each lands behind an off-by-default capability when scheduled; not this round. | **deferred (post-freeze lane)** |

**Sequence (stable):** W-Q1 → W-Q2 → W-Q3 → W-Q4 → W-Q5/Q6 — **all shipped
2026-05-19**; semver + stability baseline cut (**v0.1.0**, stable surface
frozen — see `docs/tool-reference.md` "Stability & semver").

## Deferred lane (capability-gated / `unstable.*`, post-freeze)

Explicitly **out of the v0.1.0 stable freeze** — new adoption asks land here
by default; promotion into the stable surface is a deliberate, versioned act,
and a round that only adds to this lane does **not** reset the Phase-3
"API stable ~1 month" clock. Each item lands behind an off-by-default
capability when scheduled.

**Status: W-Q7–Q11 all shipped 2026-05-19/20**, every tool gated behind the
single off-by-default **`unstable`** capability (`poll_eval` additionally
needs `eval`). The v0.1.0 stable surface (default caps
`read,navigation,action,human`) is **unchanged** — the stability clock keeps
running. Enable the lane with `BROWX_CAPABILITIES=…,unstable`.

| # | Problem class | Lands behind | Status |
|---|---|---|---|
| **W-Q7** | Scoped network route mocking with delay/reorder (race-condition QA: responses out of request order). | capability `unstable` | **impl-done 2026-05-20** (`route`/`route_queue`/`unroute`; per-response `delayMs` = the reorder lever; per-session `RouteRegistry`) |
| **W-Q8** | Pointer-gesture set: `drag`, `mouse_down/move/up`, `double_click` (media-editor scrub/trim/lasso). Overlaps the Round-7 interaction-vocab backlog. | capability `unstable` | **impl-done 2026-05-20** (`drag`/`double_click`/`mouse_down`/`mouse_move`/`mouse_up`) |
| **W-Q9** | Scoped `act_and_diff`: class / `aria-*` / `data-*` / inline-style diff around one action (selection-heavy UIs where state isn't text/a11y). | capability `unstable` | **impl-done 2026-05-20** (`act_and_diff`; structural DOM map before/after, `diffDomMaps` pure diff) |
| **W-Q10** | `act_and_wait_for_network({action,match,timeoutMs})` + bounded `poll_eval` (behind `eval`) for precise async assertions. | `unstable` (+`eval` for poll_eval) | **impl-done 2026-05-20** (`act_and_wait_for_network` armed pre-dispatch; `poll_eval` requires `unstable`+`eval`, per-poll deadline-bounded) |
| **W-Q11** | Region screenshots + named visual refs (`name_region`), cross-session capture (drive A, sample B in one call), session labels + `export_session_report`. | capability `unstable` | **impl-done 2026-05-20** (`screenshot_region`, `name_region`/`region`, `cross_session_sample`, `export_session_report` — labels folded into the report's `note`) |

## Round-16 asks (post-shipping, 2026-05-19 — non-Claude post-fix revalidation)

Source: `docs/adoption-report-nonclaude-spa-postfix-2026-05-19.md` — the same
Codex consumer re-ran the real authed target to verify the Round-15 fixes.
**Verdict: green.** Four of five held cleanly on the live target: **W-O1**
URL redaction confirmed materially better (host/path/status/timing still
useful, credential blobs gone), **W-O2** attached `bbox`/`actionable` fixed
(`visibleOnly:true` keeps visible DOM-walk nodes), **W-O3** ref-action guard
held (hover-revealed edit ref opened the intended item, not the first), and
the session/approval surface (`get_config` / named attached session /
`approve_actions`) all passed. **W-O4** passes with a wording caveat — the
test-attribute-worded query ranks the tier-1 feature tab #1, but a
*product-facing alias* phrase still ranks it behind its enclosing layout
containers. One non-blocker follow-on; no new blocker-class asks.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-P1** 🟡 | When the natural-language query targets a specific interactive control but uses an aliased / product-facing phrasing (rather than the test-attribute tokens), a non-interactive **structural/layout container** that merely *encloses* the target can outrank the actionable control itself — the agent gets the wrapper, not the button/tab. | Post-scoring ranking refinement (role-driven, generic — no app strings): when ≥1 `actionable:true` *interactive* candidate matches the query, **demote non-interactive container-ish matches** (group / region / toolbar / generic / none / landmark roles) below it. "Down-rank the container unless no actionable child matches" expressed structurally, not via query-string heuristics. Extends the W-J2 visibility partition / W-O4 ranking work; no agent JS. | **impl-done 2026-05-19** |

**Validated, no-op:** W-O1 / W-O2 / W-O3 confirmed fixed on the live authed
target; W-O4 confirmed working for test-attr-worded queries (alias-worded is
W-P1). `approve_actions` non-Claude BYOB path re-confirmed.

**Proposed sequence:** W-P1 (single ask).

## Round-15 asks (post-shipping, 2026-05-19 — non-Claude Phase-2.5 rerun)

Source: `docs/adoption-report-nonclaude-spa-phase25-2026-05-19.md` — a Codex
session drove an attached-CDP authed media SPA after the Phase-2.5
session/config changes. **Verdict: Phase 2.5 green.** `approve_actions`
closes the prior non-Claude BYOB `byob_action` deadlock (the 2026-05-15
report's biggest rough edge); named attached sessions + `get_config` +
`act_and_sample` all worked as a non-Claude consumer expects. Five
follow-ons, reframed to problem classes (app/transport specifics stripped):

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-O1** 🔴 | Every sink that returns *captured* page traffic — `ActionResult.network`, `network_read`, `ws_read`, `console_read` — emits URL material verbatim, including credential / identity-bearing query params and encoded context. A tool whose output is explicitly meant to be shareable (issue repros, adoption reports) and which is heading public in Phase 3 must not require manual redaction to be safe. | A **single centralized URL/string sanitizer** at the data-egress boundary, applied uniformly across the HTTP / WebSocket / SSE / console-string paths: scrub query params + encoded identity context, **preserve** method, host, path-pattern, status, timing, response shape. Default-on (a posture default, same discipline as safe-by-default / `network-body` off); not a per-call opt-in to forget. | **impl-done 2026-05-19** |
| **W-O2** 🟡 | Attached/BYOB sessions mis-compute the visible-rect for DOM-walk-sourced nodes: a visibly-rendered element reports `bbox:null` / `clipped:true` / `actionable:"off-screen"`. This makes the just-shipped `visibleOnly` (W-N5) **drop correct candidates** on an attached SPA — W-N5 is behaving correctly on a bad upstream signal. | In attached mode, fall back to a Playwright **locator bounding box** before classifying actionability; never classify a clickable node off-screen purely from a failed CDP rect. Fixes the root signal W-N5 depends on. | **impl-done 2026-05-19** |
| **W-O3** 🟡 | A `ref` whose actionability is known-bad (`bbox:null` / `off-screen`) can still dispatch and **act at the wrong visual location** — a hover-revealed overlay routes a high-stability ref click to a different visible item because a cached row/container box is trusted over the concrete element box. | When actionability is bad-but-still-clickable, **re-resolve and verify the concrete element's action point** before dispatch; prefer the element locator's own box over a cached container/row box for hover-revealed overlays. The main remaining mechanical-calibration correctness risk. | **impl-done 2026-05-19** |
| **W-O4** 🟡 | Icon-only / name-less controls rank below name-bearing neighbours even when a stable test-attr / aria-label / tooltip / selected-state disambiguates them — recurrence of the W-G4 icon-only theme. The discovery path already sees the nodes; scoring lacks tooltip + stable `data-*` context. | Scoring weights exact test-attr + aria-label + tooltip + neighbouring selected-state higher for name-less controls so a feature-panel query outranks unrelated top-nav tabs. Extends W-G4 / the icon-only scoreNode path; no agent JS. | **impl-done 2026-05-19** |
| **W-O5** 🟢 | Shared-CDP multi-client attach still mixes long-lived page helpers; stale-helper "Function … is not exposed" console errors are benign noise but look like target-app failures. | Doc-only: a short shared-CDP troubleshooting note kept near the site-docs integration docs; helper no-ops after disconnect where it can, else documented as benign unless capture/replay actually fails. | **impl-pending** |

**Validated, no-op:** `approve_actions` (W-G1) confirmed to close the
non-Claude BYOB blocker end-to-end; DOM-walk fallback (Phase-1.5) confirmed
load-bearing — it carried an a11y-empty target (0 interactive → 500 useful
DOM-walk entries).

**Proposed sequence:** W-O1 (security / public-bound, highest) → W-O2
(unblocks the just-shipped `visibleOnly` on attached) → W-O3 → W-O4 → W-O5.

## Round-14 asks (post-shipping, 2026-05-19 — multi-agent QA campaign)

Source: `docs/adoption-report-multiagent-qa-2026-05-19.md` — a team-lead-over-
sub-agents unattended campaign at scale. W-M1 confirmed existential. Five
follow-ons, reframed to problem classes; the arbitrary-JS posture is
preserved throughout (W-N1 reuses `sample`'s fixed-enum + `batch`'s tool
whitelist — no agent-supplied JS).

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-N1** 🔴 | A tool round trip is ~seconds, so `action` then a *separate* `read` lands **after** transient UI (spinner / pending button / in-flight counter) already resolved → the agent wrongly scores it "fine". Today: artisanal `eval_js`-that-acts-and-reads, or `sample`/`watch` blind to the action timing. | `act_and_sample({ action: {tool,args}, metric(s), durationMs, intervalMs\|everyFrame, summary? })` — start the **fixed-enum** sampler (W-J3), dispatch ONE whitelisted inner action concurrently (the `batch` whitelist; no nested batch / no `await_human` / no human-blocking / no self), inner tool's own capability gate + confirm hooks + W-M1 deadline all enforced, return `{ action, sample }`. No agent JS. Closes the state-capture-latency blind spot. | **impl-done 2026-05-19** |
| **W-N2** 🟡 | At multi-agent scale a wedged/killed agent strands sessions; per-id `close_session` is O(n) (≈6 calls/recovery). Memory pressure + orphaned state. | `close_sessions({ prefix?, all?, idleMs? })` — bulk teardown by id-prefix, or all, or idle-age (selectors AND; ≥1 required). Registry tracks `lastActivityAt` (touched on every `get()`). The team-lead reap primitive. | **impl-done 2026-05-19** |
| **W-N3** 🟡 | Dev-build overlays (devtools iframe, HMR widgets) intercept coordinate clicks; every agent hand-rolls iframe removal in `eval_js` each session. | `hideOverlaySelectors: string[]` config key (precedence; default `[]`). An init-script applied per navigation sets matching elements `pointer-events:none; display:none` (non-destructive; not `remove()`). Generic, config-driven, no agent JS. | **impl-done 2026-05-19** |
| **W-N4** 🟢 | Long high-rate `sample`/trace windows (300+ pts) balloon tool-result tokens; the agent almost always wants only the signal. | Auto-default `summary` (omit full `series`) when the projected point count is large (everyFrame + long window, or count over a threshold); explicit `summary:false` opts back into the full series. Tuning on W-K1. | **impl-done 2026-05-19** |
| **W-N5** 🟢 | `find()` returning only hidden/clipped candidates still misleads agents into coordinate fallbacks despite the W-J2 warning. | `find({ visibleOnly?: true })` — drop non-actionable candidates entirely (return empty + the W-J2 warning rather than confident hidden hits). Plus docs: prefer a deployed target over a dev tunnel (tunnel first-load >15s); `navigate`'s deadline is a soft signal, not a hard failure. | **impl-done 2026-05-19** |

**Affirmed, no-op:** keep W-M1 on-by-default at the 5s default (it is) —
the campaign calls this "existential, not nice-to-have".

**Sequence:** W-N1 → W-N2 → W-N3 → W-N4 → W-N5.

## Round-13 ask (post-shipping, 2026-05-18 — owner request: anti-wedge)

Source: owner — sub-agents run actions that become no-ops and the engine
stalls indefinitely with no timeout. Several paths have no ceiling at all
(`page.evaluate` / CDP `send` have no Playwright timeout; `await_human
timeoutMs:0` waits forever). Requirement: **0 unbounded waits** — a hard,
low default deadline, explicitly overridable up to 1 h max, with strong
deterrent messaging against large values.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-M1** 🔴 | Action no-ops / wedged page ops stall the engine forever — `eval_js`, scroll's window-`evaluate`, probe/snapshot CDP calls have no Playwright timeout; `await_human timeoutMs:0` is truly infinite. | `withDeadline(p, ms, label)` races every action body / `eval_js` / read-CDP path → structured `ok:false` "anti-wedge timeout" instead of a stall (can't cancel a hung CDP send, but the agent is unblocked). New `actionTimeoutMs` config key (**default 5000**, ConfigStore precedence, set via `set_config`) + per-call `timeoutMs` on `ACTION_OPTS`. Clamp **[1, 3_600_000]** (1 h hard max); over-ceiling clamps + warns. Schema text strongly deters large values. Playwright per-op timeouts derived from the effective deadline (inner self-abort + outer race). `await_human` `0`/unset → 5 min human-paced default, 1 h cap (kills the only infinite path; it's human-paced, not under the 5 s action default). `wait_for` default → action timeout, max → 1 h. `watch`/`sample`/`batch` unaffected (own bounded `durationMs` / per-inner-call deadlines). | **impl-done 2026-05-18** |

## Round-12 ask (post-shipping, 2026-05-18 — owner request)

Source: owner request — a managed/incognito knob to drop browser web
security (SOP/CORS off, any origin → any server) for QA against CORS-less
APIs / cross-origin assertions, without the BYOB `chrome start --insecure`
dance. A real posture change, so it's gated like `eval` / `network-body`.

| # | Problem class | Primitive | Status |
|---|---|---|---|
| **W-L1** 🟡 | The only way to get web-security-off today is the BYOB path (`browxai chrome start --insecure` + attach). browxai-launched `managed`/`incognito` sessions are safe-by-default with no opt-out, which blocks the common "hit a CORS-less API / make cross-origin assertions" QA pattern. | `disableWebSecurity` config flag (ConfigStore precedence; **not** an env var — deliberately excluded from the legacy `BROWX_*` layer so it can't be ambiently enabled). Default `false`. When true, `managed` + `incognito` launch with `--disable-web-security --disable-site-isolation-trials`. Loud warning **at server boot** *and* **per session launch** (mirrors `eval`/`network-body`/`chrome --insecure`). `attached`/BYOB unaffected (externally launched; whoever started it owns its flags). Resolved fresh per `open_session` so `set_config` takes effect without a restart. Documented in `docs/threat-model.md` as a config-level dangerous opt-in analogous to the `eval`/`byob-attach` posture. | **impl-done 2026-05-18** |

**Why a config flag, not a capability:** capabilities gate *tools*;
web-security-off is a *launch option*, not a tool. The consistent "properly
gated" shape is therefore an off-by-default config key with the same loud-
warning treatment `eval`/`network-body` get — plus exclusion from the env
layer so it's an explicit, auditable, MCP-or-file-only opt-in.

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
