# Adoption-run report: browxai non-Claude MCP client on target SPA

**Date:** 2026-05-15
**Adopter:** Codex session, model `gpt-5.5`
**Target app:** sanitized authed media SPA in a staging environment
**Driver-of-record:** `browxai-attached` MCP entry against a shared Chrome on loopback CDP, paired with site-docs `capture-auth --cdp`
**Scope:** calibrate two new site-docs flows end-to-end through the target feature panel, validate them headless, render, and package a handoff zip.

This is the non-Claude MCP client verification run for Phase 2. Codex drove browxai through the MCP tool surface, not through Claude-specific browser tooling.

## TL;DR

- **Verdict: gappy green.** Codex can consume browxai's MCP surface against a real authed SPA: `snapshot`, `find`, `await_human`, `start_recording`, action primitives, annotations, and `end_recording` all ran in one session and produced usable site-docs flow files.
- **The default BYOB action confirmation hook is the main non-Claude blocker.** In attached mode, `click` / `hover` / `press` wait for `window.__browx.confirm(true)`. Codex cannot answer that while the tool call is blocked, so plain action calls timed out until I supplied repeated CDP-side confirms. That is a canonical-loop blocker for Codex unless the MCP env disables `byob_action` or the tool exposes a first-class approval path.
- **The DOM-walk snapshot path is carrying the heavy-SPA case.** The a11y tree remained low-content, while the DOM walk exposed hundreds of test-attribute-bearing nodes and made flow authoring possible.
- **Recording is useful, but drafts need review.** `end_recording()` produced flow YAML with real locators and annotations; it also preserved failed exploratory actions, so the final flow files still needed hand cleanup.
- **Shared-CDP page bindings are fragile when multiple clients attach.** The browser console showed stale binding errors after one automation client disconnected, including missing `__browx_send` / `__siteDocs_capture` page functions. Capture and replay still succeeded, but this belongs in the site-docs integration notes.

## What worked

### `snapshot()` on a sparse a11y tree

The first attached snapshot saw a low-content a11y tree but a useful DOM projection:

```text
stats: {"a11yInteractive":0,"domWalkEntries":389,"domWalkNew":389,"domWalkCombined":0}
warning: low-content a11y tree ... DOM-walk fallback supplied 389 new node(s)
```

That made the target workable. The output surfaced stable rows such as:

```text
tab "Library" [data-testid="$library-tab-library"] [from-dom]
div [data-testid="mini-library"] [from-dom]
button [data-testid="side-panel-feature-tab"] [from-dom]
```

Later snapshots reached 500 entries with `[from-both]` markers once the editor was open. This is the right behavior for a legacy-heavy SPA.

### `find()` gave useful tier-1 hints

Concrete examples from the run:

| Query shape | Useful candidate | Hint | `actionable` |
|---|---|---|---|
| "Library tab in the mini library" | tab named `Library` | `[data-testid="$library-tab-library"]` | `"off-screen"` |
| "edit video button for the selected asset" | button named `edit` | `[data-testid="library-add-button-<asset-id>"]` | `"off-screen"` |
| "target feature tab button in right side panel" | correct side-panel tab, lower-ranked | `[data-testid="side-panel-feature-tab"]` | `"off-screen"` |

Even when actionability was wrong, the selector hints were good enough to build flow locators. The final site-docs flows use the discovered selectors plus `:visible` where lint asked for it.

### `await_human()` worked as the login checkpoint

Codex called:

```text
await_human({ kind: "acknowledge", prompt: "Please log into the target app...", timeoutMs: 600000 })
```

The operator completed SSO in the shared Chrome and acknowledged. The tool returned `{ timedOut: false }`, and site-docs then captured storage state from that same browser. This validates the human-in-loop primitive in a non-Claude client.

### Actions worked once BYOB confirmation was satisfied

With repeated `window.__browx.confirm(true)` signals sent through CDP, action tools completed and returned useful `ActionResult` envelopes:

- `hover` on a media asset revealed the edit affordance and reported changed container text.
- `click` on the edit button loaded the editor.
- `click` on the side-panel tab opened the target feature panel and returned network summaries plus element text.
- `click` on the language combobox opened the option list.

This proves the action implementation itself works in Codex. The issue is how the default confirmation gate is driven.

### Recording produced a usable calibration draft

`start_recording({ flowName: "..." })` and `end_recording()` emitted site-docs-flavored YAML with a `locators:` block and step annotations. The final files were rewritten for determinism, but the recorder still accelerated locator capture and preserved the intended callouts.

## What got in the way

### 🔴 BYOB action confirmation blocks Codex's canonical action loop

**Reproducer:**

```text
click({ ref: "<visible tab ref>" })
```

**Observed:** the tool call hung until the client-side tool timeout:

```text
timed out awaiting tools/call after 120s
```

Root cause: attached mode defaults `BROWX_CONFIRM_REQUIRED` to include `byob_action`; `confirmByobAction()` waits for a page-side `__browx.confirm(true)`. Codex cannot issue that confirmation while the `click` tool call is already blocking.

**Workaround used:** a separate CDP script sent repeated `window.__browx.confirm(true)` signals while Codex called action tools. That is not a clean MCP-only loop.

### 🟡 Shared-CDP binding lifecycle leaks console errors

**Reproducer:**

1. Attach site-docs `capture-auth --cdp` and browxai to the same long-lived tab.
2. Trigger the site-docs capture helper.
3. Let one Playwright client disconnect while the injected helper remains on the page.

**Observed:** browser console errors of this shape:

```text
Function "__browx_send" is not exposed
Function "__siteDocs_capture" is not exposed
```

Capture still completed and the session cache was valid. This is awkward but workaroundable; it should be documented for shared-CDP adopters because it looks alarming in the target console.

### 🟡 `find()` actionability reported visible elements as off-screen

**Reproducer:**

```text
find({ query: "Library tab in the mini library" })
```

**Observed:** the correct candidate was returned with a tier-1 selector, but:

```text
bbox: null
clipped: true
actionable: "off-screen"
```

The element was plainly visible in the screenshot, and `hover` / `click` worked after confirmation. This looks like the CDP-attached viewport/bbox path still diverges from what the actual page sees.

### 🟡 Ranking missed the intended side-panel tab on the first try

**Reproducer:**

```text
find({ query: "target feature tab button in right side panel" })
```

**Observed:** the top result was a neighboring icon tab; the intended tab appeared lower in the candidate list with a correct tier-1 hint. The workaround was to read the ranked list rather than blindly taking candidate 0.

This is not a blocker, but it matters for mechanical flow authoring where agents may be tempted to use the first candidate.

### 🟢 Recorder preserves failed exploratory actions

**Reproducer:**

1. Start recording.
2. Attempt a blocked action that times out.
3. Continue with a successful fallback.
4. End recording.

**Observed:** the draft YAML included placeholder steps for the failed exploratory actions, including untargeted `click` / `hover` entries. The draft was still useful, but not commit-ready without review.

## Concrete asks

1. **🔴 Add a Codex-safe approval path for `byob_action`.** Minimum shape: either make `browxai init` set `BROWX_CONFIRM_REQUIRED=navigate_off_allowlist` for attached calibration workspaces, or add a one-time session approval primitive that an MCP client can call before action tools. Implementation note: the current page-side confirm is fine for a human with DevTools open, but not for a synchronous MCP client blocked inside the action call.

2. **🟡 Harden shared-CDP binding cleanup.** Minimum shape: re-expose or invalidate page helpers cleanly when a Playwright client disconnects, so stale helpers do not throw missing-binding errors. Implementation note: include client/session identity in injected helpers or make helper calls no-op when their backing binding is gone.

3. **🟡 Fix attached-mode bbox/actionability for visible elements.** Minimum shape: `find()` should not return `bbox: null`, `clipped: true`, `actionable: "off-screen"` for elements visible in the attached Chrome viewport. Implementation note: audit the CDP viewport initialization and visible-rect calculation in BYOB sessions.

4. **🟡 Improve ranking for icon-only side-panel tabs.** Minimum shape: boost exact test-attribute value matches and title/tooltip-derived labels so the intended tab outranks neighboring icon tabs. Implementation note: the correct tier-1 candidate was present; scoring, not discovery, was the gap.

5. **🟢 Mark failed recorded actions in the draft YAML.** Minimum shape: annotate failed or timed-out recorded steps with `# FIXME: action failed during recording` or omit them by default. Implementation note: this keeps `end_recording()` drafts closer to handoff-ready while preserving useful forensic context.
