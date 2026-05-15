# Adoption-run report: browxai re-run on target-app (the target's vendor)

**Date:** 2026-05-15
**Adopter:** Claude Code session, model `claude-opus-4-7[1m]`
**Target app:** the target's vendor `target-app-2` — dev server in `/tmp/site-docs-app-run` on `https://localhost.target-app.example:3000`, authed via Azure AD SSO + pinned `<APP_AUTH_COOKIE>` cookie (workspace cache at `~/site-docs/target-app-2/.auth/editor.json`, captured fresh today via `capture-auth --cdp`, valid until 2026-06-14).
**Driver-of-record:** the agent-runbook in `automated-site-documentation-bot/docs/agent-runbook.md` (Step 4's "Discovery driver" paragraph naming browxai canonical + the dual-registration recipe).
**browxai version:** HEAD of `kalebteccom/browxai` at `afe2320` (`fix(engine): visible-rect bbox for halos; generalise example docs`). `browxai-attached` MCP entry, `BROWX_ATTACH_CDP=http://127.0.0.1:9222`, `BROWX_TEST_ATTRIBUTES=data-testid,data-type,data-test,data-cy,data-qa` (target-app's `data-type` second, behind `data-testid`).
**Scope of the run:** author **one** new site-docs flow file for the the feature area feature — Flow 3 "Edit Script Timing" — and exercise `find()` on its locators against the augmented (a11y + DOM-walk) snapshot. The six the feature area flows already calibrated in earlier rounds (`feature-1-empty-state`, `language-picker`, `generate-scripts`, `edit-script`, `delete-script`, `translate`, plus `target-app-landing`) live in `~/site-docs/target-app-2/flows/`.

This is the re-adoption run that 2026-05-13's report flagged as the headline Phase-1 exit criterion: `find()` exercised against the augmented snapshot post-`#7`/`#8`/`#10`/`#11`.

---

## TL;DR

- **`snapshot()` with DOM-walk fallback is the win this round.** target-app's a11y tree reports `a11yInteractive: 0` on every snapshot — the legacy-React / Reflux shape gives the walker nothing — and the DOM walk surfaces ~200–500 entries on its own with their `data-type` / `data-testid` annotations inline. The header's `stats:` block + low-content `warnings:` block tell that story unambiguously in the first 5 lines. This is what closed the round-1 hole.
- **`BROWX_TEST_ATTRIBUTES` ordering works exactly as documented.** Mixed-convention codebase (target-app uses `data-testid` on tabs/library cards and `data-type` on most editor controls + buttons); putting `data-testid` first and `data-type` second got the right hint on every element checked. First-match-wins semantics confirmed.
- **`ActionResult` continues to be the right shape.** `navigation.kind: "spa"` caught target-app's tab-switch URL rewrites; `element.stillAttached: false` cleanly reported the "Create recap script" button vanishing after the click (the round-6 annotation-target-on-vanished-element issue made explicit at the wire level); `network.summary` with the "requests omitted (count N > cap)" warning kept the wait-for-generation log readable when 300 XHRs fired.
- **`find()`'s ranking carried the easy cases — buttons with `data-testid` and an accessible name** — directly to tier-1 hints (mechanical transcription would have worked). It **didn't** carry inputs with only a `data-testid` and no role/name, even when the testid keyword was in the query verbatim. The escape hatch — reading the testid off the snapshot row and writing the locator by hand — still kept the flow-file authoring path entirely inside browxai's output; no Playwright-over-CDP fallback was needed.
- **Halt screenshots earned their keep.** Two halts this round (the start-time-input on script #1 was `disabled`; same on #2 — a real product fact the guide's prose was ambiguous about); `(halt screenshot: docs/<flow>/halts/<step>.png)` printed in the error message + the Playwright actionability log telling me `element is not enabled` made each diagnosis a 30-second read.
- **`wait_for`'s 120 s maxTimeout cap doesn't cover backend-async waits** common on dev-SPA targets. Generation needs ~3 minutes; I had to poll `wait_for` twice. The site-docs runtime's own `timeout_ms` is unbounded — the discovery-side ergonomic could match.
- **No-trace contract held.** `git -C "$APP_REPO" status` clean at teardown.

Net: **win**. Phase-1 exit criterion met from the adopter side — `find()` + `snapshot()` + the action primitives + halt-screenshots took me from "logged-in Chrome on :9222" to "8 flow files in the workspace, including the new one calibrated via browxai entirely". The remaining asks are small and tier-3/4-shaped, not structural blockers.

---

## What worked

### `snapshot()` post-`#7`/`#8`/`#10`/`#11` is doing the heavy lifting

First snapshot on the freshly-logged-in target-app tab:

```
stats: {"a11yInteractive":0,"domWalkEntries":206,"domWalkNew":206,"domWalkCombined":0}
warnings:
  - low-content a11y tree (0 interactive descendants under root); the DOM-walk fallback supplied 206 new node(s) (206 total candidates seen).
```

Every interactive node came in with `[from-dom]` and the right test-attribute annotation:

```
tab "Library" [ref=e16] [data-testid="$library-tab-library"] [from-dom]
button "settings" [ref=e12] [data-type="settings"] [from-dom]
div [ref=e205] [data-testid="right-toolbox-container"] [from-dom]
```

The `data-type`-only buttons (no `data-testid`) get `[data-type="…"]` on the row — `BROWX_TEST_ATTRIBUTES` order-sensitivity working as advertised. A subsequent snapshot after the editor opened showed `domWalkCombined: 500` (some elements were now in both the a11y tree's growing reachable set and the DOM walk → `[from-both]`); `domWalkNew: 0` because the DOM walk found nothing the a11y tree missed at that depth. Both signals are useful.

This is the round-1 "snapshot returned `RootWebArea` only" hole closed completely.

### `ActionResult` envelope held up across the full walk

- `navigation.kind: "spa"` correctly flagged the Library-tab click (`activeTab=pbp` → `activeTab=library` URL rewrite).
- `element.stillAttached: false` on the "Create recap script" click reported the empty-state → loader transition at the wire — the same UI transition that bit me in round 6 when the engine tried to position an annotation arrow on the vanished button. The ActionResult exposes it cleanly.
- Network summarisation worked: while generation ran, one `waitFor` round returned `network.summary: { total: 300, byType: { XHR: 291, Fetch: 7, other: 2 } }` with a `network.requests omitted (count 298 > cap 10); call network_read for details` warning — bounded, readable, drill-down explicit.
- `console.errors` correctly held the genuine signal — `GET /api/feature-area/scripts/<script-id> 200` on the editor-ready waitFor was the right "scripts loaded" marker — while not swallowing target-app's pre-existing React/MUI prop warnings (the `notched` / `endAdornment` / "uncontrolled-to-controlled" noise).

The shape is right. No new asks here.

### `find()` on the easy cases

Mechanical transcription works for buttons + accessible-named elements:

| query | top-ranked candidate | tier | hint |
|---|---|---|---|
| "the Library tab in the media browser" | `tab "Library" [ref=e16]` | 1 / high | `[data-testid="$library-tab-library"]` |
| "the Edit video pencil button on the the first asset asset" | `button "edit" [ref=e330]` | 1 / high | `[data-testid="library-add-button-<id>"]` |
| "the side-panel-feature-panel tab (the AI feature)" | `button [ref=e655]` | 1 / high | `[data-testid="side-panel-feature-panel-tab"]` |
| "the Create recap script button in the empty state" | `button "Create recap script" [ref=e761]` | 1 / high | `[data-type="generate-feature-panel-scripts-button"]` |

Each transcribed directly into the flow-file's `locators:` block — no manual re-selecting; the runbook's "that's the whole point" promise held for these.

### `BROWX_ATTACH_CDP` + dual-registration recipe

The `browxai-attached` MCP entry attached to the loopback-only :9222 Chrome without ceremony; both MCP servers stayed `✓ Connected` for the whole session. `site-docs capture-auth --cdp http://127.0.0.1:9222 --auth-cookie "<APP_AUTH_COOKIE>"` happily read the storageState off the same Chrome — one login, no second prompt. Cookie jar printed cleanly, expiry tracked against the named auth cookie (`expires 2026-06-14`, ~720 h). Phase-1 `#1`/`#3`/`#9` working as a unit.

### Halt screenshots + step-id-bearing error messages

Two genuine product / flow halts this round, both diagnosable from the halt screenshot alone:

1. `fill` on `[data-testid="app-common-time-input-seconds"]` (first script) → halt at `docs/feature-9-edit-timing/halts/edit-…/png`. The Playwright actionability log resolved to `<input disabled ... value="00" ...>` — the input *is* disabled, not just "not found". Real product fact (start times are clip-driven, locked at the input level).
2. Same for the second script (`value="11" disabled`). Confirmed it's not a per-script edge — *all* start-time inputs are disabled.

The error format — `step "X" (action) failed at <url>: page.fill: ... \n - locator resolved to <... disabled ...> \n (halt screenshot: docs/<flow>/halts/<step>.png)` — is what round 6 asked for and it lands the diagnosis instantly.

### No-trace contract

After teardown (worktree removed, branch deleted, dev server stopped, `/tmp/site-docs-chrome` cleared), `git -C "$APP_REPO" status` is clean. `BROWX_WORKSPACE=~/.browxai` (global location, not under the per-app workspace as the runbook *suggests* — see "What got in the way" below) — and that's outside the consumer repo either way, so the contract holds.

### Replay determinism

`site-docs run --flow feature-9-edit-timing` against the cached storageState (headless Chromium, not the `--cdp` Chrome) replayed the whole `extends: feature-3-generate-scripts` chain — open-editor preamble → generate-scripts (3 min) → edit-timing step — clean, exit 0, screenshot landed. browxai's role ended at calibration; site-docs's execution path didn't depend on browxai at all. That separation worked as designed.

---

## What got in the way

### `find()` doesn't rank `<input>`-class elements even with verbatim testid in the query

Query: `"the seconds sub-input of the first script line's start-time control (app-common-time-input-seconds inside feature-panel-start-time-input)"` — the exact testid string is in the query.

Top-5 results:

```
[ref=e44]  button "page_infoFiltersarrow_drop_down"    tier 1   filters-multi-select-menu-button
[ref=e235] button "Transcripts"                         tier 2
[ref=e800] button "delete_sweep"                        tier 1   clear-all-textual-scripts--items-button
[ref=e801] button "download"                            tier 1   download-all-textual-scripts-button
[ref=e802] button "upload"                              tier 1   download-all-textual-scripts-button
```

The element I wanted (`<input value="00" data-testid="app-common-time-input-seconds">`) is **in the snapshot** (I read it off the row when I gave up on find), but `find()` never surfaced it — even on a re-query that named the testid explicitly: `"input element with testid app-common-time-input-seconds"` → same shape of irrelevant buttons.

The likely cause: find()'s scoring weights `role` + `name` overlap heavily; a `<input>` without an `aria-label` (just a placeholder/value of "00" and a class) doesn't have anything to score against. The testid string appears in the candidate's annotation but doesn't appear to be a scoring source.

The workaround was free — read the testid off the snapshot row, transcribe by hand — and the snapshot itself surfaced the right element via the DOM walk. So this didn't block the flow-file or push me outside browxai's output. But mechanical-transcription is what the runbook wants flow-authoring to feel like; on this element it didn't.

### `selectorHint` doesn't carry `:visible` / nth-match disambiguation when the same testid matches hidden duplicates

`[data-type="generate-feature-panel-scripts-button"]` on target-app is duplicated — there's a visible button + a hidden DOM sibling. `find()` correctly returned the visible one via `[ref=e761]` (the snapshot's interaction filter picked the right one), but the **emitted `selectorHint` is the bare** `[data-type="generate-feature-panel-scripts-button"]`. A flow-author transcribing mechanically into a flow-file (which is resolved later by Playwright's strict locator) would re-introduce the round-6 hidden-duplicate `boundingBox` hang.

This bit me in round 6 (cost me ~30 minutes of repeated 30-second timeouts to diagnose). I had a `:visible`-scoped locator in the existing flow that I kept; today's calibration didn't need to re-discover it, so the issue was latent here — but the next adoption on a heavy-SPA target will hit it again.

### `wait_for.timeoutMs` caps at 120 000 ms; backend-async waits routinely exceed that

Script generation on target-app is a ~3-minute backend op. My first `wait_for([data-testid="feature-panel-editor-container"], timeoutMs: 120000)` timed out — generation wasn't done. Polled a second time, succeeded.

This is fine as a workaround (browxai's idle-during-wait is cheap), but compare with site-docs's own flow `wait_for.timeout_ms`, which is unbounded — my existing `feature-3-generate-scripts.flow.yaml` uses `1_500_000` (25 min). The site-docs runtime's hard primitive is more permissive than the calibration-side one.

### `bbox: null + clipped: true` on plainly-visible elements

Every `find()` candidate this round came back with `bbox: null, clipped: true` — including the Library tab, the the AI feature tab button, the Create recap script button (all visibly *in* the Chrome window the user is logged into). The runtime side of bbox (the engine's annotation halo placement) is byte-correct (verified by the rendered annotations in `docs/feature-*/annotations.json` — bboxes were populated, e.g. `{x: 935, y: 210, width: 51, height: 42}` for the the AI feature tab). So the bug is *only* in the discovery-side path when attached over CDP — likely the attached page reports no viewport size.

Doesn't block calibration: `selectorHint` is what gets transcribed; bbox is only "evidence". But the round-2 ask #5 says "byte-for-byte parity with site-docs's runtime" — that parity isn't holding on the BYOB path. Phase-1.5 polish if `bbox` ever becomes load-bearing for the agent (e.g. an annotation arrow preview, an a11y region click).

### Naming nuance: `stability: "high"` ≠ "stable across deploys"

`find("the the first asset asset card")` returned `[data-testid="library-asset-container-<id>"]` with `stability: "high"`. That's true *for the snapshot at hand* (it's a unique disambiguator); it's misleading for a flow-file that needs to survive content-rotation: the asset ID is **content-keyed** (a new game-highlight tomorrow gets a new ID). A long-lived flow file wants something like `[data-testid^="library-asset-container-"]:has-text("Sample Asset A")` instead.

This is the agent's responsibility (I upgraded it during transcription), but it's worth naming in the tool docs. A surface like `stabilityKind: "structural" | "content-keyed"` — or just a sentence in `tool-reference.md` distinguishing per-snapshot uniqueness from per-deploy durability — would make the responsibility explicit.

### Minor / non-blocking

- `BROWX_WORKSPACE` is `~/.browxai` (global) in this session's MCP env block; the runbook's example suggests `<workspace>/.browxai` (per-app). Functionally equivalent (both outside the consumer repo), and changing it mid-session would need an MCP-server restart that'd lose the conversation. Not a real ask — just noting the deviation.
- find()'s query keywords have to overlap with the element's surfaced text (accessible name *or* test-attribute value). Icon-only side-panel tabs with `title="the AI feature"` aren't matched by "brain/voice icon" queries; rephrasing to "side-panel-feature-panel" hit. Worth a "queries are matched against accessible name + test-attribute values" line in the tool docs.

---

## Concrete asks, in priority order

### 🟡 1. Raise `wait_for.timeoutMs` cap to match backend-async patterns

`maximum: 120000` in the schema is too low for SPAs with multi-minute backend ops (generation / translation / TTS — all common shapes). Suggestions, any:

- Raise to `600000` (10 min) — covers the long end of single-op waits without enabling indefinite hangs.
- Or add a `pollIntervalMs` so the agent can compose: `wait_for` becomes a single primitive that polls internally to a higher cap.
- Or document the polling idiom explicitly in `tool-reference.md` so adopters know to chain.

**Why:** every long-async flow needs a polling escape hatch today. site-docs's own `timeout_ms` is unbounded; the discovery-side ergonomic should at least match the runtime's tolerance band.

**Shape:** schema-only change, no semantic risk.

### 🟡 2. `selectorHint` should emit `:visible` (or `nth-match`) when the bare hint matches multiple DOM nodes

When `find()` returns ref `eN` (the visible one) but the bare `selectorHint` matches multiple DOM nodes (e.g., `[data-type="x"]` with a hidden duplicate), the emitted hint should disambiguate:

- `[data-type="x"]:visible` — Playwright's `:visible` engine is well-known.
- `:nth-match([data-type="x"], 1)` — Playwright-native, positional.
- `[data-type="x"][stable-only-attr="…"]` — if there's a further disambiguator on the element.

**Why:** mechanical transcription into a flow file otherwise re-introduces the round-6 hidden-duplicate `boundingBox` hang the runbook's "Locator gotchas" paragraph already documents. The engine already *knows* the bare hint is ambiguous (it filtered to one via the snapshot's interaction-filter); folding that knowledge into the hint closes the loop.

**Shape:** detect duplicate-selector-singleton-match inside find(), append qualifier. Probably ~20 lines.

### 🟡 3. `find()` scoring should weight test-attribute string matches more heavily, especially for `<input>` / non-button elements

The exact testid string in a query failed to surface the `<input data-testid="app-common-time-input-seconds">` element this round, twice. Heuristic options:

- Score test-attribute value matches independently of `role` / `name` matches (currently they don't seem to contribute).
- Or boost when `role == "input"` AND the test-attribute value matches a query keyword.
- Or emit a `warnings: ["no candidate scored confidently"]` block on the find() result when no top-3 candidate's score exceeded some floor — gives the agent a clear "fall through to snapshot" signal.

**Why:** this is the gap between "find() ranked the wrong elements but I still found mine off the snapshot row" (today) and "find() gave me the locator I asked for" (the runbook's promise). The escape hatch works but it's exactly the manual selectorHint-discovery the canonical path is supposed to replace.

**Shape:** scoring change in find(); probably needs a few iterations + tests.

### 🟢 4. CDP-attached snapshot/find: `bbox` should reflect the attached page's actual viewport (not null when fully visible)

The runtime-side bbox (site-docs annotation halo) is correct; the discovery-side bbox is `null + clipped: true` for every element. Probably a viewport-not-set on the CDP-attached `BrowserContext`. Set a default viewport on attach, or read it off `Page.viewportSize()` and pass through to `getBoundingClientRect`'s viewport-intersect step.

**Why:** Phase-1.5 ask #5 promises byte-for-byte parity with site-docs runtime bbox. That parity holds for managed mode; not for BYOB. Low-priority because bbox isn't load-bearing for calibration — but if any future agent surface uses it (annotation preview, hit-test pick), this would silently break.

**Shape:** small — viewport plumbing in `src/session/byob.ts` (or wherever the attach context is created).

### 🟢 5. Documentation nit: `stability` semantics + `find()` query-matching surface

In `tool-reference.md` (or `phase-1-design.md` §7):

- Add a paragraph distinguishing "high stability" (disambiguator on this snapshot) from "deploy stability" (locator that survives content/test-attr rotation). Or surface `stabilityKind: "structural" | "content-keyed"` on the find result, computed by inspecting whether the testid value looks numeric / UUID-like.
- Add a line on how `find()` matches: against `name` (accessible name) + `role` + test-attribute *values*. Adopters who write queries like "brain/voice icon" for icon-only tabs without these textual surfaces get blanks; the doc should set that expectation.

**Why:** prevents the same hour-of-confusion this round (twice) for the next adopter.

**Shape:** docs-only.

---

## Out of scope / not asks

- `await_human` wasn't exercised this round — the round-1 SSO use-case stayed the same (loop-back Chrome, manual login, no `await_human` needed because the login happens in the user's session before `capture-auth` is called). Still the right primitive when invoked.
- `screenshot` not exercised — the action primitives' `mode: "scoped_snapshot" | "tree_diff" | "full" | "none"` already covers post-action UI inspection; I never needed a standalone screenshot during this walk.
- `consoleRead` / `networkRead` not exercised standalone — the `ActionResult.console` / `.network` per-action slices were enough.
- The deferred Phase-1.5 polish items (`snapshotDelta.scope`, `tree_diff` mode, `await_human` non-`acknowledge` kinds, session-wide buffered `network_read`, tier-3/4 `selectorHint`, auto-default `BROWX_ATTACH_CDP`, no-trace CI test, headless-CI exercise) didn't come up — none would have changed today's outcome.

---

## Closing

This run is the headline Phase-1 exit criterion met from the adopter side: one fresh the feature area flow calibrated end-to-end through `browxai-attached`, replayed cleanly via `site-docs run`, no-trace contract intact. The augmented snapshot (a11y + DOM-walk + `BROWX_TEST_ATTRIBUTES`) does on the Reflux/legacy-React shape what the round-1 a11y-tree-only path couldn't. `find()` is the workflow's main rough edge — easy on buttons, blunt on inputs. The three 🟡 asks above are small surgical changes, not architectural concerns.
