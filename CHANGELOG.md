# Changelog

All notable changes to browxai are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and browxai adheres to
[semantic versioning](https://semver.org/) — see the
[Stability & semver](docs/tool-reference.md) policy for what "the stable
surface" covers.

## Unreleased

### Added

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
- **Three-layer storage-state (W-U7)** — the deferred Phase-2 bulk-state ask,
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
