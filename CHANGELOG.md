# Changelog

All notable changes to browxai are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and browxai adheres to
[semantic versioning](https://semver.org/) — see the
[Stability & semver](docs/tool-reference.md) policy for what "the stable
surface" covers.

## Unreleased

### Added

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
- **Three-layer storage-state** — the deferred Phase-2 bulk-state ask,
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
