# Phase 2.5 — Session & config architecture

> Status: design locked 2026-05-18. Implementer-facing. Sequenced deliverables;
> each is a commit cycle. Precedes the headless-CI keystone so CI exercises
> this model, not the env-var singleton.

## Why

browxai's shape is currently calibrated for one consumer (site-docs's
calibration loop) and one session per server process, configured entirely
through `BROWX_*` env vars read once at startup. The owner's requirements:

1. General agentic driving (not just the site-docs loop).
2. Ephemeral "incognito" sessions (no profile trace).
3. Simultaneous sessions: multiple agents on one window with per-session tabs;
   one agent on many windows/tabs; multi-user apps (different logins).
4. Fully session-driven config: no env vars, no hand-edited files; everything
   through MCP, with sensible layered defaults.

## Locked decisions

1. **Session addressing = explicit `session` arg.** Every tool gains an
   optional `session: string` (default `"default"`). No server-global "active
   session" — two agents sharing one server can't stomp each other.
2. **Config = browxai-managed store.** A file browxai owns
   (`<workspace>/config.json`, workspace defaulting to `~/.browxai`), mutated
   **only** via MCP, never hand-edited. Precedence:
   `built-in defaults < env (legacy) < user < project < session-via-MCP`.
   A namespaced `unstable.*` tier holds experimental knobs.
3. **Session isolation = one BrowserContext per session.** Isolated cookie
   jar / storage. Different users → different sessions → real auth isolation.
   One Chrome process for the managed/incognito family; separate instances
   only for named persistent profiles and BYOB attach.

## Config model

### Schema (`ResolvedConfig`)

Everything currently from `BROWX_*` becomes a config key:

| Key | Was env | Default |
|---|---|---|
| `testAttributes: string[]` | `BROWX_TEST_ATTRIBUTES` | `["data-testid","data-test","data-cy","data-qa"]` |
| `capabilities: string[]` | `BROWX_CAPABILITIES` | `["read","navigation","action","human"]` |
| `confirmRequired: string[]` | `BROWX_CONFIRM_REQUIRED` | `["navigate_off_allowlist","byob_action"]` |
| `allowedOrigins: string[]` | `BROWX_ALLOWED_ORIGINS` | `[]` |
| `blockedOrigins: string[]` | `BROWX_BLOCKED_ORIGINS` | `[]` |
| `headless: boolean` | `BROWX_HEADLESS` | `false` |
| `unstable: Record<string,unknown>` | — | `{}` |

`workspace` (root path) stays a *location* anchor, not config — resolved from
`BROWX_WORKSPACE` or `~/.browxai`. It's where the config store itself lives, so
it can't be config.

### Precedence resolver

`ConfigStore.resolve(sessionPatch?)` merges, lowest→highest:

```
built-in defaults
  ← env layer (legacy BROWX_*, documented as deprecated-but-honoured)
  ← user layer      (config.json → "user")
  ← project layer   (config.json → "project")
  ← session patch   (passed via MCP open_session / set per session)
```

Arrays replace (not merge) at each layer — predictable. `unstable.*` merges
shallowly so a session can flip one flag without restating the namespace.

### MCP tools

- `get_config({ session?, scope? })` — resolved view, or a single layer when
  `scope ∈ {defaults,env,user,project,session}`.
- `set_config({ scope: "user"|"project", patch })` — persists into
  `config.json`. Refuses `defaults`/`env`/`session` (defaults are built-in,
  env is legacy, session config goes through `open_session`).
- `reset_config({ scope: "user"|"project" })` — clears that layer.

`set_config` is the *only* writer of `config.json`. The file is documented as
machine-managed; hand-edits are not supported (and a malformed file degrades
to "ignore this layer + warn", never a crash).

## Session model

### `SessionEntry`

Per-session state, today all server-singletons, becomes per-entry:

```
SessionEntry {
  id: string
  mode: "persistent" | "incognito" | "attached"
  session: BrowserSession          // the Playwright context/page handle
  refs: RefRegistry
  console: ConsoleBuffer
  network: NetworkBuffer
  bridge: BrowxBridge
  recorder: Recorder
  feedback: FeedbackMemory
  approvals: ApprovalStore
  config: ResolvedConfig           // resolved at open, session-patch applied
}
```

### `SessionRegistry`

`Map<string, SessionEntry>`. The `"default"` session is created lazily on
first tool use (back-compat: every existing call that omits `session` keeps
working unchanged — it resolves to `"default"`).

### Lifecycle tools

- `open_session({ session, mode?, profile?, attachCdp?, config? })` — creates
  an entry. `mode` defaults from resolved config (`persistent`). `config` is
  the session-layer patch. Re-opening an existing id is an error (use
  `close_session` first) — explicit, no silent clobber.
- `close_session({ session })` — tears down. Persistent: closes the context,
  profile dir survives. Incognito: discards the ephemeral context. Attached:
  detaches only (not-owned — never closes the user's Chrome).
- `list_sessions()` — `[{ id, mode, url, pageCount, openedAt }]`.

### Isolation mechanics

- **incognito** (and the managed default): one shared `chromium.launch()`
  Chrome; each session = `browser.newContext()` → isolated cookie jar.
  Incognito discards the context on close; managed may persist storageState if
  asked (future).
- **persistent**: `chromium.launchPersistentContext(<workspace>/profiles/<name>)`
  — its own browser instance, profile survives across runs.
- **attached**: `chromium.connectOverCDP(<loopback>)` — existing context,
  not-owned semantics unchanged from Phase 1/2.

The multi-user requirement is satisfied by mechanics alone: two sessions =
two contexts = two cookie jars, even against the same app in one Chrome
process.

## Back-compat strategy

- `session` is optional everywhere; absence ⇒ `"default"`. No existing caller
  changes.
- `BROWX_*` env vars still resolve, as the `env` precedence layer, documented
  as legacy. A future major can drop them; not now.
- The single-session adoption-run / runbook flows keep working: they just use
  the implicit default session.
- A back-compat regression list is part of P2.5-2's exit criteria.

## Sequence

1. **Config substrate** — `ConfigStore` + resolver + `get/set/reset_config`;
   migrate `BROWX_*` reads to flow through it. Foundation.
2. **Session registry** — `SessionEntry` + `SessionRegistry`; `session` arg on
   all tools; `open/close/list_session`. Default lazily created.
3. **Session modes** — `persistent` / `incognito` / `attached` on
   `open_session`; config-driven defaults.
4. **General-driving defaults + docs** — drop site-docs-loop assumptions;
   rewrite AGENT-RUNBOOK + tool-reference around the general engine.

Headless-CI keystone follows, exercising this model.
