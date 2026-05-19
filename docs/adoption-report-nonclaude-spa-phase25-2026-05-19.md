# Adoption-run report: browxai Phase 2.5 Codex rerun

**Date:** 2026-05-19
**Adopter:** Codex session
**Target app:** sanitized authed media SPA in a staging environment
**Driver-of-record:** `browxai-attached` MCP entry against a shared Chrome on loopback CDP, paired with site-docs replay.
**Scope:** rerun the prior non-Claude target flow after the Phase 2.5 session/config changes, validate the existing two site-docs flows in attached and headless modes, refresh the handoff zip, and record new adoption findings.

This is not the remaining Phase-2 headless-CI keystone. It is a focused Phase 2.5 adoption rerun through the same kind of real authed SPA that produced the original Codex report.

## TL;DR

- **Verdict: Phase 2.5 green with two material new asks.** Codex can now drive an attached browser with a named session and MCP-side pre-approval; the prior `byob_action` deadlock is closed for this consumer shape.
- **The new session/config surface worked.** `get_config`, `open_session({ mode:"attached" })`, `list_sessions`, `approve_actions`, and `list_approvals` all behaved as expected in one Codex session.
- **The existing two site-docs flows replayed cleanly after a small state-tolerance patch.** The target sometimes shows an "open video" confirmation modal and sometimes does not; the flow files now handle both branches and pass attached-CDP and fresh headless replay.
- **The DOM-walk path still carries this target.** The a11y tree exposed no interactive descendants, while the DOM walk supplied hundreds of useful `data-*` entries.
- **New blocker-class risk for public-bound reporting: network and console surfaces leak credential or identity-bearing URLs verbatim.** The run stayed private, but public docs and logs need redaction before those fields are safe to quote.

## What Worked

### MCP-driven config made the session self-describing

`get_config({})` returned the merged config the MCP server was actually using:

```text
testAttributes: ["data-testid", "data-type", "data-test", "data-cy", "data-qa"]
capabilities: ["read", "navigation", "action", "human", "eval"]
confirmRequired: ["navigate_off_allowlist", "byob_action"]
disableWebSecurity: true
```

That was clearer than relying on shell-side `doctor` output alone: `doctor` reported default test attributes outside the MCP env, while `get_config` showed the attached server had the target-specific `data-type` convention.

### Named attached sessions worked

`open_session({ session:"report-2026-05-19", mode:"attached" })` attached to the shared Chrome and `list_sessions()` reported the named session, mode, current URL, and page count. Every later browser tool call used the explicit `session` id, so there was no implicit global "active page" to coordinate.

### `approve_actions` closes the prior Codex BYOB blocker

Before the walk:

```text
approve_actions({ scopes:["byob_action"], ttlSeconds:1800 })
```

After the walk, `list_approvals()` showed the same grant with four consumed uses. Codex drove `click`, `hover`, `wait_for`, and `act_and_sample` without a DevTools-side `__browx.confirm(true)` helper. This directly resolves the biggest rough edge from the 2026-05-15 report for non-Claude MCP clients.

### DOM-walk snapshots remained useful on a sparse a11y tree

The initial snapshot against the target panel reported:

```text
stats: {"a11yInteractive":0,"domWalkEntries":232,"domWalkNew":232,"domWalkCombined":0}
warning: low-content a11y tree ... DOM-walk fallback supplied 232 new node(s)
```

Later snapshots reached 500 DOM-walk entries after the editor loaded. The output exposed stable controls such as a library tab, a media-library container, side-panel controls, timeline controls, and data-attribute-backed filters. Without the DOM walk, this target would still be mostly opaque.

### Action and sampling tools composed cleanly

`act_and_sample` wrapped a tab click and captured a scroll metric through the transition:

```text
action: click({ ref:"<library-tab-ref>" })
navigation.kind: "spa"
sample.metric: "scrollTop"
sample.summary.distinctCount: 1
```

The action result included navigation, console, network, element, and sampling data in one response. This is the right shape for a non-Claude consumer that wants to drive and inspect without issuing a second read after the transition.

### The recorder still produced usable draft flow YAML

`start_recording()` / `end_recording()` emitted a six-step site-docs-flavored draft with a `locators:` block and selector-derived action targets. The draft was not committed, but it was useful as a calibration trace and reflected the successful branch of the walk.

## What Got In The Way

### 🟡 Network and console output expose sensitive URLs verbatim

**Reproducer:**

```text
click({ ref:"<visible-tab-ref>", mode:"scoped_snapshot" })
wait_for({ selector:"<feature-tab-selector>", timeoutMs:60000 })
console_read({ limit:20 })
```

**Observed:** `ActionResult.network.wsFrames[].url` included full realtime connection URLs with credential-bearing query parameters. `console_read()` also returned long third-party stream URLs containing identity-bearing encoded context. These values are not safe to paste into a public-bound report without manual redaction.

This did not block the browser loop, but it is the highest-risk adoption finding from this rerun because browxai reports and issue reproducers are intended to be shareable.

### 🟡 Attached-mode `find()` still marks visible elements as off-screen

**Reproducer:**

```text
find({ query:"the Library tab in the mini library tabs", visibleOnly:true })
```

**Observed:**

```text
candidates: []
warning: "no visible candidate — all 6 match(es) are off-screen / clipped / covered"
```

Without `visibleOnly`, the correct tier-1 candidate was present:

```text
selectorHint: "[data-testid=\"...\"]"
stability: "high"
bbox: null
clipped: true
actionable: "off-screen"
```

The element was visibly on screen in the screenshot and the subsequent click succeeded. The bad actionability signal is still workaroundable, but it makes `visibleOnly:true` unusable on this attached SPA.

### 🟡 A null-bbox hover overlay could route a ref click to the wrong visible item

**Reproducer:**

```text
hover({ ref:"<target-media-row-ref>" })
find({ query:"edit button on the hovered library asset" })
click({ ref:"<returned-edit-button-ref>" })
```

**Observed:** `find()` returned the intended high-stability edit button hint, but with `bbox:null` / `actionable:"off-screen"`. The click completed, yet the editor opened a different visible media item. The final site-docs files avoid trusting that ref path and use a selector-driven branch instead.

This is the main remaining mechanical-calibration risk: a correct-looking ref can still act at the wrong visual location when the visible-rect calculation fails.

### 🟡 Icon-only side-panel ranking is still weak

**Reproducer:**

```text
find({ query:"AI feature side panel tab", maxCandidates:5 })
```

**Observed:** the candidate list prioritized unrelated library tabs and neighboring icon buttons. The desired target was discoverable through snapshot/test-attribute reading and direct selector use, but the natural-language query did not rank it near the top.

The workaround is acceptable for a human-supervised calibration pass, but a more mechanical agent would likely click the wrong candidate.

### 🟢 Shared-CDP page-binding errors are still worth documenting for site-docs consumers

The prior run surfaced console errors shaped like:

```text
Function "__browx_send" is not exposed
Function "__siteDocs_capture" is not exposed
```

They did not recur as the primary failure in this rerun, but the shared-CDP setup still mixes long-lived page helpers from multiple clients. Given the new console/network redaction issue above, these helper lifecycle errors should stay in the site-docs integration notes rather than being treated as target-app failures.

## Concrete Asks

1. **🟡 Redact sensitive URL fields before returning network or console data.** Minimum shape: scrub query parameters and encoded identity context from `ActionResult.network`, `network_read`, `ws_read`, and `console_read` while preserving method, host, path pattern, status, timing, and response shape. Implementation note: centralize URL redaction so HTTP, WebSocket, SSE, and console-string paths use the same sanitizer.

2. **🟡 Fix attached-mode visible-rect/actionability for DOM-walk nodes.** Minimum shape: a visibly rendered DOM-walk node in an attached Chrome should not report `bbox:null`, `clipped:true`, and `actionable:"off-screen"`, and `visibleOnly:true` should not drop it. Implementation note: audit the attached-session viewport/clip calculation and fall back to Playwright locator bounding boxes before classifying candidates.

3. **🟡 Guard ref actions when actionability is known-bad.** Minimum shape: if a `ref` has `bbox:null` or `actionable:"off-screen"` but is still clickable through Playwright, re-resolve and verify the action point before dispatching. Implementation note: for hover-revealed overlays, prefer the concrete element locator's box over a cached row/container box.

4. **🟡 Improve ranking for icon-only side-panel controls.** Minimum shape: exact test-attribute matches, aria labels, tooltips, and neighboring selected-state text should outrank unrelated top-nav tabs for feature-panel queries. Implementation note: the discovery path already sees the nodes; scoring needs more context from tooltips and stable `data-*` names.

5. **🟢 Keep shared-CDP binding lifecycle notes close to site-docs docs.** Minimum shape: a short troubleshooting note that stale page helpers can produce missing-binding console errors when multiple Playwright clients attach to one tab. Implementation note: if the helper can no-op after disconnect, do that; otherwise document it as benign unless capture/replay actually fails.
