# Adoption-run report: post-fix Codex revalidation

**Date:** 2026-05-19
**Adopter:** Codex session
**Target app:** sanitized authed media SPA in a test environment
**Driver-of-record:** `browxai-attached` MCP entry against a shared Chrome on loopback CDP, paired with site-docs replay.
**Scope:** verify fixes shipped after the prior Codex adoption report, then convert the consumer flows from a permissive selector workaround to site-docs `optional: true`.

## TL;DR

- **Verdict: green, with one ranking caveat.** Four of five browxai fixes held cleanly on the real authed target. The feature-tab query is good with the internal feature wording and acceptable with the user-facing wording, but the alias case still is not candidate 1.
- **URL redaction is materially better.** `network_read`, `ws_read`, `console_read`, and `ActionResult.network` no longer exposed credential-bearing query strings or encoded identity context; host/path/status/timing stayed useful.
- **Attached-mode actionability is fixed for visible DOM-walk nodes.** `visibleOnly:true` preserved visible candidates, and candidates carried non-null `bbox`, `clipped:false`, and `actionable:true`.
- **The ref-action guard held.** A hover-revealed edit control resolved as the top visible candidate and the ref click opened the intended visual item, not the first visible item in the list.
- **The site-docs consumer workaround is gone.** Both flows now use `optional: true` for the conditionally-present confirmation step and passed both present-modal and absent-modal branches.

## What Worked

### Ask 1: URL redaction

**Verdict:** pass.

**Tool calls:**

```text
console_read({ session:"reval", limit:10 })
network_read({ session:"reval", limit:10 })
ws_read({ session:"reval", limit:10 })
click({ session:"reval", ref:"<library-tab-ref>", mode:"none" })
```

**Observed output shape:**

```text
console_read:
  "[vendor] Opening stream connection to https://realtime.example/eval/:id/:id"
  "browx-redaction-check https://example.invalid/realtime?…"

network_read:
  { method:"POST", url:"https://telemetry.example/s/?…", status:200, type:"Fetch", ms:525 }
  { method:"GET", url:"https://realtime.example/eval/:id/:id", status:200, type:"EventSource", ms:367 }

ws_read:
  { url:"", dir:"sent", kind:"ws", payload:"{\"current_page\":\"https://app.example/path?…\"}" }
  { url:"https://realtime.example/eval/:id/:id", dir:"recv", kind:"sse", event:"put", payload:"{}" }

ActionResult.network:
  { method:"POST", url:"https://errors.example/api/:id/envelope/?…", status:200, type:"Fetch", ms:52 }
  { method:"POST", url:"https://events.example/events/bulk/:id", status:202, type:"XHR", ms:121 }
```

Credential-like query parameters and encoded identity blobs were scrubbed. Host/path shape, request method, status, timing, and request type remained available for debugging.

### Ask 2: attached bbox/actionability

**Verdict:** pass.

**Tool call:**

```text
find({
  session:"reval",
  query:"the visible Library tab in the mini library tabs",
  visibleOnly:true,
  maxCandidates:6
})
```

**Observed output shape:**

```text
candidates[0]:
  selectorHint: "[data-testid=\"mini-library\"]"
  stability: "high"
  bbox: { x:65, y:0, width:494.49, height:888 }
  clipped: false
  actionable: true

candidates[2]:
  selectorHint: "[data-testid=\"<library-tab>\"]"
  stability: "high"
  bbox: { x:84.79, y:7.19, width:59.21, height:36 }
  clipped: false
  actionable: true
warnings: []
```

This directly fixes the prior failure where visible DOM-walk nodes were dropped by `visibleOnly:true` and reported `bbox:null`, `clipped:true`, `actionable:"off-screen"`.

### Ask 3: ref-action guard

**Verdict:** pass.

**Tool calls:**

```text
hover({ session:"reval", ref:"<target-media-row-ref>" })
find({ session:"reval", query:"edit button on the hovered library media row", visibleOnly:true })
click({ session:"reval", ref:"<returned-edit-button-ref>" })
click({ session:"reval", selector:"button:has-text(\"OK\")" })
wait_for({ session:"reval", selector:"[data-testid=\"<feature-tab>\"]", timeoutMs:60000 })
```

**Observed output shape:**

```text
find top candidate:
  role: "button"
  name: "edit"
  selectorHint: "[data-testid=\"library-add-button-<asset-id>\"]"
  stability: "high"
  bbox: { x:128.43, y:623.94, width:28.79, height:28.79 }
  clipped: false
  actionable: true
  score: 9

post-click verification:
  wait_for ok: true
  editor duration matched the clicked row duration
```

The prior wrong-item behavior did not reproduce. The top hover-revealed edit candidate had a real box, and the ref click opened the intended media item after the confirmation step.

### Ask 4: icon-tab ranking

**Verdict:** pass with wording caveat.

**Tool call that passed cleanly:**

```text
find({
  session:"reval",
  query:"audio recap side panel tab",
  visibleOnly:true,
  maxCandidates:6
})
```

**Observed output shape:**

```text
candidates[0]:
  role: "button"
  selectorHint: "[data-testid=\"<feature-tab>\"]"
  selectorTier: 1
  stability: "high"
  bbox: { x:1205, y:210, width:51, height:42.2 }
  clipped: false
  actionable: true
  score: 17
```

The looser user-facing phrase also returned the correct tier-1 feature-tab candidate, but at rank 4 behind the enclosing right-toolbox containers and a neighboring tab. That is enough for supervised calibration, but still not ideal for a fully mechanical agent using only the product-facing label.

### Ask 5: session and approval surface

**Verdict:** pass.

**Tool calls:**

```text
get_config({})
open_session({ session:"reval", mode:"attached" })
approve_actions({ scopes:["byob_action"], ttlSeconds:1800 })
click({ session:"reval", ref:"<tab-ref>" })
hover({ session:"reval", ref:"<media-row-ref>" })
list_approvals()
```

**Observed output shape:**

```text
get_config:
  testAttributes: ["data-testid","data-type","data-test","data-cy","data-qa"]
  confirmRequired: ["navigate_off_allowlist","byob_action"]

list_approvals:
  { scope:"byob_action", uses:5, remainingMs:<positive> }
```

No DevTools-side confirm was needed. The named attached session stayed explicit across browser calls, and the pre-approval grant recorded consumed uses.

## What Got In The Way

### 🟡 User-facing feature aliases still rank below structural containers

**Reproducer:**

```text
find({
  session:"reval",
  query:"AI feature panel tab in the right side tool rail",
  visibleOnly:true,
  maxCandidates:8
})
```

**Observed:** the intended tier-1 feature-tab candidate appeared at rank 4 with `actionable:true`, while the enclosing toolbox containers ranked first. The internal feature wording ranked the intended tab first.

This is not a blocker for supervised calibration, but it leaves one quality gap for natural-language-only agents: visible containers can still outrank a specific icon tab when the query uses the product-facing alias rather than the test-attribute wording.

## Site-Docs Consumer Check

The two consumer flows were refactored from a permissive comma selector to the first-class optional-step primitive:

```text
confirm_open_video_ok: 'button:has-text("OK")'

- id: confirm-open-video
  action: click
  target: $confirm_open_video_ok
  optional: true
  wait_for: { selector: $feature_tab, timeout_ms: 60000 }
```

Validation:

```text
attached-CDP, modal present:
  flow A: passed
  flow B: passed

headless, modal absent:
  runFlow: optional step "confirm-open-video" (click) skipped — page.click: Timeout 30000ms exceeded.
  flow A: passed
  flow B: passed

static checks:
  lint: clean
  flow-tree: clean
  style --check: clean
```

The temporary absent-modal check removed only an operator-local draft key from the auth cache, ran headless, then restored the cache. No target source tree files were touched.

## Concrete Asks

1. **🟡 Improve alias-aware ranking for icon-only feature tabs.** Minimum shape: product-facing feature aliases should boost the corresponding `data-testid` or tooltip-backed tab above enclosing layout containers. Implementation note: when a query includes "tab" and "right side/tool rail", down-rank container nodes unless no actionable child matches.

No new blocker-class asks surfaced in this rerun.
