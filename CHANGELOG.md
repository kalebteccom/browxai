# Changelog

All notable changes to browxai are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and browxai adheres to
[semantic versioning](https://semver.org/) — see the
[Stability & semver](docs/tool-reference.md) policy for what "the stable
surface" covers.

## Unreleased

### Added

- **Tooling baseline + OIDC release pipeline.** ESLint flat config,
  Prettier, depcheck, lockfile-lint, `.editorconfig`, `.npmignore`,
  `.npmrc`, repo `.githooks/` (commit-msg + pre-commit), Dependabot config
  with allowlisted auto-merge, `quality.yml` CI workflow (typecheck, lint,
  format-check, depcheck, lockfile-lint), and an OIDC-trusted-publisher
  `release.yml` workflow plus a package-contents audit script.
- **Public-flip governance docs.** Top-level `CODE_OF_CONDUCT.md`,
  `CONTRIBUTING.md`, `MAINTAINERS.md`, `RELEASING.md`, `SECURITY.md`,
  `THIRD_PARTY_NOTICES.md`; per-plugin MIT `LICENSE` files; supporting
  governance docs (`plugin-governance.md`, `public-flip-checklist.md`,
  `security-best-practices-for-adopters.md`).
- **`AGENTS.md` + ai-context + multi-harness pointers.** Root `AGENTS.md`
  operating rules; cross-harness `.agents/skills/` source of truth with
  eight expert-agent definitions mirrored into `.claude/agents/` and
  `.codex/agents/`; `docs/ai-context/` tree covering architecture,
  agent-process, page-side-functions, plugin-runtime, recorder-and-replay,
  release-process, investigations, and adopter reports.

### Changed

- VitePress publish surface excludes `ai-context/**` and `rfcs/**` —
  internal docs stay in-repo without leaking into the published site.

## v0.7.0 — 2026-06-08 — Canvas substrate + canvas plugins + perf optimization module

v0.7.0 is the final v0.x release; v1.0 launches with the public flip per the standing roadmap.

### Added

- **First-party canvas-app adapter plugins.** Three Kalebtec plugins
  demonstrating that the plugin runtime + the canvas substrate compose
  into a real ecosystem story. Each declares capabilities `eval` +
  `canvas`, routes every tool through `api.callTool("eval_js", {expr})`,
  and returns a structured `code:"<adapter>-not-loaded"` envelope when
  the host app isn't on the page. Resolved via
  `canvas_query({adapter, op, args})` from the canvas-substrate
  dispatcher.
  - **`@kalebtec/browxai-plugin-figma`** — namespace `figma`; surfaces
    `figma.get_selection`, `figma.get_viewport`, `figma.select_node`,
    `figma.move_node`, `figma.create_rectangle` over the page-side
    `figma.*` global (selection, viewport, node mutate, rectangle
    create).
  - **`@kalebtec/browxai-plugin-tldraw`** — namespace `tldraw`;
    surfaces `tldraw.get_selected_shapes`, `tldraw.get_viewport`,
    `tldraw.create_shape`, `tldraw.delete_shape`, `tldraw.select_shapes`
    over Tldraw's `window.editor` global.
  - **`@kalebtec/browxai-plugin-excalidraw`** — namespace `excalidraw`;
    surfaces `excalidraw.get_scene_state`, `excalidraw.get_viewport`,
    `excalidraw.add_element`, `excalidraw.delete_element`,
    `excalidraw.set_scroll` over the host-page `window.excalidrawAPI`
    ref.

- **Canvas-app automation core.** Five MCP tools + a pure-RGBA diff under
  the new off-by-default `canvas` capability — the generic,
  app-agnostic substrate for driving canvas-based editors (Figma, Tldraw,
  Excalidraw, video editors, drawing apps). The capability is loud-warned
  at boot in the same posture class as `eval` / `network-body` /
  `secrets` / `extensions` / `device-emulation` / `diagnostics`.
  - **`canvas_capture({ ref?, selector?, format, session? })`** — extract
    framebuffer or 2D ImageData from a `<canvas>` element. Three formats:
    `png` (`toDataURL` — handoff to host-agent multimodal vision),
    `2d-imagedata` (`getImageData` RGBA bytes, top-left origin),
    `webgl-framebuffer` (`gl.readPixels` RGBA, flipped to top-left to
    match imagedata convention). Bounded at 16384×16384 px (refuses
    larger with a structured `too-large` error); tainted canvases
    refuse cleanly; WebGL requests `preserveDrawingBuffer:true` on
    context acquisition (cannot undo a prior context's choice).
    Capability `canvas` (+ `read`).
  - **`canvas_diff({ beforeBase64, afterBase64, width?, height?, region?, inputFormat?, session? })`** —
    pure pixel/region delta over two RGBA captures. → `{ ok,
    changedPixelCount, changedBytes, percentageChanged,
    bboxOfChanges:{x,y,w,h}|null, warnings[] }`. `bboxOfChanges` is the
    tight bounding box of the changed area; over-flow regions clamp to
    image bounds. PNG-format inputs (`inputFormat:"png"`) byte-compare
    only this cycle (PNG-decoded pixel diff is a follow-up); a warning
    surfaces so callers know to recapture as `2d-imagedata` for bbox
    math. Capability `read` (pure math; no canvas-pixel touch of its
    own).
  - **`gesture_chain({ steps, session? })`** — multi-step pointer
    program (`down` / `move` / `up` / `wait` / `wheel`). Custom paint
    strokes, lasso paths, signature widgets, hand-drawn gestures the
    canned `drag` / `gesture_swipe` family doesn't cover. Bounded:
    200 steps max, `move` floored at 5 ms per step, `wait` clamped at
    5000 ms per step. `pointerId` accepted on input but routes through
    Playwright's single-mouse pipeline (multi-pointer fan-out is a
    future extension — for multi-touch today use `touch_*` /
    `gesture_pinch`). Capability `canvas` (+ `action`).
  - **`canvas_world_to_screen({ worldX, worldY, ref?, selector?, transform?, session? })`** +
    inverse **`canvas_screen_to_world({ screenX, screenY, … })`** —
    affine coord-space translation, two modes: **explicit** (caller
    passes `transform: {scale, panX, panY, originX?, originY?}` — pure
    math `screenX = (worldX + panX) * scale + originX`); **discovery**
    (omit `transform` — page-side probe walks common app-side globals:
    `app.viewport.zoom`+`app.viewport.center` (Figma/Excalidraw shape),
    `app.scale`+`app.offset` (Tldraw shape), `app.transform.matrix`
    (generic 6-element affine)). Discovery success surfaces
    `transformDiscovered` + `adapterHint` + a HEURISTIC warning;
    discovery failure returns `{ ok:false, error:"no transform
    discoverable — pass \`transform\` explicitly OR use a canvas-app
    adapter plugin", code:"no-transform" }`. Round-trips with the
    inverse to within fp precision under the same explicit transform.
    Capability `canvas` (+ `read`).
  - **`canvas_query({ adapter, op, args?, session? })`** — dispatcher
    routing to a canvas-app adapter plugin's handler. Looks up
    `<adapter>.<op>` in the live plugin tool registry and forwards
    `args` (with `session` passed through). When no plugin matches:
    `{ ok:false, error:"no canvas adapter registered for <adapter>;
    install @kalebtec/browxai-plugin-<adapter> or pass a registered
    adapter namespace", code:"no-adapter", requestedAdapter,
    requestedOp }`. The inner plugin tool's own capability is enforced
    via the plugin call-graph gate. This release ships the dispatcher
    only — the first canvas-app adapter plugins ship as the companion
    canvas-adapter family below. Capability `canvas` (+ the inner
    tool's own capability).
  - **BYO-vision pattern** — `docs/tool-reference.md` documents the
    composition loop: `canvas_capture({format:"png"})` → host-agent's
    own multimodal vision call → `gesture_chain` / `mouse_*`. browxai
    does NOT bundle OCR or a hosted vision API by design (owner
    direction 2026-05-30); the BYO posture preserves browxai's
    substrate-pure / RC-independent property and keeps the modality
    dimension the host agent's choice.

### Added — Perf optimization module

Promotes browxai's perf surface from *measurement* (the v0.2.0 `perf_start`
/ `perf_stop` / `perf_insights` trio that produces raw chromium traces) to
*actionable* — an agent can run a structured audit and receive remediation
recommendations, not just trace blobs. Five new MCP tools (the companion
`overflow_detect` perf-surface tool shipped in v0.6.0).

- **`perf_audit({categories?, durationMs?, format?, session?})`** — the
  headline tool. Records a CDP trace + JS/CSS precise coverage + network
  response metadata for `durationMs` (default 5000, max 30000), then runs
  8 pluggable category analysers against the assembled context and
  composes a report. Categories (default = all): `render-blocking`
  (resources blocking first paint), `unused-code` (scripts/stylesheets
  with <30% usage), `oversize-images` (>500KB), `layout-thrashing` (>5
  forced sync layouts in window), `long-tasks` (>50ms main-thread
  blockers), `leak-suspects` (>10% retainer growth — consumes
  `memory_diff` data when passed on the context), `cache-opportunities`
  (static assets with missing/short Cache-Control), `font-loading` (fonts
  loaded >200ms after document start). Output: `{summary:{score,
  topIssues}, byCategory:{[cat]:{issues[], remediations[]}},
  evidence:{tracePath, coveragePath?}, durationMs, categoriesRun,
  warnings}`. `format:"summary"` (default) caps each category to 3 issues
  + 3 remediations AND enforces a 2000-token body budget — over-budget
  low/medium severity entries are dropped + a `warnings[]` entry surfaces
  it. `format:"full"` is unbounded. Score = `100 − sum(severity-weight ×
  issue-count)` floored at 0 (high=10, medium=4, low=1). Evidence files
  (workspace-rooted): trace under `<workspace>/perf/<sessionId>-audit-<ts>.json`
  + coverage JSON alongside; both load in DevTools' Performance / Coverage
  panels. Category set is internally pluggable — adding a category =
  adding a registry entry in `src/page/perf-audit.ts`; the public surface
  doesn't change. Capability `read` (non-mutating observation).
- **`coverage_start({session?})` / `coverage_stop({session?})`** —
  precise JS + CSS coverage tracking. Wraps CDP
  `Profiler.startPreciseCoverage` (per-script byte-level use counts) +
  `CSS.startRuleUsageTracking` (per-stylesheet rule-level use counts) in
  lockstep. `coverage_stop` returns `{jsCoverage:[{url, totalBytes,
  usedBytes, usagePercent, deadRanges?}], cssCoverage:[{url, totalBytes,
  usedBytes, usedRules, totalRules, usagePercent, deadRules?}],
  durationMs}`. JS coverage follows DevTools' Coverage panel semantics: a
  function with a `count:0` root range is fully dead; `count:1` root with
  `count:0` sub-blocks = dead conditional branches. `usagePercent < 30`
  is the audit's `unused-code` floor. Idempotent restart on
  `coverage_start`; `coverage_stop` is safe to call when no tracker is
  running (`notRunning:true`). `coverage_start` is `action` (mutates
  target state); `coverage_stop` is `read` (pure parse + compose past the
  CDP fetch). `perf_audit` calls both internally — use directly for raw
  reports or longer windows than the audit's 5s default.
- **`layout_thrash_trace({durationMs?, session?})`** — focused CDP trace
  just for forced synchronous layouts + LayoutShift + Recalc Style
  events, aggregated by originating call-stack. Returns
  `{forcedLayoutsCount, layoutShiftsCount, eventsByOrigin:[{originatingStack,
  count, totalDurationMs}], tracePath, durationMs}`. `originatingStack`
  reads from the trace's `stackTrace` field on each event (chromium
  populates it when DevTools is attached); `"<anonymous>"` when no stack
  is available. `tracePath` is workspace-rooted under
  `<workspace>/perf/<sessionId>-layout-thrash-<ts>.json` — loadable in
  DevTools' Performance panel. Capped at top 50 origins. `durationMs`
  default 5000, max 30000. Capability `read`.
- **`memory_diff({beforePath, afterPath, session?})`** — pure-function
  consumer of two `.heapsnapshot` files (the format `heap_snapshot` writes
  / DevTools exports). No browser interaction. Groups nodes by
  `${type}:${name}`, sums `self_size` per group, reports per-group
  deltas. Returns `{retainerGrowth:[{node, type, sizeBefore, sizeAfter,
  deltaBytes, deltaPercent}], summary:{totalGrowth,
  top3Growers:[...]}}`. Groups whose `|deltaBytes| < 1024` are dropped
  (sub-KB noise filter). `deltaPercent` is a number or the string
  `"+inf"` when `sizeBefore:0`. Sorted by `deltaBytes` desc, capped at
  100 rows. Both paths are workspace-rooted; rejected on escape.
  Capability `read`. Pairs with `heap_snapshot` (snapshot before suspect
  interaction → drive the action → snapshot after → `memory_diff`).

## v0.6.0 — 2026-06-08 — Plugin runtime + overflow_detect + click auto-recovery

### Fixed

- **`click` auto-recovers via `force:true` when actionability check times out.**
  The v0.5.1 `force:true` opt-in still required adopters to know about + opt
  into the option. Adopter retest 2026-06-08 confirmed the busy-SPA click
  was still timing out at the deadline even though the click event was
  firing each time. The actionability check (visibility / stability /
  receives-events / hit-test) thrashes forever on perpetually-busy SPAs
  (rAF loops + WS keepalives + frequent re-renders) even though the element
  IS clickable. Fix: when the standard click rejects with an
  actionability-shaped error, automatically retry once with `force:true`
  and surface a `warnings[]` entry naming the recovery. Budgeting: the
  first attempt gets ~70% of the deadline, the recovery gets ~30% (floored
  at 500ms each). Explicit `force:true` from the caller still skips the
  strategy entirely. New `ElementProbe.warnings` field carries body-side
  warnings through to the result envelope.

### Added

- **`overflow_detect` — page-layout overflow diagnosis primitive.**
  The silent UI-breakage tool: clipped buttons, ellipsis-truncated labels,
  horizontal-scrollbar-on-mobile bugs. Walks the DOM and reports one
  finding per offending element across four detector types — `layout`
  (`overflow:auto|scroll` with content overrun: scrollbar present but
  content overflows), `clipped` (`overflow:hidden|clip` with content
  overrun: invisible content with no scrollbar to recover, the high-value
  finding), `text-ellipsis` (`text-overflow:ellipsis` with content overrun:
  evidence carries `visibleText` heuristic + `fullText` truth), and a
  singleton `viewport-horizontal` (`documentElement.scrollWidth >
  clientWidth`: the body horizontal-scrollbar mobile bug, evidence carries
  overrun amount + the widest overrunning descendant when cheaply
  identifiable). `scope:"document"` (default) walks every element;
  `scope:"viewport"` skips elements fully off-screen. `types:[...]`
  filters detectors. `limit` caps findings (default 50, max 500). Walk
  bounded at 10000 elements; a cap-hit surfaces a `warnings[]` entry
  suggesting `scope:viewport` for a narrower pass. Selector synthesis
  prefers `[data-testid]`, falls through to `[role][aria-label]`,
  nth-of-type CSS path (≤5 levels), then `tag.classes` (≤3); capped at
  200 chars. Typical use: post-render layout sanity sweep, mobile
  responsive checks, "the button I clicked got truncated" diagnosis.
  Read-only (capability `read`).

### Added — Plugin runtime

The v1 plugin runtime foundations: external packages register
namespaced tools on the MCP + SDK surface. In-process JS modules
only (v1); lifecycle resolved-once-at-server-start; tool
registration globally namespaced (`<namespace>.<tool>` — plugins
cannot override or wrap core tools).

- **Manifest contract** — `package.json#browxai` field carrying
  `{apiVersion, namespace, register, capabilities, dependsOn, trust, browxaiVersion}`.
  Zod-validated; reserved-namespace enforcement; semver-compatible
  apiVersion gating against the host runtime version
  (`RUNTIME_API_VERSION = 1.0.0`).
- **Runtime core** (`src/plugin/runtime.ts`) — manifest resolver,
  dep-graph builder with Tarjan-SCC cycle detection (cycles abort
  startup loudly, naming every plugin in every cycle), topo-sort
  load order, namespace uniqueness check, capability-subset check,
  per-plugin `register(api)` invocation, runtime call-graph
  enforcement via `api.callTool` (a plugin may call core tools +
  its own tools + tools owned by plugins in its transitively-
  declared `dependsOn` set — anything else returns the structured
  `{ok:false, code:"plugin-call-graph-violation"}` error).
- **`browxai plugin` CLI** — `install <pkg>` / `remove <pkg>` /
  `list` / `info <pkg>` / `upgrade [<pkg>]` / `sync`. Shells out to
  `pnpm` against `<workspace>/plugins/`; writes the
  declarative `plugins.json` + the reproducibility pin
  `plugins-lock.json` (version + content sha256). Every command
  emits a "Server restart required" notice.
- **MCP tools** — `plugins_list` (every declared plugin's load
  status) and `plugins_info` (full manifest + tool registry dump).
  Both `read`-gated.
- **Config integration** — `set_config({plugins})` persists a
  plugin set into `config.json` (unioned with `plugins.json` at
  load time); `get_config({scope:"resolved"}).plugins` reports the
  LIVE enabled set plus the `pluginsPendingRestart` flag (same
  posture as `capabilitiesPendingRestart`).
- **SDK type-gen seam** — `client.plugins.<namespace>.<tool>(args)`
  proxy-based caller; `BrowxaiClientWithPlugins<Schema>` type
  helper composes plugin-shipped `schema.d.ts` overlays into the
  consumer's typed client.
- **Reference plugin** — `@kalebtec/browxai-plugin-example` at
  `packages/plugins/example/`. Three trivial tools (`example.echo`,
  `example.add`, `example.now`) exercising every primitive of the
  v1 contract; vitest unit suite; ships a typed `schema.d.ts` for
  SDK consumers. Used as the plugin-runtime keystone fodder.
- **Author guide** — `docs/plugin-authoring.md` (manifest fields,
  capability rules, dep declarations, call-graph enforcement, trust
  tiers, local-dev workflow, npm publishing, typed SDK seam) and
  `docs/plugins.md` (operator-facing marketplace index).
- **pnpm workspaces** — `pnpm-workspace.yaml` declares
  `packages/*` + `packages/plugins/*` so the reference plugin
  builds in the same `pnpm install` cycle as the host.

Plugin lifecycle mirrors capability lifecycle: changes take effect
on next server restart, never mid-session. The v0.7.0 canvas plugins
and the diagnostics-report plugin follow-up are the first real
consumers of this foundation.

## v0.5.1 — 2026-06-08 — Adopter-report fixes

### Fixed

- **`sessionWedged` false positive on perpetually-busy SPAs.**
  Adopter report 2026-06-08: 3 consecutive `click` timeouts against a heavy
  Vite SPA (SignalR keepalive WS + rAF loops + library-search re-renders)
  latched `sessionWedged: true` and forced a session discard — but
  `eval_js` immediately after proved the page was fully responsive. The
  wedge tracker was conflating "action-shaped timeouts" (Playwright
  actionability + probe stuck on a busy SPA) with "the session itself is
  wedged". Fix: before stamping `sessionWedged: true`, run a 1-second
  `page.evaluate(() => 1)` liveness probe; if the page answers, clear the
  streak rather than declaring the session dead. Real wedges (CDP frozen)
  still trip — only the false-positive shape is filtered.

- **Post-action probe could consume the whole click deadline on busy SPAs.**
  Same adopter report. The post-action `probe()` runs multiple
  `loc.evaluate()` calls — each defaults to Playwright's 30s timeout. On
  SPAs where re-renders constantly re-attach the element handle, a probe
  evaluate can hang far longer than makes sense for a read-only check,
  consuming the whole action deadline and surfacing as a "click timeout"
  even though the click already fired. Fix: bound every probe-side
  `loc.evaluate()` (and the matching `preProbe` call + `inputValue`) to
  1500 ms each; on timeout the `.catch()` returns the fallback so the
  probe degrades to partial data instead of failing the whole action.

- **Diagnostics JSONL is now KEPT across `close_session` / `close_sessions`.**
  Same adopter report. The v0.5.1 diagnostics builder wired per-session
  removal of the diagnostics directory on close. But `close_session` IS the
  wedge-recovery path — notes filed right before a (real OR falsely-flagged)
  wedge were exactly the most valuable feedback the curator gets, and they
  were being deleted at the worst possible moment. Fix: stop deleting on
  close; retention sweep (default 30 days, configurable via
  `BROWX_DIAGNOSTICS_RETENTION_DAYS`) handles long-term cleanup. Per-session
  removal was the wrong scope.

- **`idb_put` now surfaces a structured warning when `value` arrives as a JSON-encoded string.**
  Adopter saw `idb_put({value:{hello:'world',…}})` write a JSON STRING to
  IDB rather than the structured object. Through the curated handler path
  (keystone-tested), objects round-trip as objects. The observed shape
  happens when an MCP client double-encodes complex args — `value` reaches
  the server as `'{"hello":"world"}'` (a string). The page-side code
  faithfully stores a string. Fix: at the handler, detect when `value` is
  a string that JSON-parses to an object/array and surface a
  `warnings[]` entry pointing at the double-encoding gotcha. The value is
  still stored verbatim (some apps legitimately store JSON strings);
  the warning lets the agent diagnose the case.

- **`dom_export` — `PAGE_WALK_FN` ran as an expression, not a function.**
  Same root cause as the `element_export` fix below: the page-side walk
  function was authored as `(args) => {...}` and passed to
  `Page.evaluate(stringExpr, arg)`. Playwright evaluated the string in
  page context, which returns the function value uncalled, and CDP
  can't serialize a function across the boundary — so the result
  crossed back as `undefined` and the server-side `walked.nodeCount`
  access threw `Cannot read properties of undefined (reading 'nodeCount')`
  in both `html` and `jsonl` modes. Fix: pass the walk function as a
  real TypeScript function literal so Playwright serializes the source
  and invokes in-page with the arg. `DomExportPage.evaluate` now takes a
  function rather than a string, removing the type-confusion surface.
  A new keystone test (`test/keystone/dom-export.keystone.test.ts`)
  exercises both formats + default-path + workspace-escape against real
  headless Chromium.

- **`element_export` — `SUBTREE_DISCOVERY_FN` ran as an expression, not a function.**
  The page-side discovery function was authored as a stringified arrow
  expression and passed to `Locator.evaluate(stringExpr)`. Playwright
  evaluated the string in page context — which returns the function value
  uncalled — and CDP can't serialize a function across the boundary, so
  the return crossed back as `undefined`. The server-side code then threw
  `Cannot read properties of undefined (reading 'unreadableStylesheets')`
  in both `directory` and `single-file` modes. Fix: pass the discovery
  function as a real TypeScript function literal (`(el: Element) => {...}`)
  so Playwright serializes the source and invokes in-page with the
  resolved element — the canonical pattern. A new end-to-end keystone
  test (`test/keystone/element-export.keystone.test.ts`) exercises both
  formats against real headless Chromium plus default-path / workspace-
  escape / ref-not-found — the regression class can't reappear silently.
  The `ElementExportLocator` adapter interface now takes a real function
  rather than a string, removing the type-confusion surface.

### Added

- **Structured usage diagnostics + agent self-feedback (`diagnostics` capability + recorder hook + 3 tools).**
  Promotes agent friction from anecdote to data — so the curator can answer
  "what primitive is missing?" with evidence instead of guesses. Off-by-default
  capability; loud-warned at boot. Same posture class as `eval` /
  `network-body` / `secrets` / `extensions` / `stealth` / `captcha` /
  `device-emulation`.
  - **Recorder hook at the MCP-handler dispatch boundary.** When the capability
    is OFF, the hook is a single boolean gate check — zero allocations beyond
    that, zero file IO. When ON, every dispatched tool call lands as a JSONL
    line under `$BROWX_WORKSPACE/diagnostics/<sessionId>/<server-start-ISO>.jsonl`
    with `{ts, tool, sessionId, argsRedacted, resultMeta:{ok, sizeBytes,
    warningsCount, failureKind}, durationMs, capabilityDenials}`. Args are
    structurally redacted (keys + types + sizes preserved; large payload fields
    rewritten to sha256 + byteLength). The recorder runs DOWNSTREAM of the URL
    sanitiser + secrets-masking egress chokepoint so registered secret values
    never reach the store raw. Retention is config-driven via
    `BROWX_DIAGNOSTICS_RETENTION_DAYS` (default 30); expired session directories
    are removed on server start AND on session close.
  - **`eval_js` deep-capture.** For `eval_js` / `poll_eval` specifically, each
    record additionally carries `{exprSha, exprHead<80chars, returnType,
    returnSizeBytes, taxonomy}`. The taxonomy bucket is a heuristic substring
    classifier — one of `dom-query`, `storage-access`, `computed-style`,
    `callback-trigger`, `feature-detect`, `custom`. High-recurrence buckets
    feed the report's `missingPrimitiveHypotheses`.
  - **`diagnostics_note({ insight, category?, severity?, ref?, session? })`** —
    agent self-feedback. Files a `kind:"note"` record (categories
    `missing-primitive` / `workaround` / `perf-concern` / `ergonomic-friction`
    / `other`; severities `info` / `warn` / `blocker`). Capability:
    `diagnostics`. Paired with **`diagnostics_search`** (read-side query;
    filters by `since` / `tool` / `category` / `sessionId`; capped at 1000
    records; capability `read`).
  - **`diagnostics_report({ format?, since?, sessionId? })`** — analysis
    primitive. `summary` (default) returns per-tool counts + p50/p95
    durations, the top 10 `eval_js` patterns by count + taxonomy,
    capability-denial counts, note counts by category, and a
    `missingPrimitiveHypotheses` list (heuristic: non-`custom` taxonomy with
    count ≥ 3 OR `custom` pattern with count ≥ 5). `full` additionally streams
    the per-record list capped at 500 (`truncated:true` when exceeded).
    Capability: `read`.

## v0.5.0 — 2026-05-30 — Automation completeness

### Added

- **Web Workers + Service Workers visibility (`workers_list` / `worker_message_send` / `worker_messages_read` / `sw_intercept_fetch` / `sw_unintercept_fetch`).**
  Workers were previously off-grid: `network_read` shows page fetches but
  never the SW that responds from cache, and the `postMessage` IPC between
  page and workers was invisible to the surface. This family makes both
  observable and mutable.
  - **`workers_list({ type?, session? })`** — enumerate live workers; `type ∈
    "web" | "service" | "all"` (default `"all"`). Returns `[{workerId, type,
    url, state?}]`. Web Worker ids are `ww-N`; SW ids are `sw-N` (stable per
    session). Capability: `read`.
  - **`worker_message_send({ workerId, message, session? })`** — `postMessage`
    to a worker. For Web Workers, calls the real (unwrapped)
    `Worker.prototype.postMessage` so the worker's `onmessage` sees a real
    event. For Service Workers, dispatches a `MessageEvent` into the SW
    global via CDP `Runtime.evaluate` on the SW's attached session. Strings
    only; `MessagePort` transfer not in MVP. Capability: `action`.
  - **`worker_messages_read({ workerId?, session? })`** — drain buffered
    messages FROM workers since the last read. Page-side ring capped at 500
    entries with a 4 KiB payload cap. Capability: `read`.
  - **`sw_intercept_fetch({ pattern, response, session? })`** — register a
    fetch interceptor for SW-handled requests. Same glob shape as `route` /
    `ws_intercept`. Fires only when the SW's `fetch` handler runs, cleanly
    separating SW-mediated traffic from page-direct traffic. Capability:
    `action`. Paired with **`sw_unintercept_fetch({ pattern?, session? })`**.
  - Web Worker discovery uses a page-side `Worker` constructor wrapper
    installed eagerly at session creation (`addInitScript` — same posture as
    the WS family) so workers constructed during initial document parse are
    captured. SW discovery uses CDP `ServiceWorker.enable` +
    `Target.setAutoAttach({autoAttach:true, waitForDebuggerOnStart:false,
    flatten:true})` on the top-level CDP. Per-session by construction; lost
    on session close or BYOB rebuild (a fresh wrapper installs on the new
    context).
- **Cache API + IndexedDB CRUD — siblings of cookie / web-storage CRUD.**
  Completes the storage-state surface so adopters can checkpoint and replay
  Service-Worker offline caches and app-level IDB stores the same way they
  already drive cookies and localStorage. Origin-scoped (same posture as
  `localStorage_*` — navigate first; about:blank rejects with a hint). Zero
  synthetic IDs — each entry keyed by its native `(cacheName, url)` /
  `(dbName, storeName, key)`. Capability split: reads under `read`, writes
  under `action`; no new capability gate.
  - **Cache API (7 tools).** `caches_list_storages` (`caches.keys()`),
    `caches_list({cacheName, urlPattern?})` (substring filter on entry URL),
    `caches_get({cacheName, url})` → text-like content-types arrive as
    `{kind:"text", text}`, everything else as `{kind:"binary", contentBase64,
    byteLength}`; `caches_put({cacheName, url, response:{status?, headers?,
    body? | contentBase64?}})` (auto-creates the cache storage; body XOR
    contentBase64); `caches_delete`, `caches_clear`, `caches_delete_storage`.
  - **IndexedDB (6 tools).** `idb_list_databases` (`indexedDB.databases()`;
    `supported:false` on engines without it), `idb_list_stores({dbName})`
    (read-only — does not trigger an upgrade), `idb_get({dbName, storeName,
    key})`, `idb_put`, `idb_delete`, `idb_clear`. Keys round-trip as string /
    number / array-of-strings-or-numbers. Values cross MCP's JSON-only
    transport — non-JSON-serialisable IDB values (Blob / ArrayBuffer / Map /
    Set / Date cycles) surface as a structured error rather than a silent
    drop; the platform value is preserved IN the store and only the
    over-the-wire return path is bounded. Store creation requires an upgrade
    transaction so `idb_put` against a missing store rejects with the schema
    hint instead of silently creating it. → standard envelopes with
    `tokensEstimate`.
- **Web Bluetooth / WebUSB / WebHID device emulation
  (`emulate_bluetooth` / `emulate_usb` / `emulate_hid` / `device_requests`).**
  Per-session synthetic-device catalogs for the three Web platform
  device-picker APIs. The page-side init-script wrappers around
  `navigator.bluetooth.requestDevice` / `navigator.usb.requestDevice` /
  `navigator.hid.requestDevice` resolve with synthetic device objects matching
  W3C shapes, so an agent can drive a page that gates a flow behind a device
  picker without owning the hardware. **Gated behind the off-by-default,
  loud-warned `device-emulation` capability** — same posture class as `eval`
  / `network-body` / `secrets` / `extensions` / `stealth` / `captcha`. The
  capability is posture-broadening (every other policy says "the page CAN'T
  do X"; this one says "the page CAN do X and we lie about what it found"),
  so it is gated as its own slot rather than folded into `action`.
  - **`emulate_bluetooth({devices?, session?})`** — stage a Bluetooth
    catalog. `{devices: [{name, id, services?, …}]}` installs; `{}` /
    `{devices: []}` clears (next `requestDevice` rejects with
    `NotFoundError` — the user-dismissed shape). The synthetic
    `BluetoothDevice` carries `{id, name, uuids, gatt}`; `gatt.connect()`
    resolves with a stub server whose `getPrimaryService()` rejects (no
    GATT emulation in v1 — see below).
  - **`emulate_usb({devices?, session?})`** — stage a USB catalog. The
    synthetic `USBDevice` carries vendor/product/class/manufacturer/serial
    + `usbVersionMajor` etc.; `open()` / `selectConfiguration()` /
    `claimInterface()` resolve; `transferIn` / `transferOut` /
    `controlTransfer*` resolve with zero-byte payloads (no synthetic data
    flow).
  - **`emulate_hid({devices?, session?})`** — stage a HID catalog. The
    HID API is multi-result by construction: `requestDevice` resolves with
    an Array<HIDDevice>; an empty catalog resolves with `[]` (the HID
    user-dismissed shape), NOT a rejection. The synthetic `HIDDevice`
    carries vendor/product/productName/collections; `open()` /
    `sendReport()` / `sendFeatureReport()` resolve; `oninputreport` is
    never fired (no synthetic device traffic).
  - **`device_requests({since?, session?})`** — read-side companion.
    Returns the buffered page-side `requestDevice` calls with
    `{api, handledAs, returned, filters?, ts}`. `handledAs` is one of
    `"resolved"` (catalog non-empty), `"rejected"` (Bluetooth/USB +
    catalog empty), `"empty"` (HID + catalog empty), or `"refused"`
    (capability was off at call time — the wrapper short-circuited but
    the buffer records the attempt so the read surfaces "the page asked
    for hardware and you didn't have the capability on").
  - Page-side wrapper installs eagerly at session creation
    (`addInitScript`) so sockets constructed during initial document parse
    hit the wrapped surface — a lazy install would miss them. Re-injected
    on every navigation via the existing `addInitScript` flow.
    Idempotent guard (`window.__browx_device_emu_installed`). BYOB
    sessions surface a warning that the wrapper outlives browxai's
    detach (`BYOB_DEVICE_EMU_WARNING`). See `src/session/device-emu.ts`
    and `docs/threat-model.md`.
  - v1 scope is deliberately narrow — enough to clear a picker-gated
    onboarding flow, not enough to drive a real device protocol over the
    synthetic surface. Deferred follow-ups: GATT service emulation for
    Bluetooth (synthetic characteristics + read/write/notify);
    `transferIn` / `transferOut` synthetic data streams for WebUSB;
    `oninputreport` synthetic input streams for WebHID.

- **`drop_files` — drag-drop files from disk onto a page element.**
  Sibling to `upload_file` for drop-zone uploaders (modern SaaS file pickers
  that listen for `dragenter` / `dragover` / `drop` with a populated
  `DataTransfer.files` and never expose an `<input type=file>` for
  `setInputFiles` to drive). Synthesises the standard HTML5 drop sequence
  with `File` objects built in-page from caller-supplied bytes, then
  dispatches the event triple on the target with realistic
  `clientX` / `clientY`. Same target shapes as the rest of the action
  surface (`ref` / `selector` / `named` / `coords`); `files[]` accepts a
  mix of `{path}` (workspace-rooted, escape-rejected — same posture as
  `upload_file`'s `path` mode) and `{contents, name}` (base64 inline).
  Multi-file drops land in a single sequence the way every real multi-file
  drop behaves. → `{ ok, target, files, totalBytes, fileCount, eventsFired,
  dropDispatched, tokensEstimate }`. Gated by the off-by-default
  **`file-io`** capability — same posture as `upload_file`. No agent JS.

- **Interactive WebSocket primitives (`ws_send` / `ws_intercept` / `ws_unintercept`).**
  The read-only WS view (`ws_read` + `ActionResult.network.wsFrames`) gets a
  mutation half. Sibling of the HTTP `route` family on the realtime channel —
  all three under capability `action`; no new capability gate.
  - **`ws_send({ wsId, message, session? })`** — push a payload onto a live
    page-side socket the agent identified via `eval_js
    JSON.stringify(window.__browxWs.list())`. Calls the real (unwrapped)
    `WebSocket.prototype.send` so app-level `message` listeners don't see a
    fake event — only the server sees the outbound frame.
  - **`ws_intercept({ pattern, response, session? })`** — route-handler-style
    pattern matching for INBOUND frames. `pattern` is a glob matched against
    `socket.url`. Three response modes: `"drop"` discards the frame before
    app handlers run; `"echo"` mirrors it back to the server; `{data:"…"}`
    replaces the inbound payload before delivery.
  - **`ws_unintercept({ pattern?, session? })`** — remove one by pattern, or
    every interceptor when `pattern` is omitted.
  - Page-side wrapper installs eagerly at session creation (`addInitScript`)
    so sockets constructed during initial document parse hit the wrapped
    constructor — a lazy install would miss them. Each socket is assigned a
    stable per-session `wsId` (`ws-1`, `ws-2`, …) the agent can discover
    via the page-side `__browxWs.list()` registry. Per-context by
    construction; lost on session close or BYOB rebuild.
- **File System Access policy (`showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker`).**
  Modern web editors (VSCode for the web, Figma, anything with a "save to
  disk" button) deadlock under a headless session — the picker dialog
  blocks every subsequent browser event until the human clicks a real OS
  file chooser that doesn't exist in headless. The same posture as the
  dialog and permission policies now governs the three File System Access
  entry points. Three additions, all back-compat:
  - **`fs_picker_policy` argument on `open_session`** plus **`set_fs_picker_policy({mode, perAPI?, session?})`** runtime mutator. Modes: `allow` / `deny` / `raise` (DEFAULT — anti-deadlock) / `ask-human`. Per-API overrides win over the top-level `mode`. Persists across navigation; re-applied on every new document. Capability `action`.
  - **`fs_picker_respond({api, files: [{path | contents, name?, mimeType?}], session?})`** — agent-side response queue, per-API. For `showSaveFilePicker`: the supplied workspace-rooted `path` is the destination for `createWritable()`-driven writes (page-side `write()`/`truncate()`/`close()` routed through a server binding that persists the bytes; back-pressure preserved). For `showOpenFilePicker`: inline `{contents}` or workspace-rooted `{path}` (server reads at respond-time and inlines bytes the page reads via `getFile()`). For `showDirectoryPicker`: a minimal handle whose `.name` is the basename and `entries()`/`values()`/`keys()` iterate empty (MVP scope — most editors fall back to per-file pickers). Capability `file-io`. Workspace-escape on `path` rejected at the tool layer.
  - **`ActionResult.fsPickerRequests[]`** — every picker call that fired during the action window is sliced off the per-session buffer and surfaced as `[{api, suggestedName?, handledAs: "allowed"|"denied"|"raised"|"asked-human"}]`. Independent of `ok`; `raise` mode additionally flips `ok` to false with `failure:{source:"app", hint:"unhandled File System Access picker — set fsPickerPolicy …"}`.

- **Frame-scoped observation (iframes + cross-origin frames).**
  Iframes are everywhere on real pages; pre-v0.5.0 `find` / `snapshot` saw
  only the top frame. Three additions, all back-compat:
  - **`frames_list({ session? })`** — returns the page's full frame tree
    with a stable per-session ID per frame (`fN`; `f0` is always the main
    frame). Each entry carries `{frameId, parentFrameId?, url, name,
    isMainFrame, origin}`. Capability `read`.
  - **`snapshot` / `find` gain an optional `frame: <fN>`** argument. When
    set, the tool scopes to that child iframe; refs minted there are bound
    to the frame on the registry so subsequent `click` / `fill` / etc. fire
    inside the iframe transparently. Same-origin and cross-origin (OOPIF)
    both work through Playwright's frame API. Omitting `frame` (or passing
    `f0`) is byte-identical to the pre-v0.5.0 main-frame path.
  - **Frame-scoped action targets**: `locatorFor` consults the registry's
    new per-ref frame binding; refs minted in a child frame route through
    `frame.locator(...)` rather than `page.locator(...)`. No new action
    capability — extends the existing `action` surface.
  - **Cross-origin caveat (documented)**: the CDP accessibility-tree path
    used by main-frame snapshots is not run for child frames (rooted at the
    top target, doesn't reach into OOPIFs). Frame-scoped snapshots are
    DOM-walk-sourced only and surface a warning so the agent isn't
    surprised by `[from-dom]` markers. Read + action still work for both
    same-origin and cross-origin iframes.
- **Shadow DOM deep piercing** — three pieces:
  - `find({ …, pierce? })` — optional `pierce: "open" | "closed" | false`.
    Omitting `pierce` preserves pre-v0.5.0 behaviour byte-for-byte
    (Playwright's a11y tree already auto-pierces open shadow; the DOM-walk
    fallback didn't recurse into shadow content). `"open"` extends the
    DOM-walk into every reachable open shadow root. `"closed"` additionally
    invokes CDP `DOM.getDocument({pierce:true})` and surfaces interactive
    / test-attr-bearing elements behind CLOSED shadow boundaries — those
    candidates are **inspect-only** (Playwright's locator engine cannot
    reach them; the result envelope carries the warning). `false`
    disables shadow recursion entirely.
  - `snapshot({ …, includeShadow? })` — the symmetric knob for the
    snapshot tree. Same semantics as `pierce`. Closed-shadow entries flow
    through the same merge layer as DOM-walk entries (`[from-dom]`-marked,
    stable refs via the registry); the header surfaces a
    `closedShadowEntries` stat when present.
  - `shadow_trees({ ref?, maxHosts?, session? })` — read-only introspection
    of Shadow DOM hosts. Returns `{ trees: [{hostRef, hostTag, mode,
    children, descendantCount}], closedShadowAvailable, warnings,
    tokensEstimate }`. Pass `ref` to limit the walk to one host's
    subtree; omit it to walk every shadow root in the document. Falls
    back to a page-side open-only walk when CDP refuses `pierce:true`.
    Capability `read` (no new gate).

  Closed-shadow piercing is best-effort by construction — `DOM.getDocument
  ({pierce:true})` is a Chromium DevTools facility, not a web-platform
  guarantee. When CDP refuses the call (older Chromium, attached-mode
  quirks), the result envelope carries the `closed-shadow piercing
  unavailable on this browser/page` warning and the open-shadow data is
  still returned.

- **Touch + multi-touch gestures** — a separate dispatch pipeline from the
  `mouse_*` family, for mobile-default apps and canvas / map / drawing
  widgets that wire `touchstart` / `touchmove` / `touchend` handlers the
  mouse pipeline does not reach. Dispatched via CDP
  `Input.dispatchTouchEvent` (the touch sibling of `dispatchMouseEvent`).
  - **`touch_start({coords, identifier?, session?})`** /
    **`touch_move({coords, identifier?, session?})`** /
    **`touch_end({coords?, identifier?, session?})`** — single-touch
    primitives. `identifier` (default `1`) maps to DOM
    `TouchEvent.changedTouches[].identifier`; use distinct values per
    finger when fanning out multi-touch by hand. `touch_end`'s `coords`
    is optional — omit for the "all fingers up" form, supply for a
    targeted lift.
  - **`gesture_pinch({coords, scale, steps?, startOffset?, session?})`** —
    two-finger pinch in/out centred on `coords`. Touch points start at
    `coords ± startOffset` (default 40 CSS px) and converge or diverge
    linearly so the final separation is `startOffset × scale`.
    `scale < 1` is pinch-in (zoom out); `scale > 1` is pinch-out (zoom
    in). Linear interpolation by design — pinch handlers read inter-
    frame deltas and velocity-detecting curves misfire fling heuristics
    on libraries like Hammer.js.
  - **`gesture_swipe({from, to, durationMs?, steps?, identifier?, session?})`** —
    single-finger swipe; distinct from `drag` which uses the mouse
    pipeline. `durationMs` (default 200) split across `steps` (default
    16) `touchMove` dispatches, smoothed via an ease-out curve
    (`1 - (1 - t)²`) to match the natural deceleration most fling-
    detect heuristics expect.
  - Touch does NOT auto-fire mouse events (browsers MAY synthesize
    mouse events from touchend, but it is app-policy via `touch-action`
    / `preventDefault`); agents that need both pipelines must dispatch
    both explicitly. Capability `action` (extends the existing gesture
    surface — no new capability).
- **`element_export({ ref, format?, intoDir?, maxSizeMb?, session? })`** —
  save the subtree under one ref as a self-contained snippet (outerHTML +
  page-wide stylesheets + linked resources). Two formats: `directory`
  (default) writes `<intoDir>/element.html` + `<intoDir>/assets/` sidecar
  with `[src]` / `[href]` / `background-image: url(...)` references
  rewritten to relative `assets/<kind>/<file>` paths; `single-file` writes
  one HTML with resources inlined as `data:` URIs and CSS inlined in a
  `<style>` block. Sibling to `page_archive`, scoped to one element subtree
  instead of the whole document. Cross-origin stylesheets the page can't
  read are surfaced in `warnings[]` (the snippet may render differently
  than the source page). `intoDir` resolves inside `$BROWX_WORKSPACE`
  (escape rejected); ref-not-found is a structured error. Default
  `maxSizeMb:50`. UNMASKED output — same secrets caveat as `page_archive`.
  Capability `file-io`.
- **`dom_export({ format?, includeShadow?, path?, session? })`** — full
  DOM dump. `html` (default) writes `document.documentElement.outerHTML`
  (note: the platform serializer does NOT include shadow-DOM content,
  open OR closed); `jsonl` writes one JSON object per line
  (`{tag, role?, attrs, text?, ref?, depth}`) via a depth-first walk that
  descends into open shadow roots when `includeShadow:true` (default).
  Closed shadow roots are inaccessible by web-platform design; surfaced
  in `warnings[]` when custom elements are detected. `path` resolves
  inside `$BROWX_WORKSPACE` (escape rejected); default
  `dom-dumps/<sessionId>-<ISO>.{html|jsonl}`. UNMASKED output — same
  secrets caveat as `page_archive`. Capability `file-io`.
- **`screenshot_schedule({ everyMs, count? | durationMs?, intoDir?, format?, session? })`** —
  periodic screenshot capture at a fixed interval into a workspace-rooted
  directory. `everyMs` cadence in `[100, 60000]` ms; exactly one of `count`
  (1..1000) or `durationMs` (`>= everyMs`) is required — unbounded schedules
  are refused at validation time. `intoDir` defaults to
  `screenshots/<sessionId>-<isoTs>/`; path-traversal is rejected. Files are
  named `<seq>-<offsetMs>.<png|jpg>`. A belt-and-braces ceiling of 1000
  captures per call applies on top of count/duration. A single failed snap is
  logged as a warning and the schedule continues. Returns
  `{ ok, intoDir, count, capturedAt: [ms…], paths: […], warnings: […], tokensEstimate }`.
  Capability: `file-io`.
- **`screenshot_on({ trigger, durationMs, intoDir?, format?, session? })`** —
  event-driven screenshot capture. Arms a trigger for the observation window
  and snaps on every fire. Triggers (fixed enum): `navigation` (main-frame
  `framenavigated`), `console-error` (console.type==='error' OR `pageerror`),
  `network-mutation` (write-shaped 2xx — POST/PUT/PATCH/DELETE), `dialog`
  (alert/confirm/prompt/beforeunload). `durationMs` range `[1, 600000]` ms
  (10 min ceiling). Per-window cap of 50 captures prevents event-storm
  runaway (warning emitted if hit; window closes early). Overlapping fires
  during an in-flight snap are dropped (single screenshot per visible state
  is the useful unit). Returns
  `{ ok, intoDir, trigger, capturedAt: [ms…], paths: […], warnings: […], tokensEstimate }`.
  Capability: `file-io`.
- **`set_notification_policy({ mode, session? })`** — per-session policy for
  the `new Notification(title, opts)` *constructor*. Sibling of
  `set_permission_policy` (which gates `Notification.requestPermission` / the
  permission check); the two policies compose — `permissionPolicy.notifications`
  controls whether the page MAY notify, `notificationPolicy` controls what
  happens when it actually constructs one. Four modes: `allow` (DEFAULT —
  browser default; constructor proceeds, OS displays per its settings) /
  `deny` (constructor throws `NotAllowedError`) / `raise` (constructor throws
  AND flips next action's `ok:false` with the unhandled-notification hint) /
  `ask-human` (server blocks on `__browx.confirm(true|false)` via the
  `await_human({kind:"confirm"})` mechanism). Captured calls surface on
  `ActionResult.notifications[] = [{title, body?, icon?, tag?, timestamp,
  origin?, handledAs}]` — `body`/`icon`/`tag` are the documented subset of
  `NotificationOptions` captured; the rest are dropped to bound the result.
  Persists across navigation. Init-script wraps the constructor with a fresh
  prototype so platform accessor-only properties don't shadow our writes —
  `instanceof Notification` returns false for the wrapped stub (rare in
  practice). Capability: `action`.
- **`open_session({ notificationPolicy })`** — additive schema extension. Accepts
  either the compact string form (`"allow"`/`"deny"`/`"raise"`/`"ask-human"`)
  or `{mode}`. Mutable at runtime via `set_notification_policy`.
- **`set_permission_policy({ mode, perPermission?, session? })`** — per-session
  permission policy mirroring `set_dialog_policy`. Governs page-side
  permission requests (`getUserMedia`, `navigator.geolocation.
  getCurrentPosition` / `watchPosition`, `Notification.requestPermission`,
  `navigator.clipboard.read` / `write`, and the long-tail sensor permissions)
  with four modes — `allow` / `deny` / `raise` (DEFAULT — deterministic
  anti-deadlock) / `ask-human`. Per-permission overrides
  (`perPermission: { camera: "allow", notifications: "deny", … }`) win over
  the top-level `mode`. Persists across navigation: an init-script is
  re-injected on every new document. Returns the resolved policy. Capability:
  `action`. Sibling of `grant_permissions` — that tool remains as the
  bulk-grant shortcut for the `mode:"allow"` case.
- **`open_session({ permissionPolicy })`** — additive schema extension. Accepts
  the string form (top-level mode) or the object form
  (`{ mode, perPermission? }`). Default `raise`. Mutable at runtime with
  `set_permission_policy`.
- **`permission_state({ permissions[], origin?, session? })`** — read-only
  companion. Returns `{ [permission]: "granted" | "denied" | "prompt" |
  "unknown" }` per requested name via the W3C Permissions API. Defaults
  `origin` to the current page's origin. Capability: `read`.
- **`ActionResult.permissionRequests[]`** — page-side permission requests that
  fired during the action window. Each entry carries
  `{ permission, origin?, handledAs: "allowed" | "denied" | "raised" |
  "asked-human" }`. Mirrors the `ActionResult.dialogs[]` precedent.
  Independent of `ok`; `raise`-mode requests additionally flip `ok` to false
  with a stable `unhandled permission request` hint pointing at
  `set_permission_policy`.
- Supported permission names (v1, 13 total): `camera`, `microphone`,
  `geolocation`, `notifications`, `clipboard-read`, `clipboard-write`, `midi`,
  `midi-sysex`, `payment-handler`, `background-sync`, `accelerometer`,
  `gyroscope`, `magnetometer`. USB / Bluetooth / HID are out of scope for v1
  (slated for a future `device-emulation` capability).

## v0.4.0 — 2026-05-30 — image-to-path + page archive + asset export + session video

Patch release on the path to v1.0. Four small additive primitives lead the new-feature roadmap shipping ahead of the public flip. v0.3.x stable surface is **unchanged** — every addition is net-additive. Default capability set unchanged; new disk-writing primitives all ride the existing off-by-default `file-io` capability (no new capability gates).

### Added

- **`screenshot({ path?, format?, fullPage? })`** — three optional params extend
  the existing `screenshot` tool without breaking the v0.3.x shape:
  - `path` (workspace-rooted) writes the bytes to disk and returns a JSON
    envelope `{ ok, path, bytes, format, fullPage, caption?, tokensEstimate }`
    instead of the inline `image` content part. Path-traversal is rejected
    (must resolve under `$BROWX_WORKSPACE`); parent directories auto-created.
    Requires the `file-io` capability in addition to the tool's own `read`
    gate — the default (no `path`) mode is unchanged and needs no extra
    capability.
  - `format` (`"png" | "jpeg"`) — already present; called out here as part of
    the extended surface. Default `"png"`.
  - `fullPage` (boolean) — when `true`, captures the whole document via
    Playwright's `page.screenshot({fullPage:true})`. Mutually exclusive with
    `ref`/`selector`/`named` (element-scoped captures are already bounded by
    the element's box) — combining returns a structured rejection.

  When `path` is omitted, the result is **byte-identical to v0.3.x** — no
  breaking change to existing callers.
- **`asset_export({filter, intoDir?, maxCount?, maxBytes?})`** — new MCP tool
  that filters the session's always-on network ring (`NetworkBuffer`) and
  persists matching responses to a workspace-rooted directory. Filter shape:
  `mime[]` substring on `Content-Type`, `urlPattern` (case-insensitive
  RegExp), `minBytes` / `maxBytes` size bounds, `status[]` allow-list
  (default 2xx). Filenames are derived from URL path basenames, sanitised
  (no separators / NULs / leading dots / control bytes; length-capped) and
  collision-resolved with `-N` suffix. `intoDir` defaults to
  `$BROWX_WORKSPACE/assets/<sessionId>-<ISO>/` and is rejected if it escapes
  the workspace. Per-call caps (default 10000 files / 500 MiB, hard ceilings
  50000 / 2 GiB) bound runaway exports. Returns `{intoDir, totalCount,
  matchedCount, persistedCount, droppedCount, manifest, warnings,
  tokensEstimate}` and writes `<intoDir>/_manifest.json`. When a response
  body has aged out of the renderer cache the tool falls back to an in-page
  `fetch()` against the original URL; cross-origin URLs without permissive
  CORS headers land in `droppedCount`, never a crash. Gated by the
  off-by-default **`file-io`** capability — same posture as `download_get`.

### Changed

- **`src/page/network.ts`** — `NetworkEntry` gains optional `mimeType` and
  `bytes` fields, populated from CDP `Network.responseReceived.response.mimeType`
  and `Network.loadingFinished.encodedDataLength` respectively. The
  `network_read` egress shape is unchanged (those fields stay off the
  bucketed `recent()` output). `NetworkBuffer` gains a read-only `iter()`
  method that exposes the raw ring for `asset_export`'s filter loop.
- **`page_archive` MCP tool** — save the current page as a self-contained
  archive. Two formats: `directory` (default) writes `<path>/index.html`
  plus a `<path>/assets/` sidecar with every linked resource (images,
  fonts, scripts, stylesheets, CSS background-images surfaced via
  `getComputedStyle`); HTML refs rewritten to relative `assets/...`
  paths. `single-file` writes one HTML at `<path>` with every resource
  inlined as a `data:` URI (browsers struggle past ~150 MB — large pages
  should prefer `directory`). Workspace-rooted by construction
  (`resolveWorkspacePath` rejects escape — same posture as `pdf_save` /
  `dump_storage_state`); omit `path` for a default
  `archives/<sessionId>-<ISO>[.html]`. `maxSizeMb` caps the total archive
  (default 200) — resources past the budget land in `droppedCount` with
  a warning. Result: `{ ok, format, path, sizeBytes, resourceCount,
  droppedCount, warnings[] }`. Gated by the off-by-default **`file-io`**
  capability (same posture as `upload_file` / `downloads_capture`).
  Resource fetching runs `await fetch(url, { credentials:'include' })`
  in page context — cookies / auth headers travel correctly; CSP
  `connect-src` blocks are caught, dropped, and surfaced in
  `droppedCount` + `warnings[]`. **Secrets-masking deliberate gap**: the
  archive output is intentionally UNMASKED — masking is literal-
  substring substitution and would corrupt inline JSON / CSS / binary
  bytes. The `warnings[]` array always carries the caveat as its first
  entry; treat the archive as sensitive material, same posture as
  `dump_storage_state`. The caller must navigate + settle the page
  BEFORE calling — the tool does not inject its own wait.
  See `src/page/archive.ts`, `docs/tool-reference.md` "Page archive".
- **Session video recording** — Playwright's native `recordVideo` context
  option, surfaced as the symmetric stop + read pair around an
  `open_session` extension (Playwright doesn't expose a runtime start, so
  the shape mirrors the native HAR path rather than `start_har` /
  `stop_har`).
  - `open_session({ recordVideo: { path?, size? } })` — wire video at
    context creation. `path` is workspace-rooted (default
    `<workspace>/videos/<session-id>-<ISO>.webm`); path traversal outside
    `$BROWX_WORKSPACE` is rejected. `size` maps to Playwright's
    `recordVideo.size`. Honoured on `persistent` + `incognito`; **refused
    on `attached`** with a hard error (consumer's Chrome is not-owned —
    we don't wire context-creation primitives on it). Returns a
    `video: { path, size?, finalizesOn:"close_session" }` field on the
    `open_session` result.
  - `stop_video({ session? })` — signal that the recording should be
    finalized. The .webm is written to disk only when the session closes
    (Playwright constraint — same shape as the native HAR path). Returns
    `{ pendingFinalize:true, finalized:false, finalizesOn:"close_session",
    path, hint, tokensEstimate }`. Returns a structured error on
    `attached` sessions or when no recorder is active. Capability
    `file-io`.
  - `get_video({ format?, session? })` — read the finalized video off
    disk. `format:"path"` (default) returns the absolute path + on-disk
    size; `format:"bytes"` additionally inlines as base64 when the file
    is under ~1 MiB. Returns a structured error when the file isn't yet
    on disk (the get-before-`close_session` case), on `attached`
    sessions, or when no recorder was wired. Capability `file-io`.

### Changed

- **`src/page/video.ts`** — new module mirroring `src/page/har.ts` for the
  native-record axis: workspace-rooted target path resolution, per-session
  staging directory (under `videos/.staging/<sessionId>-<ISO>/` so
  Playwright's auto-named file doesn't pollute the user-facing
  `videos/` dir), state machine, BYOB refusal, and `finalizeVideoOnClose`
  (calls `page.video().saveAs(targetPath)` for a deterministic output
  filename on session teardown).
- **`src/session/types.ts`** — `SessionOptions.recordVideo` added
  (Playwright-shaped `{dir, size?}` — the upstream `buildRecordVideoOption`
  resolves the user-facing target path + staging dir).
- **`src/session/managed.ts` + `src/session/incognito.ts`** — pass
  `recordVideo` through to `chromium.launchPersistentContext` /
  `browser.newContext` when set.
- **`src/session/registry.ts`** — `SessionEntry.video` (per-session
  `VideoRecorderState`) + `OpenSpec.recordVideo` added.
- **`src/server.ts`** — open_session factory resolves `recordVideo` at
  creation, refuses cleanly on `attached`, and finalizes the recording on
  teardown via `finalizeVideoOnClose` (called after `context.close()`
  triggers the .webm flush). New `stop_video` + `get_video` MCP tools
  registered; `open_session` schema extended with `recordVideo`.
- **`src/util/capabilities.ts`** — `stop_video` + `get_video` mapped to
  the existing `file-io` capability (sibling of `upload_file` /
  `download_get` — no new capability gate to enable).
- **`docs/tool-reference.md`** — Video recording section under "Advanced
  tools" documenting the lifecycle, BYOB refusal, and inline cap.

### Unchanged

- The native HAR path, the storage / artifact / download primitives, the
  capability set, and every other adopter-visible surface are byte-
  identical for sessions that don't pass `recordVideo`. Strictly additive.


## v0.3.3 — 2026-05-30 — `x-browx-source.query` retired

Reconciliation round (R-5) follow-up from wrightxai bench adoption: a
smoke trial saw an LLM-authoring SDK consumer author
`x-browx-source: { query: "the number of comments on this story…" }` for
a per-row numeric field on Hacker News. The resolver returned `null` for
every one of the 30 rows (the tree-scan ranker picked one a11y node and
re-used it across all per-row scopes — no `partialMiss` was surfaced
because the scan still "matched" something). The judge correctly
rejected the result and the agent burned 14 revisions / 45,746 tokens
before giving up. Same shape of defect as R-1's `mode:"llm-assisted"`:
advertised in the SDK surface, unreliable at runtime, no actionable
diagnostic on the first failure.

### Retired

- **`x-browx-source.query` (per-field)** — the explicit prose-style
  natural-language query on a leaf property is retired at the typed SDK
  boundary. The MCP `extract` tool's zod schema is unchanged (graceful
  deprecation per the "never hard-break config-input APIs" policy — the
  wire schema still accepts the key), but the typed `ExtractSourceHint`
  marks `query` as RETIRED in JSDoc, and the MCP tool description /
  `schema` parameter description no longer advertise the key to
  authoring agents. Use `x-browx-source.selector` (raw CSS) for explicit
  per-field targeting; the implicit "property name = query" lowering is
  unchanged for testid-rich pages.

### Changed

- **`src/page/extract.ts`** — `resolveLeaf` now distinguishes the
  implicit lowering (set by `resolveObject` from the property name) from
  an explicit user-authored `x-browx-source.query` via a module-private
  Symbol marker. When an explicit `query:` is encountered it emits a
  one-shot `console.warn` and records a per-field `partialMisses` entry
  naming the field and pointing the caller at `selector`, then proceeds
  with the existing tree-scan resolution (so any adopter whose page
  happens to satisfy the scan still gets a value alongside the
  diagnostic — graceful, never hard-break).
- **`src/server.ts`** — the `extract` MCP tool description and `schema`
  parameter description drop `query` from the listed `x-browx-source`
  keys and flag the retirement + runtime tolerance behaviour.
- **`docs/tool-reference.md`** — explicit-escape-hatch section updated
  to drop `query` from the list and flag the retirement.

### Unchanged

- The implicit "property-name = query" lowering path is unaffected — the
  module-private Symbol marker isolates the retirement behaviour to
  user-authored explicit `query:` hints only.
- All other `extract` semantics (schema lowering, `selector`/`attr`/
  `prop`/`text`/`value`/`collection` hints, `BROWX_EXTRACT_STRICT`,
  failure-kind taxonomy) are untouched.
- Array `x-browx-source.collection` still accepts a CSS selector OR a
  tree-scan query (the array-level NL fallback was not the failure mode
  R-5 traced — the wrightxai smoke trial's `collection` was the
  reliable `"tr.athing"` CSS).

## v0.3.2 — 2026-05-29 — `extract.mode` retired

Reconciliation round (R-1) follow-up from wrightxai bench adoption: the
LLM-authoring SDK consumer saw `mode` in the typed `ExtractArgs`
signature, tried `"llm-assisted"` as a fallback when deterministic
returned partial results, and burned multiple LLM turns on the resulting
`kind:"llm-assisted-not-implemented"` rejection. Removing the mode from
the typed surface (so the LLM stops seeing it) while tolerating it at
runtime (so existing adopters don't break) is the graceful-deprecation
fix.

### Retired

- **`ExtractArgs.mode`** — the SDK type no longer carries the field.
  Deterministic was always the only working path; the `"llm-assisted"`
  literal was a typed-but-unimplemented seam that confused authoring
  agents into trying it. The MCP `extract` tool's zod schema still
  accepts the field at the wire layer (graceful-deprecation, per the
  "never hard-break config-input APIs" policy), but the typed SDK no
  longer surfaces it — new code should drop the arg.

### Changed

- **`src/page/extract.ts`** — `extract({ mode: "llm-assisted" })` no
  longer returns a structured `kind:"llm-assisted-not-implemented"`
  failure. Instead it emits a one-shot `console.warn` and falls through
  to the deterministic path, returning whatever deterministic mode would
  have returned. The `"llm-assisted-not-implemented"` failure kind
  remains in the `ExtractFailure["kind"]` union as a retired-but-defined
  label for back-compat narrowing; v0.3.2 stops emitting it.
- **`docs/tool-reference.md`** — `extract.mode` section updated to flag
  the retirement + tolerance behaviour.

### Unchanged

- All other `extract` semantics (schema lowering, `x-browx-source`
  hints, `BROWX_EXTRACT_STRICT`, the failure-kind taxonomy beyond the
  retired entry) are untouched.

## v0.3.1 — 2026-05-29 — typed SDK surface (additive)

Patch on top of v0.3.0's SDK Stage A. Pure type-layer change — no runtime
behaviour change. The `BrowxaiClient` interface now carries per-tool
argument and result-data types instead of the Stage-A
`(args: BrowxaiArgs) => Promise<BrowxaiResult>` uniform shape, because the
emitted `.d.ts` is the canonical reference for LLM-authoring consumers
(wrightxai's lowering step generates TypeScript that imports from this surface).

### Added

- **`src/sdk/tool-types.ts`** — per-tool argument interfaces
  (`NavigateArgs`, `FindArgs`, `VerifyTextArgs`, `ClickArgs`, …) and
  result-data interfaces (`FindResultData`, `VerifyResultData`,
  `ActionResultData`, …) covering every stable tool in the curated
  `SDK_TOOLS` registry. Capability-gated tools (`eval_js`, `network_body`,
  `upload_file`, `register_secret`) also get typed arg interfaces for
  consumers calling them through `callTool`.
- **`Target` / `RefTarget` unions** — exact-one-of `ref|selector|named|coords`
  shape. The type layer now rejects malformed calls like
  `client.verify_text({ text: "…" })` (missing target) at compile time.
- **`exports`** in `package.json` routes the `types` condition to
  `dist/index.d.ts` so bundlers/IDEs that don't fall back to the legacy
  top-level `"types"` field pick up the typed surface.
- **`test/sdk/types.test.ts`** — vitest `expectTypeOf` probes pinning the
  per-tool method signatures + result-data shapes.

### Changed

- `BrowxaiClient` method signatures are now specialised per tool. The
  Stage-A `(args: BrowxaiArgs) => Promise<BrowxaiResult>` shape is gone
  from the typed surface — `callTool(name, args)` remains as the
  open-ended escape hatch.
- `buildClient`'s runtime walker is unchanged. The dispatch path still
  forwards `(args?) => transport.dispatch(name, args)`; per-method TS
  signatures only narrow at the type layer.

### Unchanged (carry-overs from Stage A)

- Capability gate at the SDK boundary.
- Per-session isolation, egress sanitisation, `<SECRET_NAME>` substitution.
- All 954 existing unit tests + 8 keystone tests pass.
- No new tool registrations; no new capability.

## v0.2.3 — 2026-05-28 — extract() schema-dialect relaxations + strict opt-in

Patch release, layering on v0.2.2's diagnostic improvements. Ships the
three contract-affecting proposals deferred in v0.2.2's
`docs/extract-ergonomics-proposal.md` (Proposals A / B / D), now
explicitly authorized by the owner. **Two of the three (A, B) loosen
the contract** — previously-rejected schema shapes now succeed; flagged
explicitly. The third (D) is opt-in only and tightens unknown-key
diagnostics into hard rejections when enabled.

### Schema-dialect relaxations (additive — previously-failing now succeeds)

- **`type:"integer"` is auto-coerced to `type:"number"`** (Proposal A).
  v0.2.2 rejected `integer` with `invalid-schema` + a "did you mean
  number?" hint; v0.2.3 silently coerces and records an educational
  note in `evidence.partialMisses`:
  `"<path>: schema 'integer' coerced to 'number' for forward-compat;
  use 'number' explicitly in future schemas"`. The validator still
  rejects `integer` at the lower-level `validateSchema()` API — the
  coerce runs as a preprocessing pass inside `extract()` before
  validation. Adopters relying on the rejection for typo-detection
  should opt into Proposal D below.
- **`x-browx-source.selector` on array schemas is now an alias for
  `x-browx-source.collection`** (Proposal B). `selector` on an array
  was silently dropped under v0.2.2 (the resolver only reads
  `collection` for arrays); v0.2.3 promotes it. When both are present,
  `collection` wins (the canonical name) and the redundant `selector`
  is stripped from the merged hint. No partialMisses note for this
  case by design — the alias is idiomatic, not typo-like.

### Strict mode (opt-in — tightens unknown-key diagnostics)

- **`BROWX_EXTRACT_STRICT=1` env opt-in** (Proposal D). When the env
  var is set at server boot (or `strictUnknownHintKeys:true` is passed
  per-call), v0.2.2's `unknown \`x-browx-source\` key` diagnostics are
  PROMOTED from soft `evidence.partialMisses` entries to hard
  `ok:false` `{kind:"invalid-schema"}` rejections. The integer-coerce
  note (A) and the array-`selector`-alias (B) are NOT promoted —
  those are educational signals, not typo-like errors. Boot emits a
  loud warn: `"browxai: BROWX_EXTRACT_STRICT=1 — extract()
  unknown-\`x-browx-source\`-key warnings are PROMOTED to hard ok:false
  invalid-schema rejections"`. Default off — preserves v0.2.2 behavior
  out of the box.

### Tool description (MCP-side)

- The `extract` tool description (`server.ts`) now reflects the new
  semantics: (a) `integer` accepted as a schema-dialect alias (with
  the `partialMisses` note), (b) `selector` on arrays accepted as an
  alias for `collection` (with `collection` winning on conflict), and
  (c) the `BROWX_EXTRACT_STRICT=1` opt-in for first-class typo
  rejection.

### Tests

- 14 new regression tests in `src/page/extract.test.ts` pin the new
  behavior, including the exact wrightxai trial-1 turn-2 schema shape
  (`integer` for rank/points/comments_count). One existing test
  (`returns invalid-schema when type is unsupported`) updated to use
  `type:"null"` since `type:"integer"` no longer rejects. Suite total:
  920 → 934.

### Contract notes (for adopters)

- An adopter test asserting `{type:"integer"} → ok:false` would flip —
  it now succeeds with `data:<number>` + an `evidence.partialMisses`
  note. If you relied on the rejection as a typo gate, set
  `BROWX_EXTRACT_STRICT=1` (which catches typo-like unknown keys but
  NOT the integer-coerce — those are different problem classes).
- An adopter using `selector` on an array expecting it to do nothing
  would see the array now resolve as a collection. If `selector` was
  emitted intending leaf-`selector` semantics (which never applied to
  arrays), the data shape change is exactly the previously-intended
  outcome — i.e. the schema is no longer silently broken.

### Closing the open question

The v0.2.2 close-out flagged the `evidence.partialMisses` growth as a
strict-sense contract change. v0.2.3 extends the same posture: the
relaxation notes are additive entries on the previously-succeeding
path, and the strict-mode rejection is opt-in only. The
`docs/extract-ergonomics-proposal.md` file is updated to mark all
three proposals shipped.

## v0.2.2 — 2026-05-28 — extract() schema-discovery ergonomics

Patch release. Public-API contract is **unchanged** — `extract()` args, return
shape, and `{ok, data, evidence, tokensEstimate}` / `{ok:false, failure}`
semantics are byte-identical to v0.2.1. Validator error messages and
`evidence.partialMisses` diagnostics improve; nothing previously-succeeding
now fails, and nothing previously-failing now succeeds. Trigger: wrightxai
early-trial schema-discovery burned ~3-5k output tokens across three turns
learning the schema convention from scratch (rejected `integer`, learned
arrays need `x-browx-source.collection`, silently mis-spelled `attr` as
`attribute` causing wrong leaf values).

### Diagnostics

- **Unknown `x-browx-source` keys now surface as `evidence.partialMisses`
  entries** — schemas that use, e.g., `{selector:"a", attribute:"href"}`
  (instead of `attr`) or `{selector:"...", transform:"int"}` (which is
  wholly unsupported) previously had the unknown key silently dropped,
  letting the resolver fall back to innerText for the leaf — producing
  silently-wrong values like `url: <title-text>`. The resolver still
  silently drops them at the read-leaf path (contract preserved) but a
  diagnostic now lands in `evidence.partialMisses` on the same
  observation: `"url: unknown \`x-browx-source\` key \`attribute\`;
  did you mean \`attr\`?"`. Common typos get suggestions
  (`attribute` → `attr`, `property` → `prop`, `css` → `selector`,
  `label`/`name` → `query`, `container`/`list` → `collection`); others
  list the known-key set.

### Validator errors

- **Unsupported `type` values now suggest the closest valid alias.**
  `{type:"integer"}` is still rejected with `invalid-schema` (contract
  preserved), but the message now reads `"unsupported \`type\` \"integer\"
  (supported: object, array, string, number, boolean) — did you mean
  \"number\"?"`. Same hints for `bool` → `boolean`, `str`/`text` →
  `string`, `list`/`tuple` → `array`, `dict`/`map`/`record` → `object`,
  `int`/`float`/`double`/`long` → `number`.
- **`array` partial-miss now describes what `collection` is.** Was:
  `"items: array needs \`x-browx-source.collection\`"`. Now: `"items:
  array needs \`x-browx-source.collection\` (a CSS selector or NL query
  for the row container; each match becomes a per-row scope for
  \`items\`)"`. Same `ok` outcome, same `partialMiss` semantics — just
  carries the fix on the same observation.

### Tool description (MCP-side)

- The `extract` tool description now (a) enumerates the closed type set
  up-front, (b) explicitly calls out `integer` as NOT supported (with the
  "use `number`" guidance), (c) lists the full `x-browx-source` key set
  with `NOT attribute` / `NOT property` callouts, (d) flags that
  `transform`/`format`/`regex` are not supported (the leaf coercer handles
  `"$1,234.50" → 1234.5` for `type:"number"` automatically), and (e)
  states that `collection` is REQUIRED on every array.

### Tests

- 9 new regression tests in `src/page/extract.test.ts` pin the new
  diagnostic behavior + validator suggestions, including the exact
  schema shape the wrightxai trial-1 agent emitted on turn 6
  (`attribute` + `transform` typos). Suite total: 912 → 920 (8 net new
  after one existing test gained a stricter assertion).

### Deferred — owner sign-off needed

- Three contract-affecting follow-ups are documented in
  `docs/extract-ergonomics-proposal.md`: (A) auto-coerce
  `type:"integer"` → `type:"number"` with a warning, (B) treat
  `x-browx-source.selector` on arrays as an alias for `collection`,
  (C) `BROWX_EXTRACT_STRICT=1` that turns unknown-key diagnostics into
  hard rejections. (D) a simpler `dialect:"plain"` is sketched for
  v0.3.x scope, not patch.

## v0.2.1 — 2026-05-27 — find() probe-loop wall-clock fix

Patch release. Public-API contract is **unchanged** — `find()` args, return
shape, and ranked-candidates + evidence + actionable semantics are byte-identical
to v0.2.0. Internal-only fix to the per-candidate probe loop.

### Performance

- **`find()` per-candidate probe loop** — the candidate-evaluation step now
  caps each Playwright probe call (`locator.boundingBox`, `locator.isEnabled`)
  at a tight `PROBE_TIMEOUT_MS` (500 ms) and runs the top-N candidate pool in
  parallel via `Promise.all`. Previously the loop probed candidates serially
  and each probe call inherited Playwright's `actionTimeout`. When a
  DOM-walk-sourced candidate's selector hint didn't resolve to a real
  Playwright locator (e.g. `role=a[name="..."]` — DOM-walk emits the bare tag
  as `role`, which isn't a valid ARIA role token), the probe would auto-wait
  the full action-timeout window before returning. In default operation
  `find()` was already capped by the outer 5 s `actionTimeoutMs` anti-wedge
  but consumed it in full on pages with fall-through-role candidates; without
  the cap, each probe would auto-wait the action timeout (5 s default) and
  the 60 s W-M1 anti-wedge deadline would clip in pathological cases.
  Observed local benchmarks (headless Chromium, incognito session, default
  capability set):

  | target                                                   | before (5 s actionTimeoutMs) | after   | factor |
  | -------------------------------------------------------- | ---------------------------- | ------- | ------ |
  | `https://example.com`                                    | ~5000 ms                     | ~520 ms | ~10×   |
  | `https://en.wikipedia.org/wiki/Main_Page`                | ~5000 ms (deadline-clipped)  | ~560 ms | ~9×    |

  No contract change: `find()` still returns the same `{ candidates, warnings }`
  shape with the same per-candidate fields. A candidate whose probe times out
  is treated identically to one whose probe returned `null` (best-effort —
  the call site already swallowed errors). Internal `locatorBoundingBox` gains
  an optional `timeoutMs` argument with a backward-compatible default of 500 ms.

### Tests

- Added a regression-style perf assertion to the headless-CI keystone:
  `find() against a fall-through-role candidate completes well under the
  anti-wedge deadline` bounds the call at 3 s (observed post-fix: well
  inside 1 s; bound chosen for CI headroom). The assertion targets a fixture
  node (`<a>More info link</a>`, no testid) whose DOM-walked role-locator is not a
  valid ARIA role, so its probe path is exactly the one the cap protects — a
  regression in `PROBE_TIMEOUT_MS` would surface as a keystone failure rather
  than a silent wall-clock degradation.
### Fixed

- **`screenshot_marks` bare-ref fallback no longer wedges 30 s per unresolved
  ref.** Same wedge class the `find()` perf fix above addresses, surfaced on a
  different call site. The CDP `visibleRect` path can return null for synthetic
  a11y refs whose accessible-tree node has no real DOM backing (e.g. the
  document root `RootWebArea`). The Playwright `locatorBoundingBox` fallback
  was then invoked with a hint like `role=RootWebArea[name="…"]`, which matches
  no element — and Playwright's `boundingBox()` auto-waits 30 s (default
  action timeout) before returning null on a non-matching selector. So each
  unresolvable bare-ref candidate added 30 s of dead time to the
  `screenshot_marks` call. Public-target probe before fix: `example.com` →
  60 s per call, `wiki` → 60 s, `mdn` → handler timeout. After (with the
  unified `locatorBoundingBox({ timeoutMs })` cap above): 2 s / 2 s / 3 s on
  the same targets. `screenshot_marks`'s bare-ref fallback passes
  `timeoutMs: 1000` explicitly (a touch looser than the unified 500 ms default
  because the fallback runs at most once per unresolved ref, not in a hot
  per-candidate loop). Public contract unchanged — same `{marks, mapping,
  warnings, imageBase64}` shape, same namespace-sharing semantics. The
  fast-path (caller-supplied bbox via a prior `find()` row) was never
  affected and remains the recommended call pattern for hot loops.

## v0.2.0 — 2026-05-26 — Agentic-browser substrate baseline parity

Baseline-parity release. Adds 24 primitives across observation,
network/CPU emulation, device emulation, persistence, eval, security, and
agent-ergonomics — closing the gap against Stagehand / browser-use / Skyvern /
Browserbase / @playwright/mcp / chrome-devtools-mcp / Vercel `agent-browser`.
v0.1.0 stable surface is **unchanged** — every addition is net-additive; no
hard-break. Default capability set is unchanged (`read`/`navigation`/`action`/
`human`); new posture-broadening capabilities (`stealth`, `captcha`, `extensions`,
`credentials`) are off-by-default and loud-warned.

### Added

- **`mouse_wheel`** — coordinate-space wheel event sibling of `mouse_down` /
  `mouse_move` / `mouse_up`. Dispatched via CDP
  `Input.dispatchMouseEvent` (`type: "mouseWheel"`) at the caller-supplied
  `coords` (viewport CSS px) regardless of the current pointer position, with
  `deltaX` / `deltaY` in CSS px following the DOM `WheelEvent` convention
  (positive `deltaY` scrolls content up); at least one delta must be non-zero.
  Closes the gap for canvas, virtualised lists, and map tiles that listen for
  `wheel` and ignore the element-level `scroll` path. Net-additive — one new
  tool under capability `action`. See
  [docs/tool-reference.md § Pointer gestures](docs/tool-reference.md#pointer-gestures--drag--double_click--mouse_down--mouse_move--mouse_up--mouse_wheel).
- **`pdf_save`** — print the current page to a workspace-rooted PDF via
  Playwright `page.pdf()` (CDP `Page.printToPDF` under the hood). The mirror
  of `upload_file`: file-io OUT instead of IN — the first-class alternative
  to screenshot-and-OCR or driving the browser's print-to-file dialog through
  `shortcut`. Defaults match what an agent reaching for "save the page as a
  PDF" expects without reading the docs: `format:"A4"`, `scale:1`,
  `printBackground:false` (matches browser-print's default; opt in when
  background colour / imagery matters). `path` is resolved **inside
  `$BROWX_WORKSPACE` only** (escape rejected, same resolver as `start_har` /
  `dump_storage_state`); omit it for a default `pdfs/<sessionId>-<ts>.pdf`.
  `format` accepts every Playwright paper preset (`Letter` / `Legal` /
  `Tabloid` / `Ledger` / `A0`–`A6`); `scale` is bounded `[0.1, 2.0]`
  (Playwright's CDP-layer clamp; out-of-band values rejected up-front with a
  clearer error). Net-additive — one new tool under capability `action`,
  no new capability gate. **Chromium constraint:** `page.pdf()` is
  Chromium-only (every browxai session is Chromium so that's fine), and the
  tool layer refuses cleanly on `attached` / BYOB sessions before any
  Playwright call is made — driving PrintToPDF on a human's own Chrome would
  surface a print dialog / mutate window state. Open a managed
  (`persistent` / `incognito`) session and re-run there. See
  [docs/tool-reference.md § `pdf_save`](docs/tool-reference.md#pdf_save--path-format-scale-printbackground-session-).
- **`heap_snapshot` / `heap_retainers`** — V8 heap snapshots + retainer queries.
  `heap_snapshot` wraps CDP `HeapProfiler.takeHeapSnapshot` and writes a
  workspace-rooted `.heapsnapshot` JSON (the format `chrome://inspect`'s Memory
  panel consumes on drag-and-drop); `heap_retainers` parses a written snapshot
  in-process and reports top retainers (sorted by retainer self-size desc,
  capped at 50) of nodes matching a `{ name?, type?, nameMatch? }` query —
  directly answers "who's still holding these objects alive?" without paging
  through DevTools' Memory panel. One-shot, not a start/stop pair (a heap
  snapshot is a point-in-time capture). At least one of `query.name` / `type`
  is required — match-everything is never the right answer. Workspace-rooted
  paths only; explicit `path` rejected if it escapes `$BROWX_WORKSPACE`. Both
  under capability `action` (kept under the same capability so a memory-leak
  diagnosis batch — trigger interaction → `heap_snapshot` → `heap_retainers`
  — doesn't have to juggle two grants); both batch-allowed. Bring-your-own
  snapshot works: any `.heapsnapshot` exported from DevTools or saved by CI
  parses through the same retainer query. See
  [docs/tool-reference.md § V8 heap snapshots](docs/tool-reference.md#v8-heap-snapshots--heap_snapshot--heap_retainers).
- **`fill_form`** — multi-field form-fill primitive. Fills N field/value pairs
  atomically in one action window, with an optional final `submit` click —
  replaces the fill / fill / fill / click round-trip pattern with a single
  dispatch and covers roughly 80% of real form work in one tool call. The
  action-window envelope (navigation / structure / console / network /
  snapshotDelta) is identical to a single `fill`; per-field probes accumulate
  on a new `elements: ElementProbe[]` slot in dispatch order. **Atomic
  pre-resolution**: every field's target — and the submit target, if supplied
  — is resolved BEFORE any DOM write lands; if any target misses, the call
  returns `ok:false` with a structured `fieldResolution: [{ index,
  targetSummary, ok, error? }]` block and **no partial fills happen**. The
  same atomic posture extends to secrets materialisation: a rejection on
  field 3 doesn't leave fields 0..2 typed. Mid-loop fill failures surface a
  `fillFailure: { atIndex, skipped: number[] }` slot so the agent can see how
  far the dispatch got and that the submit was correctly skipped. Composes
  with the existing secrets registry (a field value like `<SECRET_NAME>`
  substitutes at dispatch; the recorded descriptor + probe carry the alias,
  never the real value). Field targets accept `ref`/`selector`/`named` (no
  `coords` — fill needs a real input element). Capability `action`. Also in
  the `batch` whitelist. See [docs/tool-reference.md §
  `fill_form`](docs/tool-reference.md#fill_form-fields-submit-opts).
- **`seed_random`** — per-session deterministic `Math.random` override. Injects
  a Mulberry32 PRNG via Playwright `context.addInitScript`, seeded by the
  caller-supplied integer in `[0, 2^32 - 1]`. The current page's main realm is
  re-seeded immediately so the effect is visible without navigating; every
  subsequent document in the session bootstraps the same override. Per-session;
  persists across navigation (re-applied on main-frame `framenavigated` for
  symmetry with `network_emulate` / `clock`). Net-additive — one new tool under
  capability `action`. **MVP scope:** only `Math.random` is touched —
  `crypto.randomUUID` / `crypto.getRandomValues` are left alone (web-crypto is
  a much bigger deterministic-stub surface for a future tool). Workers are out
  of scope. In BYOB / `attached` session mode the override is installed on the
  attached Chrome's context for as long as the context lives — surfaced as a
  `warning` on the result. Also in the batch whitelist so agents can compose
  `seed_random → action → …` in a single batch. See
  [docs/tool-reference.md § Deterministic `Math.random`](docs/tool-reference.md#deterministic-mathrandom--seed_random).
- **`screenshot_marks`** — composed PNG with numbered bounding boxes painted
  over caller-supplied candidates: the set-of-marks primitive multimodal
  agents reach for when they want to ground a vision read against a small
  palette of stable refs ("click 2" instead of estimating a coordinate).
  Each candidate is either a bare `{ref}` (looked up against the current
  snapshot for its bbox) or a full `find()` candidate row passed through
  (fast path). `label:"index"` (default) paints 1..N array positions paired
  with an `{index→ref}` mapping in the result; `label:"ref"` paints the
  existing `eN` directly; `label:"role"` paints the role for visual
  grounding. **The numbering scheme shares the existing `name_ref` / `eN`
  namespace** — no parallel ID space — so `mapping["2"] === "e7"` and an
  agent can address either way. Painted bboxes match `find().evidence.bbox`
  (so visible-rect intersection applies — see `src/page/bbox.ts`). Pure
  compose on top of `find()` / `snapshot()`; the only browser interaction
  is a transient in-page overlay installed for the duration of the
  screenshot and removed before return. Net-additive — one new tool under
  capability `read`; also in the batch whitelist. See
  [docs/tool-reference.md § Visual regions](docs/tool-reference.md#visual-regions--cross-session--session-report).
- **`flake_check`** — run the same call sequence N times and report what
  shifted between runs, for diagnosing intermittent CI flakes BEFORE chasing
  them through logs. Composes existing primitives — `batch`'s dispatch loop
  is the inner runner; the cached-selector artifact reuses the
  `ActionDescriptor` shape from `plan`/`execute`. Each repetition runs with
  `stopOnError:false` internally so a mid-sequence failure does NOT hide the
  variance picture for later steps. Returns per-step success-rate, distinct
  errors, distinct resolution signatures, the earliest `firstDivergence`
  step where `ok` differed across runs, and a `cachedResolvers[]`
  self-heal artifact — `{step → resolved ref/selectorHint}` for steps
  where every reaching-this-step run agreed AND succeeded, with `plan` steps
  carrying the full descriptor projection so a follow-up `execute()` can
  consume the cache after re-snapshotting. `stopOnAllGreen: K` short-circuits
  when K consecutive runs are all-green. `n` is bounded `[3, 20]`. Capability
  `action` (the inner whitelist mirrors `batch`; nested `batch` / `flake_check`
  rejected; each inner tool's own gateCheck still fires through the batch
  handler map). See [docs/tool-reference.md §
  `flake_check`](docs/tool-reference.md#flake_check-calls-n-stoponallgreen).
- **`session_metrics`** — per-session cumulative tool-call rollup. One read-only
  tool, capability `read`. Returns `{callsByTool, durationMsByTool,
  errorsByTool, tokensEstimateSum, capabilityDenials, sessionStartedAt,
  sessionDurationMs}`. Accumulated server-side in the existing dispatch
  wrapper — no new instrumentation in tool handlers, no per-call disk writes;
  piggybacks on the per-call `tokensEstimate` envelope field and the dispatch
  latency the wrapper already measures. Pairs with `export_session_report`:
  that one bundles the session's **QA evidence** (url, console errors, recent
  network summary, named regions, live sessions); this one rolls up the
  session's **dispatch evidence** (what the agent ran, how token-expensive it
  got, what got refused at the capability gate, which tools kept erroring).
  `capabilityDenials` is intentionally a session-wide scalar, not per-tool —
  the denial shape is a property of the capability config, not the tool, so
  the count alone is the actionable signal. `errorsByTool` counts `ok:false`
  results that were NOT capability denials. Available in the `batch`
  whitelist for compose-and-measure flows. Replay-artifact pairing: an
  **rrweb / video session replay** primitive (a la Browserbase) is not
  shipped in this cycle — `session_metrics + export_session_report` covers
  the JSON/numeric audit half; recording the visual stream is a bigger lift
  tracked separately. See
  [docs/tool-reference.md § Visual regions + cross-session + session report](docs/tool-reference.md#visual-regions--cross-session--session-report).

- **`stealth` capability + `captcha` capability + `solve_captcha`** —
  two new off-by-default capabilities, same posture class as `eval` /
  `network-body` / `secrets` / `extensions`. Both loud-warned at server
  boot, both name the legal/ToS exposure explicitly.
  - **`stealth`** is a *behaviour gate* (no new tool): when enabled,
    every browser context loads a per-context init script that
    overrides the well-known Playwright fingerprint surface
    (`navigator.webdriver`, `navigator.plugins`, `navigator.languages`,
    `window.chrome`) BEFORE any page script runs. Patches use
    `configurable:true` so legitimate code can still inspect/replace
    them; idempotent via a `window.__browx_stealth` sentinel. browxai
    does NOT bundle a general-purpose anti-fingerprinting library
    (e.g. puppeteer-extra-stealth) — only the four well-known patches
    above. The init script is also re-applied on the `extensions_*`
    rebuild path so stealth survives a context rebuild. See
    [docs/tool-reference.md § Stealth fingerprint patches](docs/tool-reference.md#stealth-fingerprint-patches-capability-stealth).
  - **`captcha`** gates ONE new tool, `solve_captcha({type, selector?,
    siteKey?, imageBase64?})`, which **delegates** the challenge to an
    **external provider configured per-deployment via environment
    variables** (`BROWX_CAPTCHA_PROVIDER` ∈ {`2captcha`, `capmonster`}
    + `BROWX_CAPTCHA_API_KEY`; optional `BROWX_CAPTCHA_API_BASE` /
    `BROWX_CAPTCHA_TIMEOUT_MS` / `BROWX_CAPTCHA_POLL_MS`). The protocol
    target for v0.2.0 is the **2Captcha-compatible REST API**
    (`/in.php` submit + `/res.php` poll) which CapMonster Cloud
    mirrors drop-in; other providers (AntiCaptcha's
    `/createTask`/`/getTaskResult`, etc.) are extensible — add a
    branch in `src/page/solve-captcha.ts`. browxai **does NOT bundle a
    solver** and **does NOT auto-purchase credits** — when the
    capability is on but no provider is configured, the tool returns a
    structured `{ok:false, error:"no captcha provider configured",
    hint:…}` rather than guessing. Supported challenge types:
    `recaptcha2`, `recaptcha3`, `hcaptcha`, `turnstile`, `image`. The
    agent is responsible for wiring the returned `solution` back into
    the page; we do NOT auto-submit. Solutions pass through the
    per-session secrets registry mask on egress. See
    [docs/tool-reference.md § Captcha solver delegation](docs/tool-reference.md#captcha-solver-delegation-capability-captcha)
    and [docs/threat-model.md](docs/threat-model.md).
- **`get_totp` / `get_credential` (capability `credentials`)** — pluggable
  hook into an operator-configured credentials / TOTP vault. Without this,
  agents driving real auth flows block on 2FA; baking seeds into the prompt
  defeats W-V12 secrets-masking by leaking them into transcripts.
  Off-by-default; loud-warned at server boot. Provider matrix selected via
  `BROWX_CREDENTIALS_PROVIDER`: `oathtool` (default — self-managed seeds
  via `BROWX_OATHTOOL_SEEDS`, no paid dependency), `1password` (shells out
  to `op`), `bitwarden` (shells out to `bw`), `lastpass` (shells out to
  `lpass`), `none` (explicit no-op for testing the surface). Provider is
  **per-deployment, never bundled, never auto-installed** — a missing CLI
  surfaces a structured `{ok:false, error, hint}` with the install
  instruction per call (no startup crash). All shell invocations use fixed
  argv (no shell interpolation, account passed as a discrete argv
  element). 5-second per-call wall-clock so a hung CLI can't block
  dispatch. `get_credential` ADDITIONALLY requires the `secrets`
  capability — the looked-up password is auto-registered into the W-V12
  registry under `<PASSWORD_<account>>` and masked across every egress
  sink; the return value carries `aliasName`, NEVER the cleartext
  password. Without `secrets`, the lookup refuses rather than leak. Same
  posture class as `eval` / `network-body` / `secrets`. See
  [docs/tool-reference.md § Credentials hook](docs/tool-reference.md#credentials-hook-capability-credentials)
  and [docs/threat-model.md](docs/threat-model.md).
- **Per-session artifact KV** — three new tools (`artifact_save`,
  `artifact_get`, `artifact_list`) for first-class save/get/list of
  session-scoped string or binary payloads (the "build your own library
  over time" loop). Before this lane, agents round-tripped scripts/files/
  blobs through `name_ref`/`name_region` — both ref-typed and a poor fit
  for raw bytes. Workspace-rooted at
  `$BROWX_WORKSPACE/.artifacts/<sessionId>/<name>`; name restricted to
  letters/digits/`._-` (no separators, no `..`, no leading dot —
  workspace-escape rejected). `encoding:"base64"` round-trips binary
  payloads faithfully. Capacity-bounded per session — **200 entries**
  AND **50 MiB total**; past either cap the oldest-write entry is evicted
  so a runaway loop can't exhaust the disk. Cleared on `close_session`
  (wiped subdir; sessions that never wrote an artifact leave no trace).
  Capability split: `artifact_save` → `action`; `artifact_get` /
  `artifact_list` → `read`. No new capability gate.
  See [docs/tool-reference.md § Per-session artifacts](docs/tool-reference.md#per-session-artifacts--artifact_save--artifact_get--artifact_list).
- **`clock`** — per-session virtual-clock control via CDP
  `Emulation.setVirtualTimePolicy`. Three modes: `freeze` pauses virtual time
  at `atIso` (or wall-clock now if omitted) so date-sensitive flows
  (renewal dates, "today" filters, scheduling, expiry edges) read a known
  instant; `advance` jumps the clock by `byMs` (relative, max 1 year) or to
  absolute `atIso` and re-pins; `release` resumes real time. Net-additive —
  one new tool under capability `action`. Persists across navigation
  (re-applied on main-frame `framenavigated` in case CDP drops it after a
  renderer swap). Independent of `network_emulate` / `cpu_emulate` — compose
  freely. In BYOB / `attached` session mode the policy stays in effect on the
  attached Chrome until released, reloaded, or the page is closed — surfaced
  as a `warning` on the result (a frozen wall-clock-looking page is a
  debugging trap). Also in the batch whitelist so agents can compose
  freeze → action → release in a single batch. See
  [docs/tool-reference.md § Clock control](docs/tool-reference.md#clock-control--clock).
- **HAR record / replay** — full-session reproducibility. Two new MCP tools
  + an additive `open_session` schema extension; all under capability `action`.
  - `start_har({path?, mode?, content?, urlFilter?})` — begin HAR recording on
    a live session via `context.routeFromHAR(path, {update:true})`. Default
    path `<workspace>/har/<session-id>-<ISO>.har`; workspace-escape rejected.
    Re-calling on an already-active recorder transparently flushes the prior
    one and swaps targets (`replacedPrior:true` on the result).
  - `stop_har()` — remove the recording route. Returns the reserved path; if
    the .har is already on disk and ≤ ~256 KB it's also inlined on the result.
  - `open_session({har:{path?, mode?, content?, urlFilter?}})` — wire HAR at
    context creation via Playwright's native `recordHar` (the blessed path
    when the agent knows up-front it wants a HAR for the whole session).
    Honoured on `persistent` + `incognito`; ignored on `attached` (consumer's
    Chrome is not-owned — `start_har` is the BYOB runtime path). Once wired
    this way, `start_har` refuses + `stop_har` reports `nativeRecord:true` —
    the native primitive can't be toggled off mid-session.
  - `open_session({hars:["a.har", …]})` — REPLAY HAR(s) against the new
    session. Each file is wired with `routeFromHAR(notFound:"fallback")`
    post-create — requests in the archive are served from it, anything
    missing falls through to live network. Workspace-rooted; a missing file
    errors (no silent fallback on a typo).
  - **Finalize timing** — Playwright writes the .har on `context.close()`,
    so the canonical flow is `start_har → drive → stop_har → close_session`
    → read the .har. Every result carries `finalizesOn:"close_session"` so
    the constraint is visible rather than implicit.
  - Both recording tools are in the batch whitelist so agents can compose
    `start_har → navigate → … → stop_har` in one call. See
    [docs/tool-reference.md § HAR record / replay](docs/tool-reference.md#har-record--replay--start_har--stop_har--open_sessionhar--open_sessionhars).
- **`perf_start` / `perf_stop` / `perf_insights`** — per-session performance
  tracing on top of CDP `Tracing.start` / `Tracing.end`. Closes the "this
  click took 4s — why?" diagnostic gap that the read-only tools (snapshot /
  screenshot / network slice) leave open: they show *what* happened, not
  *why* it was slow. Net-additive — three new tools under capability
  `action` (no new capability gate). `perf_start({categories?})` arms the
  trace (default categories mirror DevTools' Performance panel:
  `devtools.timeline`, `loading`, `blink.user_timing`, frame, latency);
  `perf_stop({path?})` flushes a chromium-format JSON file under
  `<workspace>/perf-traces/<sessionId>-<ts>.json` (or an explicit
  workspace-rooted `path`, escape-rejected) plus a one-glance inline
  summary; `perf_insights({tracePath})` reads the file and extracts
  structured long-tasks (≥50 ms blocking, top-50), layout-shifts (per-shift
  score), render-blocking resources (CSS / sync-JS critical-path with
  duration), LCP candidates, and navigation milestones (FP / FCP / DCL /
  load) relative to `navigationStart`. The file format is exactly what
  DevTools' Performance panel and `chrome://tracing` consume — round-trips
  with the broader chromium ecosystem. **Idempotent by design:**
  `perf_start` while a trace is already running cleanly restarts (in-flight
  events discarded); `perf_stop` without a matching start returns
  `notRunning:true` rather than erroring. All three are also in the batch
  whitelist so an agent can express `perf_start` → action → `perf_stop` →
  `perf_insights` as a single batch. BYOB / `attached` mode: `perf_stop`
  releases the trace buffer on the human's Chrome (also cleaned up by
  `close_session` on the way out). See
  [docs/tool-reference.md § Performance tracing](docs/tool-reference.md#performance-tracing--perf_start--perf_stop--perf_insights).
- **`extensions_*` + `extensions` capability** — per-session unpacked-
  Chromium-extension management. Five tools, all under the off-by-default
  `extensions` capability (same posture class as `eval` / `network-body` /
  `secrets`): `extensions_install({path})` loads an unpacked extension
  directory into the session's managed-profile launch (`--load-extension`
  + `--disable-extensions-except`), `extensions_list()` returns the loaded
  set (`[{id,name,version,path,enabled}]`), `extensions_reload({id})`
  re-parses the manifest and restarts the context, `extensions_trigger(
  {id,command?})` opens the extension's default popup in the active page
  (the keyboard-command branch returns a structured "not supported" with
  workaround hint — Chromium does not expose extension keyboard-command
  dispatch via CDP), `extensions_uninstall({id})` removes it. Workspace-
  rooted path safety (traversal / absolute-outside / files / missing
  `manifest.json` all reject). Headed + persistent sessions only —
  `incognito` (Chromium does not load unpacked extensions in incognito)
  and `attached`/BYOB (the human's Chrome is not-owned) refuse with
  structured errors and operator-facing hints. install / reload /
  uninstall **rebuild the underlying browser context** (Chromium does
  not support adding or removing extensions on a live context): refs and
  console / network / ws buffers reset; profile state on disk survives.
  Loud one-time warning at server boot when the capability is on,
  naming the trust posture (extensions can read every page and make
  arbitrary network requests — trust-equivalent to the agent's own
  action surface). See
  [docs/tool-reference.md](docs/tool-reference.md#extensions-registry-capability-extensions)
  and [docs/threat-model.md](docs/threat-model.md).
- **`generate_locator`** — bridge a session-internal `eN` ref (from
  `snapshot()` / `find()` / `plan()`) into a **Playwright-string locator
  expression** an adopter can paste verbatim into a `.spec.ts`. Returns
  `{ ok, playwright, stability, components }` (or a structured
  `{ ok:false, failure:{ kind:"ref-not-found" } }` — no throw). The emitted
  string is real Playwright: `page.getByTestId('save-btn')`,
  `page.getByRole('button', { name: 'Save' })`,
  `page.locator('main > table > tbody > tr:nth-child(4)')`. `stability` uses
  the same five-tier vocabulary `find()` already emits (high = testid OR
  role+name; medium = stable structural / text on stable role; low =
  positional / role-only). `components` is the structured breakdown of the
  parts the string is built from (`testid` / `role` / `text` / `css`) — for
  adopters who want to compose their own locator. Quote-escaping is paste-safe;
  emitted strings + component values pass through the secrets-registry mask on
  egress (same posture as `find().selectorHint`). Read-only — reuses
  capability `read`, no new gate. Also in the `batch` whitelist. See
  [docs/tool-reference.md § generate_locator](docs/tool-reference.md#generate_locator).
- **Download capture — `downloads_capture` / `download_get`** — the reverse
  direction of `upload_file`. Off-by-default per session; toggled on with
  `downloads_capture({on:true})`. While on, every page-initiated download
  fired during a subsequent action is persisted to
  `$BROWX_WORKSPACE/.downloads/<sessionId>/<prefix>-<sanitised-name>` and
  surfaced on the new additive field `ActionResult.downloads[{id,
  suggestedFilename, mimeType, sizeBytes, path}]`. Read the bytes back
  (base64) via `download_get({id})`, or pass `pathOnly:true` for just the
  metadata. Page-supplied filenames are sanitised before composing the on-disk
  name (separators / NULs / leading dots / control bytes stripped, length
  capped, all-stripped → `"download"`); the raw value is preserved on the
  entry as `rawSuggestedFilename` when sanitisation diverged. Workspace-escape
  rejected — same posture as `upload_file`. Net-additive: two new MCP tools
  under the existing **`file-io`** capability (no new capability) plus one
  additive `ActionResult` field that's absent unless capture is on and a
  download actually fired. When capture is off the listener cancels the
  Playwright temp artefact so a session that never opts in leaves no on-disk
  trace. Per-session state isn't persisted across `close_session` /
  `open_session`. Internally: `acceptDownloads:true` is now set on the
  Playwright context at creation for both managed and incognito sessions —
  prerequisite for the `download` event to fire; the off-by-default registry
  governs whether anything is persisted.
- **`export_playwright_script`** — trace-export sibling to `export_session_report`:
  lowers the session's recorded action trace into a runnable
  `@playwright/test` spec file (`.spec.ts` source). Each recorded step lowers
  to ONE Playwright call using the BEST stable `selectorHint` captured at the
  time of the call — tier-1 attribute → `page.locator(...)`, tier-2 role+name
  → `getByRole({ name })`, role-only / tier-5 → `getByRole()` with a
  `// TODO: fragile selector` comment above the line so the consumer SEES the
  brittle spots in-source. Coords-mode actions are not recorded by the action
  window, so the export never has to lower a non-replayable target. Requires
  an active recording (`start_recording` first); inspect-style — does NOT end
  the recording. With `path`, ALSO writes the source to a workspace-rooted
  `.spec.ts` file (path-traversal rejected — must resolve under
  `$BROWX_WORKSPACE`). Capability `read` (exports recorded state — dispatches
  no new action). Returns `{ ok, name, source, stats: { steps, handled,
  unhandled, fragile }, path?, bytes?, tokensEstimate }`. Tool reference:
  [docs/tool-reference.md § export_playwright_script](docs/tool-reference.md#export_playwright_script-path-session-).
- **`network_emulate` / `cpu_emulate`** — per-session network + CPU throttling
  via CDP (`Network.emulateNetworkConditions` / `Emulation.setCPUThrottlingRate`).
  Net-additive — two new tools under capability `action`.
  `network_emulate({offline?, latencyMs?, downloadBps?, uploadBps?, packetLoss?})`
  drives flaky-mobile / offline / 429-storm repros against a real backend;
  `cpu_emulate({throttleRate})` simulates a low-end device (rate 1 = none,
  4–6 = low-end mobile). Both reset on empty input (or `{offline:false}` /
  `{throttleRate:1}`), both persist across navigation (re-applied on
  main-frame `framenavigated`), both **compose** with `route_queue` — a
  route's `delayMs` stacks ON TOP of `network_emulate`'s `latencyMs`. In
  BYOB / `attached` session mode the override stays in effect on the attached
  Chrome until the operator resets DevTools or closes the page — surfaced as
  a `warning` on the result. Both tools are also in the batch whitelist so
  agents can compose throttle → action → reset in a single batch.
- **Per-primitive device emulation** — 7 sibling MCP tools, each setting ONE
  Playwright/CDP emulation knob on the live session (deliberately not bundled
  as `emulate({...})`): `set_locale`, `set_timezone`, `set_geolocation`,
  `set_color_scheme`, `set_reduced_motion`, `set_user_agent`, `grant_permissions`.
  All under capability `action`, all sit alongside the unchanged `set_viewport`.
  Per-session state lives on the `SessionEntry` and is re-applied to new tabs
  in the same context via `BrowserContext.on("page")`. Locale / timezone / UA
  use CDP (`Emulation.setLocaleOverride`, `Emulation.setTimezoneOverride`,
  `Network.setUserAgentOverride`) because Playwright's matching context options
  are creation-time-only; the CDP equivalents DO take effect mid-session. The
  other four use Playwright's stable mid-session mutators. BYOB / attached
  sessions surface a warning that CDP overrides persist on the human's Chrome
  after detach. See
  [docs/tool-reference.md § Device emulation](docs/tool-reference.md#device-emulation--set_locale--set_timezone--set_geolocation--set_color_scheme--set_reduced_motion--set_user_agent--grant_permissions).
- **Three-layer storage-state** — the previously deferred bulk-state ask,
  shipped as three layers so adopters don't have to round-trip a full blob to
  read one cookie. Capability split (no new gate): reads under `read`, writes
  under `action`.
  - **Layer 1 — bulk**: `dump_storage_state({path?})` wraps
    `BrowserContext.storageState()` and (optionally) writes the JSON to a
    workspace-rooted path (escape-rejected); `inject_storage_state({state, mode?})`
    applies a blob OR a workspace-rooted JSON path — `mode:"replace"`
    (default, via `setStorageState`, clears existing state) or
    `mode:"merge"` (cookies-only via `addCookies`, plus localStorage merge for
    the currently-loaded origin only — others are skipped + reported).
  - **Layer 2 — granular CRUD (15 tools)**: cookies `cookies_{get,set,list,delete,clear}`,
    localStorage `localstorage_{get,set,list,delete,clear}`, sessionStorage
    `sessionstorage_{get,set,list,delete,clear}`. Cookie writes require either
    `url` (recommended — derives domain/path/secure) OR both `domain`+`path`.
    localStorage/sessionStorage are origin-scoped + page-bound — the session
    must be navigated to the target origin first; calls on `about:blank` or a
    different origin reject with an explicit "navigate first" hint.
  - **Layer 3 — named auth-states (4 tools)**: `auth_save({name})`,
    `auth_load({name})`, `auth_list()`, `auth_delete({name})` — wraps layer 1
    with workspace-rooted JSON files at `$BROWX_WORKSPACE/.auth-states/<name>.json`.
    No parallel implementation; names restricted to letters / digits / `._-`
    (no separators, no `..`).
  - **`open_session` extension (additive)**: optional `storageState`
    (inline blob OR workspace-rooted JSON path) and `authState` (slot name)
    seed the new context's storage state at creation. Native primitive on
    incognito; on persistent it post-seeds AND clears the profile (loud-warned);
    ignored on attached/BYOB. Mutually exclusive.
  - **Security gap documented** — cookie *values* may carry credentials. The
    future W-V12 secrets-masking pass will mask them on egress; this cycle
    ships unmasked. Treat dumps + saved named-states as sensitive.
- **`extract`** — structured, schema-driven data extraction. Closes a
  highest-leverage gap: every adopter currently rebuilds the
  same "parse this table into rows" loop on top of `snapshot()`. JSON-schema
  input (wire-compatible over MCP); deterministic mode lowers each property to
  a `find()`-style query (implicit: property name = query) or an explicit
  selector / attribute / DOM-property via the `x-browx-source` annotation;
  lists scope a per-row sub-schema to each match of an
  `x-browx-source.collection`. Returns `{ok, data, evidence:{refsUsed,
  selectorsUsed, partialMisses}, tokensEstimate}` — the schema is the contract,
  partial / required misses surface in `evidence.partialMisses` /
  `failure.partialMisses` rather than silently coercing into a malformed
  object. `mode:"llm-assisted"` is a typed-but-unimplemented seam reserved for
  a v0.2.x follow-up; the deterministic path is the model-agnostic ship. Under
  the `read` capability — no new capability. See
  [docs/tool-reference.md](docs/tool-reference.md#extract).
- **`register_secret` + `secrets` capability** — per-session sensitive-data
  registry with dispatch-side materialisation and global egress masking. The
  agent registers a secret with an uppercase alias (`PASSWORD`, `OTP`,
  `SESSION_TOKEN`); subsequent `fill({value:"<NAME>"})` / `press({key:"<NAME>"})`
  substitute the real value at Playwright dispatch, while every egress sink
  (`ActionResult.network`, `network_read`, `network_body`, `ws_read`,
  `console_read`, `snapshot`, `find`, `text_search`, `plan().evidence`,
  `inspect().styles`, `point_probe`, `verify_*` failure.actual,
  `act_and_diff().diff`, `watch`) rewrites occurrences of the real value
  back to `<NAME>` before returning to the agent. Required
  for safely automating auth flows when transcripts are shareable. Composes
  with the existing W-O1 URL sanitiser at the same boundary — both layers
  apply (URL-shape regex first, then literal real-value substring scan).
  Off by default; loud one-time warning at server boot + at first
  registration. `screenshot` is a partial sink: when the page's visible
  text contains a registered value, the result prepends a warning naming
  the affected aliases; pixel-level region-blur is a typed seam for v0.2.x.
  Base64 response bodies in `network_body` pass through unchanged
  (literal-substring scan can't match an encoded form). Capacity 32 secrets
  per session; optional `scope` URL-substring narrows dispatch-side
  substitution to prevent cross-origin leak. See
  [docs/tool-reference.md](docs/tool-reference.md#secrets-registry-capability-secrets)
  for the per-sink masking matrix and limitations,
  [docs/threat-model.md](docs/threat-model.md) for the threat-model entry.
- **`plan` / `execute`** — separate intent capture from dispatch. `plan` resolves
  a natural-language query + verb to a serialisable `ActionDescriptor` (bound
  `ref`, verb args, evidence, expiry) without dispatching; `execute` re-resolves
  the ref via the existing stable-key scheme and runs the verb's action.
  Refuses with structured `reason: "expired" | "ref-gone" | "invalid"` so caches
  / self-healing flows can re-plan deterministically. Supported verbs: `click`,
  `fill`, `hover`, `press`, `select`. `plan` is `read`; `execute` is `action`
  AND enforces the underlying verb's capability. See
  [docs/tool-reference.md](docs/tool-reference.md#plan-query-verb-verbargs-contextref-confidencefloor-ttlms-session--execute-descriptor-opts).
- **`verify_*` family** — assertive read primitives that fail-emit (`ok:false`
  + `failure:{source,kind,expected,actual,evidence?}`) when an assertion
  doesn't hold, so agent loops terminate deterministically instead of relying
  on the LLM eyeballing a snapshot. The fail-emitting sibling of permissive
  `wait_for`. Six tools, all under capability `read`:
  - `verify_visible` — element is currently visible (with a one-word reason
    on failure: `display:none` / `visibility:hidden` / `opacity:0` / zero-
    sized / off-screen / missing).
  - `verify_text` — element's visible text matches (default substring + case-
    insensitive; `exact:true` flips to case-sensitive equality).
  - `verify_value` — form-control's current DOM value matches.
  - `verify_count` — exactly `n` elements match a `selector` or visible
    `text` (grid/list invariants without re-walking the tree).
  - `verify_attribute` — element's HTML attribute matches (or, with `value`
    omitted, asserts presence) — `aria-*` / `data-*` / `disabled` / role
    state that doesn't surface as visible text.
  - `verify_predicate` — composed-predicate check over a caller-supplied
    `data` bag. **Fixed vocabulary, NOT arbitrary JS**: predicate `kind` is a
    fixed enum (`equals`, `notEquals`, `contains`, `notContains`, `gt`, `lt`,
    `gte`, `lte`, `between`, `matches`, `exists`, `and`, `or`, `not`) and
    `key` is a dotted accessor restricted to an allow-listed root set
    (`actionResult`, `snapshot`, `element`, `value`, `expect`). The agent
    supplies *data*; the *vocabulary* is server-owned. `eval_js` (gated
    behind `eval`) remains the only arbitrary-JS path.
- **Shared predicate vocabulary** (`src/util/predicates.ts`) — single source
  of truth used by both `verify_predicate` and `batch.expect`, so the
  semantic primitives stay aligned across the assertive and per-batch-call
  assertion surfaces.
- **Per-session `dialogPolicy` + `set_dialog_policy`** — first-class handling
  for `alert` / `confirm` / `prompt` / `beforeunload`. Without a policy a
  fired dialog blocks every subsequent browser event (the session deadlocks);
  browxai now installs `page.on('dialog')` on every page across all session
  modes (persistent / incognito / attached) and routes each fire through the
  session policy. Modes: `accept`, `dismiss`, `accept-prompt-with:<text>`,
  and `raise` (DEFAULT — dismisses server-side so the page never deadlocks
  AND fails the next action with `failure:{source:"app", hint:"unhandled
  dialog — set dialogPolicy"}` so a dialog can't silently change app state
  under an unaware caller). Set at `open_session({dialogPolicy})`; mutate
  at runtime with `set_dialog_policy({mode, text?})`. Fired dialogs surface
  on `ActionResult.dialogs[]`. Additive; default keeps pre-existing callers
  safe (no silent auto-accept). Capability: `action`.

## [0.1.0] - 2026-05-20

First public release. The stable tool surface is frozen at this version.

### Added

- **MCP browser-control server** over stdio — Playwright/CDP transport, owned end to end.
- **Read tools** — `snapshot` (accessibility tree + DOM-walk, stable `eN` refs),
  `find` (natural-language → ranked candidates with `stability` / `actionable` / `bbox`),
  `text_search`, `inspect`, `console_read`, `network_read`, `ws_read`, `screenshot`,
  `sample`, `watch`, `point_probe`.
- **Action tools** — `navigate`, `click`, `fill`, `press`, `hover`, `select`,
  `choose_option`, `wait_for`, `scroll`, `go_back`/`go_forward`, `set_viewport`,
  `tab_visibility`, `shortcut`, `batch`, `act_and_sample` — each returning a
  structured `ActionResult`.
- **Sessions & config** — per-session isolated contexts (`persistent` / `incognito` /
  `attached`), `open_session` / `close_session` / `close_sessions` / `list_sessions`,
  and an MCP-driven config store (`get_config` / `set_config` / `reset_config`).
- **Security model** — capability gating (`read,navigation,action,human` by default;
  `eval`, `network-body`, `clipboard`, `file-io`, `byob-attach` opt-in),
  an origin allow/blocklist, confirmation hooks, a hard anti-wedge deadline on every
  call, and default-on redaction of credential-bearing URLs in captured traffic.
- **Anti-wedge recovery** — a per-session wedge detector: after repeated
  anti-wedge timeouts on one session, results carry `sessionWedged: true` plus a
  discard-and-reopen hint so an agent stops retrying a dead session. Tool
  descriptions and error/hint text spell out retry-once vs. discard-the-session
  vs. raise-`timeoutMs`.
- **`file-io`** — `upload_file` (Playwright `setInputFiles`).
- **Gestures, route mocking & compound tools** — `drag` / `double_click` /
  `mouse_*`, network route mocking (`route` / `route_queue` / `unroute`),
  `act_and_diff`, `act_and_wait_for_network`, `poll_eval` (capability `eval`),
  `screenshot_region`, named visual regions, `cross_session_sample`,
  `export_session_report`, `profile_snapshot` / `profile_restore` — part of the
  stable surface under their natural capabilities (`action` / `read` / `human`).
- **Harness adapters** (`harness/`) — ready-to-use setup for Claude Code, Codex,
  and Pi: MCP-server registration per harness plus a portable "driving browxai
  well" Agent Skill.

[0.1.0]: https://github.com/kalebteccom/browxai/releases/tag/v0.1.0
