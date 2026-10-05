# browxai in remotxai sessions: integration design

Status: design, written against browxai v0.11.0. Everything under a
**Proposed** heading is unbuilt, except the operator socket (Path B in section 3) and the live view on it (section 4), which are built. Everything under
**Exists** names the file that implements it. Not published to browxai.com: the
site syncs only the pages listed in `website/scripts/doc-pipeline.mjs`.

Use v0.11.0 or later. Earlier versions let page scripts and the agent answer
human prompts, and let the agent widen its own capabilities through
`set_config`. [`docs/threat-model.md`](../threat-model.md) section 7 and
"Configuring" describe the current rules.

Audience: the engineers wiring remotxai's host daemon to browxai, and the
browxai maintainers who would build the proposed pieces.

## Context

remotxai is a host daemon, a phone PWA and a relay. The daemon runs Claude
Code, Codex and Pi sessions on the operator's machine; the phone watches and
steers them over an end-to-end encrypted channel; the relay forwards
ciphertext and stores nothing. Approvals, questions and pushes reach the
operator as cards on the phone.

browxai-cloud is a private, commercial relay that exposes a local browxai
remotely. It is mentioned here only to keep it out of the design: nothing
below depends on it.

## What browxai exposes today

| Surface                    | State  | Where                                                                                                                                                                                                                                                              |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP server over stdio      | Exists | `browxai` bin, `src/cli.ts`. Over 180 core tools registered from `src/tools/*-tools.ts`, plus plugin tools.                                                                                                                                                        |
| MCP over a Unix socket     | Exists | `browxai serve --socket <path>`, `src/cli/serve.ts`. Several clients share one session registry. Socket is chmod 0700. Its `tools/list` returns open schemas with `browxai/<name>` descriptions, so it suits SDK clients, not a model.                             |
| Typed SDK                  | Exists | `createBrowxai()` in `src/sdk/index.ts`, transports `in-process`, `stdio-child`, `socket` (`src/sdk/types.ts`).                                                                                                                                                    |
| Plugin contract            | Exists | `register(api)` with `registerTool`, `callTool`, `log` (`docs/plugin-authoring.md`, `src/plugin/`). Plugins can add tools. They cannot subscribe to events.                                                                                                        |
| Events to an outside party | None   | browxai sends no MCP notifications and has no webhook or event socket. Logging is stderr only (`src/util/logging.ts`).                                                                                                                                             |
| Human-in-the-loop          | Exists | `await_human`, confirm hooks, `approve_actions` (behind `self-approval`) and `list_approvals`. The prompt goes to stderr. The answer comes from a DevTools console context the prompt names. Details in [Approvals and await_human](#3-approvals-and-await_human). |
| Screencast / live frames   | Exists | Behind `live-view` on the operator socket (`src/helper/operator-view-hub.ts`, section 4). Otherwise `screenshot` (inline image), `screenshot_schedule` / `screenshot_on` (`file-io`), `recordVideo`, `.browx` replay.                                              |
| Credentials                | Exists | `register_secret` (`secrets`), `get_credential` / `get_totp` (`credentials`), `auth_save` / `auth_load` / `auth_list` / `auth_delete` (`action` / `read`). See [Credentials](#5-credentials-and-secrets).                                                          |

Capabilities are resolved once at server start from `BROWX_CAPABILITIES`
(`src/util/capabilities.ts`). The default set is `read,navigation,action,human`.
Every other capability is off and prints a warning when turned on. A saved
`capabilities` list in `config.json` can only drop capabilities from that set.
`docs/threat-model.md` has the rationale per capability.

## Who calls whom

| Direction                        | Today                                                                                                                    | Proposed                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| remotxai daemon → harness config | Adds a `browxai` stdio MCP entry with `BROWX_*` env per session                                                          | Same, plus `BROWX_OPERATOR_SOCKET`                                                                    |
| harness → browxai                | MCP tool calls over stdio                                                                                                | Same                                                                                                  |
| browxai → operator               | Nothing reaches remotxai. Prompts go to browxai's stderr, which the harness owns                                         | MCP `elicitation/create` where the harness forwards it; an operator socket to the daemon for the rest |
| operator → browxai               | The harness's own tool-permission prompts on `mcp__browxai__*` calls, and DevTools on the host for browxai's own prompts | Answers on the operator socket; live-view start/stop                                                  |

## 1. Wiring: one browxai process per remotxai session

**Recommendation.** remotxai adds a browxai stdio server to each session's
harness MCP config and lets the harness spawn it. remotxai does not proxy
browxai's tools through its own MCP server.

Reasons:

- The model gets browxai's real tool schemas and descriptions. A proxy has to
  re-export over 180 schemas and track them across browxai releases. The
  stable surface is defined in `docs/tool-reference.md` "Stability and semver".
- Tool results are untrusted page content (snapshots, screenshots, page
  text). With the harness spawning browxai directly, remotxai never parses
  them.
- Each browxai call is a harness tool call named `mcp__browxai__<tool>`, so
  it already goes through the harness permission prompt that remotxai turns
  into an approval card. Tool-level approval needs no browxai change.
- Process lifetime equals session lifetime. Killing the session kills the
  browser. `SIGINT` / `SIGTERM` close every session (`src/cli.ts`).

A proxy is worth its cost only if remotxai needs to hide tools beyond the
three policy tools, or to inject its own arguments into calls. For those three,
`BROWX_CONFIG_READONLY=1` already removes them from `tools/list` (section 3).

Per harness:

- **Claude Code.** The Agent SDK `mcpServers` option takes a stdio entry with
  `command`, `args` and `env`. remotxai already passes its own server there.
- **Codex.** `[mcp_servers.browxai]` in `config.toml` lives under `CODEX_HOME`,
  so it is per remotxai profile. Per-session env probably goes through the
  `config` object on `thread/start`. Not verified.
- **Pi.** Pi has no native MCP; browxai goes in through the `pi-mcp-adapter`
  extension (`harness/adapters/pi/README.md`). Its `mcp.json` is either
  global in the agent dir (per profile) or `.mcp.json` in the project root
  (per working directory). Per-session env is an open question.

### Env vars and CLI args

| Setting             | How                                                   | Default                              | State                                               |
| ------------------- | ----------------------------------------------------- | ------------------------------------ | --------------------------------------------------- |
| Workspace root      | `BROWX_WORKSPACE=<path>`                              | `~/.browxai`                         | Exists, `src/util/workspace.ts`                     |
| Capabilities        | `BROWX_CAPABILITIES=read,navigation,action,human,...` | the four defaults                    | Exists, `src/util/capabilities.ts`                  |
| Headless            | `BROWX_HEADLESS=1`                                    | headed                               | Exists, `src/cli.ts`                                |
| Engine              | `--engine <kind>` or `BROWX_ENGINE`                   | `chromium`                           | Exists, `src/engine/select.ts`                      |
| Origin policy       | `BROWX_ALLOWED_ORIGINS`, `BROWX_BLOCKED_ORIGINS`      | unset                                | Exists, `src/policy/origin.ts`                      |
| Confirm hooks       | `BROWX_CONFIRM_REQUIRED`                              | `navigate_off_allowlist,byob_action` | Exists, `src/policy/confirm.ts`                     |
| Credentials backend | `BROWX_CREDENTIALS_PROVIDER`                          | `oathtool`                           | Exists, `src/util/credentials.ts`                   |
| Default profile dir | `BROWX_DEFAULT_PROFILE=<absolute dir>`                | `<ws>/profile`                       | Exists, `src/util/workspace.ts`                     |
| Read-only config    | `BROWX_CONFIG_READONLY=1`                             | unset                                | Exists, `src/util/config-store.ts`                  |
| Operator channel    | `BROWX_OPERATOR_SOCKET`, `BROWX_OPERATOR_TOKEN`       | unset                                | Exists, `src/helper/operator-channel.ts`, section 3 |

Leave `BROWX_ATTACH_CDP` unset. It switches sessions to attach mode, which
drives the operator's own Chrome, needs `byob-attach`, and shares one cookie
jar across sessions.

`BROWX_DEFAULT_PROFILE` sets the persistent profile directory of the `default`
session only. The path must be absolute or start with `~/`. The start fails
on the filesystem root, the home directory itself, a symlink, a non-directory
and a directory owned by another user. A missing directory is created with
mode `0700`. Any other session id, or an explicit `open_session({ profile })`,
still uses `<ws>/profiles/<profile or id>` (`src/tools/session-registry.ts`).
Since remotxai runs one browxai process per session, the `default` session is
the one the agent uses.

`BROWX_CONFIG_READONLY=1` leaves `set_config`, `reset_config` and
`approve_actions` unregistered. They are absent from `tools/list` and from
`batch`, and the config store refuses writes.

Example Claude Code entry:

```jsonc
{
  "mcpServers": {
    "browxai": {
      "type": "stdio",
      "command": "browxai",
      "args": ["--engine", "chromium"],
      "env": {
        "BROWX_WORKSPACE": "<daemon runtime dir>/browxai/<profile-id>",
        "BROWX_DEFAULT_PROFILE": "<daemon runtime dir>/browxai-profiles/<profile-id>/<session-id>",
        "BROWX_CAPABILITIES": "read,navigation,action,human",
        "BROWX_CONFIG_READONLY": "1",
        "BROWX_HEADLESS": "1",
      },
    },
  },
}
```

## 2. Profiles and workspaces

### Exists

- A workspace is identified by its path. There is no workspace id and no
  registry of workspaces. `resolveWorkspace` in `src/util/workspace.ts` reads
  `BROWX_WORKSPACE`, expands `~`, creates the directory, and roots every write
  under it through `resolveWorkspacePath`.
- Under one workspace: `config.json` (the `user` / `project` config layers),
  `profile/` and `profiles/<name>/` (browser profiles), `.auth-states/<name>.json`,
  plugin installs, `diagnostics/`, `screenshots/`, `videos/`, and
  `chrome-profile/` plus `chrome.pid` for `browxai chrome start`.
- Names follow `^[A-Za-z0-9._-]+$` (`assertSafeName`). remotxai profile ids use
  the same character set, so a remotxai profile id is a valid browxai profile
  or directory name as is.
- `profile_status` lists the profile directories under the workspace with size,
  last write and the ids of sessions open on each (`src/session/profile-status.ts`).

### Concurrency

- **One process, two sessions on one profile.** browxai takes no lock. Two
  session ids given the same `profile` launch on the same directory. The
  second persistent launch should fail on the browser's own profile lock.
  No browxai test covers this; verify before relying on it.
- **Two processes on one workspace.** Nothing coordinates them. Both
  `default` sessions launch on `<ws>/profile` and collide, unless each process
  sets its own `BROWX_DEFAULT_PROFILE`. `config.json` is last-write-wins.
  `.auth-states/` is shared, which is useful and also means one session can
  overwrite another's slot.
- **Config written by an agent outlives its session, but only as a
  tightening.** `set_config` has no capability gate (`src/tools/config-approval-tools.ts`),
  and what it saves applies to later browxai processes on that workspace. Since
  v0.11.0 the server's environment is the ceiling for every policy key: a saved
  `capabilities` list is intersected with `BROWX_CAPABILITIES`, and `set_config`
  refuses a patch that would add a capability, remove a confirm hook, widen the
  origin allowlist or turn on `disableWebSecurity`. An agent can still persist
  a narrower posture (fewer capabilities, more hooks), which would surprise the
  next session on that workspace. With `BROWX_CONFIG_READONLY=1` the tools are
  not registered, so nothing is written.

### Recommendation

One workspace per remotxai profile, one browser profile directory per remotxai
session, and a read-only config:

- `BROWX_WORKSPACE=<daemon runtime dir>/browxai/<remotxai-profile-id>`.
  Sessions of the same account share auth-state slots and
  credentials-provider setup.
- `BROWX_DEFAULT_PROFILE=<daemon runtime dir>/browxai-profiles/<remotxai-profile-id>/<remotxai-session-id>`.
  Each session keeps its own cookie jar on disk and no two processes launch on
  one directory. Keep this path outside the workspace. browxai's file tools
  refuse the process's own `BROWX_DEFAULT_PROFILE` and the workspace's
  `profile/` and `profiles/` trees, but they do not know about a sibling
  session's directory inside the same workspace, and a profile holds live
  cookies.
- `BROWX_CONFIG_READONLY=1`, so the capability set remotxai passes in is the
  set that runs and nothing an agent saves reaches the next session.

`BROWX_DEFAULT_PROFILE` is operator-set, like `BROWX_WORKSPACE`. The daemon
creates the parent directories; browxai creates the leaf with mode `0700` and
refuses a leaf that is a symlink or owned by another user.

A remotxai profile is a harness account, not a web identity. Using it as the
workspace key is a default. An operator who drives two client web accounts
from one harness account needs the workspace chosen per session, which the
daemon can expose as a session option.

Profile directories hold live cookies. The daemon owns their retention:
delete the per-session profile directory when the session is deleted.
`profile_status` lists the profiles under the workspace, not a directory set
through `BROWX_DEFAULT_PROFILE`; the daemon tracks those itself.

## 3. Approvals and await_human

### Exists

- **Confirm hooks**, `src/policy/confirm.ts`. `navigate_off_allowlist` fires
  when `navigate` leaves `BROWX_ALLOWED_ORIGINS`; `byob_action` fires on every
  action in attach mode, which includes an attached Electron app.
  `file_download` and `file_upload` are reserved names. A hook blocks the tool
  call for up to 5 minutes waiting for an answer, then the call is refused.
- **`await_human({ kind, prompt, choices?, timeoutMs? })`**,
  `src/tools/batch-human-tools.ts`. Kinds `acknowledge`, `confirm`, `choose`,
  `input`. 5 minute default, 1 hour cap. Returns `{ kind, value, timedOut }`.
- **Answer path.** The prompt is written to browxai's stderr. It names a
  per-session CDP isolated world, `browxai-<random>`, and a short ticket. The
  answer is a call to `__browx.confirm(true, "<ticket>")`, `.choose(...)`,
  `.input(...)` or `.proceed("<ticket>")` from the DevTools console, after
  switching its context dropdown from `top` to that world
  (`src/helper/browx-page.ts`, `src/helper/bridge.ts`). The binding exists
  only in that world. Page scripts share the DOM but not the world's globals,
  so they cannot call it, and `window.__browx` in the page is display-only.
  An answer counts only while its prompt is pending and only with that
  prompt's ticket. The `ask-human` modes of the dialog, permission,
  notification and file-picker policies use the same channel.
- **No CDP, no channel.** On firefox, webkit, safari and the native engines
  there is no isolated world. `await_human` returns at once with a
  `no-human-channel` error, and the confirm hooks and `ask-human` policies fail
  closed. Chromium, an attached Chrome, `android` and `electron` have the
  channel.
- **`approve_actions({ scopes, ttlSeconds? })`** and **`list_approvals()`**,
  `src/tools/config-approval-tools.ts`. Pre-grant confirm-hook scopes for up
  to 24 hours. `approve_actions` needs the off-by-default `self-approval`
  capability and refuses with `requiredCapability: "self-approval"` without
  it. It is not registered under `BROWX_CONFIG_READONLY=1`. The grant store
  (`ApprovalStore`) is keyed by scope only, so a grant covers every session in
  that browxai process.

Where that leaves an operator-only gate, in v0.11.0:

1. A script on the page cannot answer a confirm hook or an `await_human`. A
   browser extension with the `debugger` permission can reach the world over
   CDP, so the `extensions` capability counts as `self-approval`
   (`docs/threat-model.md`, section 7). Leave `extensions` off in remotxai
   sessions.
2. The agent cannot approve its own confirm hooks unless the operator enabled
   `self-approval`. remotxai leaves it off, and `BROWX_CONFIG_READONLY=1`
   removes `approve_actions` outright.
3. The one answer path is DevTools on the machine that runs the browser. A
   phone operator has none, and remotxai cannot see a pending request: the
   prompt exists only on stderr of a process the harness spawned. Today a
   confirm hook on a remotxai session therefore ends in a refusal after 5
   minutes unless someone sits at the host. Unverified: whether a headless
   session can be answered at all. The operator socket (Path B below) closes
   this gap in the release that adds it.

What remotxai can do today: rely on harness permission prompts per browxai
tool, set `BROWX_CONFIG_READONLY=1` so `set_config`, `reset_config` and
`approve_actions` never reach the model on any harness, and keep
`BROWX_CONFIRM_REQUIRED` at its default or wider. A flow that has to proceed
unattended past a hook can drop that hook from `BROWX_CONFIRM_REQUIRED`, which
is narrower than enabling `self-approval`.

### Two answer paths

The gap these close is reach, not trust. The page and the agent are already
locked out of the existing channel; the operator on a phone cannot get in
either.

**Path A, MCP elicitation.** When the connected MCP client declares the
`elicitation` capability, `await_human` and the confirm hooks send
`elicitation/create` and block on its result. remotxai's adapter contract
already models MCP elicitation as an elicit card
(`packages/adapter-contract` in remotxai). Nothing new in the transport.
Limits: it works only on harnesses that forward elicitation from a stdio MCP
server to remotxai's adapter, and it is operator-only only if the harness
never lets the model answer an elicitation. The prompt has to be sent from
inside the `tools/call` that waits for the answer: Claude Code answers
elicitation only while a call is pending and cancels it otherwise
(`docs/threat-model.md`, section 7).

**Path B, operator socket.** Exists, behind the `operator-channel` capability
(`src/helper/operator-channel.ts`, `src/helper/operator-protocol.ts`).
Operator-only on every harness.

- **Gate.** The off-by-default capability `operator-channel`, with a startup
  warning. It takes effect only when `BROWX_OPERATOR_SOCKET` and
  `BROWX_OPERATOR_TOKEN` are also set. Either half alone does nothing and logs a
  warning when the capability is off. With the capability on, a missing variable
  stops the server from starting. The agent
  cannot enable it: a saved `capabilities` list can only narrow
  `BROWX_CAPABILITIES`. Both variables are read once at start and removed from
  `process.env`.
- **Direction.** The daemon listens on a Unix socket it creates per session
  (mode 0600 inside a 0700 directory, both owned by the user running browxai).
  browxai dials it at start and redials with backoff from 250 ms up to 5 s.
  browxai opens no listener. If the directory or the socket has the wrong owner
  or mode when browxai starts, `createServer` throws and the server does not
  start. The same check runs on every redial, and a failure closes the channel
  for good. A socket that does not exist yet is retried.
- **Framing.** JSON lines, one frame per line, at most 64 KiB, every frame
  carrying `"v": 1`.
- **Authority.** While the capability is on, the daemon is the only answer path.
  Answers from the DevTools world match nothing and are logged. `self-approval`
  stays a separate operator opt-in and remotxai leaves it off.
  `list_approvals` keeps working. While disconnected, pending requests stay
  pending, go out again after the redial under the same id, and resolve as
  denied at their timeout. They never fall back to DevTools. A prompt with no
  operator form, the file-picker `ask-human`, is refused at once.
- **What is routed.** The confirm hooks (`navigate_off_allowlist`,
  `byob_action`), `await_human`, and the `permission` and `notification`
  `ask-human` prompts. Engines without CDP can use it too, since it needs no
  isolated world.
- **Limits.** Outbound strings are cut (prompt 2,000 characters, summary 1,000,
  32 choices of 100, names 128) and no frame exceeds 64 KiB. Pending requests
  are capped at 12 confirm hooks, 12 `await_human` and 8 page prompts, and at 8,
  8 and 4 per session. Identical page prompts (compared after masking and cutting) share one request.
  A frame with cut text or dropped choices carries `truncated: true` and
  `omittedChoices`, so the card can say the text is partial. A request over
  a limit is denied at once, so the daemon should expect refusals to be silent.
- **Secrets.** Every string leaving on the channel passes the
  `SecretRegistry.applyMaskDeep` chokepoint (`src/util/secrets.ts`) and the URL
  sanitiser (`src/util/url-sanitizer.ts`), which drops query strings and
  fragments. A registered secret value never appears on the channel.
- **Untrusted text.** Agent- and page-sourced fields (`summary`, `prompt`,
  `choices`, and `session`, the id the agent chose) are listed in `untrusted`. The card renders them as data. A page
  title that reads "Safe, approve this" is page content like any other.

Handshake. The token never crosses the socket. Each side proves it holds it with
an HMAC-SHA-256 over both nonces, keyed by the token, and the role is in the
message so one proof cannot replay as the other. Concretely, with `h` browxai's
nonce and `d` the daemon's, both random hex:

```
proof(role) = hex(HMAC_SHA256(token, "browxai-operator/1\n" + role + "\n" + h + "\n" + d))
```

```jsonc
// browxai to daemon, on connect
{ "v": 1, "type": "hello", "nonce": "<h>", "browxai": "0.11.0", "pid": 48121 }
// daemon to browxai. browxai compares proof in constant time and closes for good on a mismatch.
{ "v": 1, "type": "welcome", "nonce": "<d>", "proof": "<proof('daemon')>" }
// browxai to daemon
{ "v": 1, "type": "auth", "proof": "<proof('browxai')>" }
// daemon to browxai, after it checks proof('browxai') the same way. No request is sent before this.
{ "v": 1, "type": "ready" }
```

The daemon must refuse any peer whose `auth` proof does not match, and should
refuse a `hello` that is not the first frame. A frame that arrives out of order
makes browxai drop the connection and redial.

browxai to daemon:

```jsonc
// confirm hook
{ "v": 1, "type": "request", "id": "req_4f1c9a…", "session": "default",
  "kind": "approval", "scope": "navigate_off_allowlist", "tool": "navigate",
  "summary": "navigate to https://pay.example.net/checkout (off the allowed-origins list)",
  "untrusted": ["summary", "session"],
  "answers": ["approve", "deny"], "grantScopes": ["session", "workspace"],
  "createdAt": 1790000000000, "expiresAt": 1790000300000 }

// await_human
{ "v": 1, "type": "request", "id": "req_77b0e2…", "session": "default",
  "kind": "human", "humanKind": "choose", "prompt": "Which account should I use?",
  "choices": ["alice@example.com", "bob@example.com"],
  "untrusted": ["prompt", "choices", "session"],
  "answers": ["done", "abort"], "createdAt": 1790000000000, "expiresAt": 1790000120000 }

{ "v": 1, "type": "resolved", "id": "req_4f1c9a…", "outcome": "denied", "by": "timeout" }
```

`scope` is a confirm hook name for `kind: "approval"` requests that can carry a
grant (`grantScopes` is present), and `permission` or `notification` for the
page prompts, which cannot.

daemon to browxai:

```jsonc
{ "v": 1, "type": "answer", "id": "req_4f1c9a…", "decision": "approve" }
{ "v": 1, "type": "answer", "id": "req_4f1c9a…", "decision": "approve", "grant": { "scope": "session", "ttlSeconds": 900 } }
{ "v": 1, "type": "answer", "id": "req_77b0e2…", "decision": "done", "value": 0 }
{ "v": 1, "type": "answer", "id": "req_77b0e2…", "decision": "abort" }
```

- `id` is 128 random bits and single-use. An answer to an unknown or resolved
  id gets `{ "type": "error", "id": …, "code": "unknown-request" }`.
- An answer that does not fit its request gets
  `{ "type": "error", "id": …, "code": "invalid-answer" }` (or
  `"grant-not-allowed"` for a grant on a `deny` or on a request with no
  `grantScopes`), and the request stays pending. An approval takes `approve` or
  `deny`. A human request takes `done` or `abort`. For `done`, `value` is a
  boolean for `confirm`, an integer index into `choices` for `choose`, a string
  of at most 10,000 characters for `input`, and absent for `acknowledge`.
- A grant is `{ scope, ttlSeconds }` with `scope` either `session` or
  `workspace` and `ttlSeconds` from 1 to 86400. `session` covers later calls of
  that scope in the same session, until it closes. `workspace` covers every
  session of this browxai process. Any other scope, `global` included, is
  rejected with `invalid-answer`. A plain `approve` is one-shot. A grant is only
  honoured on an `approve`.
- `outcome` is one of `approved`, `denied`, `done`, `aborted`, `timeout`.
  browxai sends `resolved` once a request ends, for any reason, so the card can
  be cleared.
- remotxai's `needs_input` push stays as its push doc defines it:
  `{ kind, session_id, label, at_ms }`. No browxai text goes into a push.

What the daemon has to do on its side: create the directory at 0700 and the
socket at 0600 before it starts the harness, pass `BROWX_OPERATOR_SOCKET` and
`BROWX_OPERATOR_TOKEN` (at least 16 characters, 128 random bits as hex is
enough) in the per-session env, add `operator-channel` to `BROWX_CAPABILITIES`,
check the handshake proof in constant time, and treat every `untrusted` field as
data.

Tests: `test/keystone/operator-channel.keystone.test.ts` (a real socket and real
Chromium) and the unit tests beside `src/helper/operator-channel.ts`.

Known limits, for a v2 of the daemon contract: the secret is handed over in the
environment, which a same-user process can read from the initial environment
block on Linux and macOS (an inherited descriptor that browxai closes after
reading would fix it), and frames after the handshake carry no MAC, so a
same-user process that swaps the socket and relays to the real daemon passes the
proof. The fix is a session key derived from both nonces and the token, with a
MAC on every frame.

Not built: the `page` block (`url`, `title`) the first draft put on approval
requests. The summary names the target, and the page fields would be one more
untrusted string. Add them if the card needs them.

## 4. Live view from the phone

### Exists

No streaming. The agent's own `screenshot` results are MCP image content
parts, so the operator sees what the agent looked at if remotxai forwards
tool-result images to the PWA. `screenshot_schedule` and `screenshot_on`
write files under the workspace and need `file-io`.

One path works today without browxai changes and is not recommended: start
Chrome with `browxai chrome start`, point the session's browxai at it with
`BROWX_ATTACH_CDP`, and have the daemon open its own CDP connection to call
`Page.startScreencast`. It needs `byob-attach`, shares one cookie jar across
sessions, fires the `byob_action` confirm hook on every action, and leaves an
unauthenticated CDP port on loopback for the life of the browser.

### Exists: frames on the operator socket

Behind the `live-view` capability (`src/helper/operator-view.ts`,
`src/helper/operator-view-hub.ts`, `src/helper/operator-screencast.ts`). The
wire contract is in `docs/tool-reference.md`, "Live view (operator channel)".

- **Gate.** `live-view`, off by default, with a startup warning. It requires
  `operator-channel`: with `live-view` on and `operator-channel` off the server
  refuses to start. There is no MCP tool for it. The daemon starts and stops the
  stream per session, and the agent can neither start it nor read frames. With
  the capability off, a `view.start` gets `{ "type": "error", "code":
"view-disabled" }`.
- **Defaults and ceilings.** `view.start` with no fields streams 5 fps, 960 px
  wide, JPEG quality 60. Ceilings are 5 fps, 1280 px and quality 80, and larger
  numbers are clamped. `view.started` reports what applied.
- **Flow control.** browxai keeps one frame in flight until the daemon sends
  `frame.ack` with the session and `seq`. A frame that arrives meanwhile, or
  while the socket holds over 16 KiB unflushed, is dropped. Nothing queues. browxai also
  holds back its own ack to Chromium so the browser sends the next frame no
  sooner than the stream's frame interval, which keeps the encode cost at the
  stream rate. Ack when the frame has been handed to the transport. If the path
  behind the daemon is slow, acking late is how that slowness reaches browxai.
- **Adaptive step-down.** A 2 s window that drops at least 40% of its frames moves
  the stream one of four steps from the requested size toward 1 fps and 640 px.
  Ten clean seconds with room in the ack round trip move it back. A step that
  changes width restarts the screencast, so the next frame comes at once. No ack
  for 30 s ends the stream (`reason: "stalled"`).
- **Frame size.** A line over 64 KiB drops the connection, and a JPEG of a busy
  page is often bigger. A frame therefore goes as `parts` lines of up to 30 KiB
  of JPEG each (40,960 base64 characters), at most 16 parts, with `part`
  counting from 0 and the same `seq`. A frame needing more than 16 parts is
  dropped and counts as slowness. The alternative was a larger line limit for
  frames only, which would make the limit a per-type rule every daemon has to
  implement before it can read one byte.
- **Lifetime.** The stream ends on `view.stop`, a closed session, a dropped or
  closed channel, a stall or a CDP failure, each with a `view.stopped` reason.
  A redial resumes nothing: the daemon sends `view.start` again.
- **No disk.** browxai writes no frame to the workspace and creates no
  artifact. No frame is in a tool result, log, session report, HAR or recording.
  `test/architecture/live-view-isolation.test.ts` pins the one reader of the
  screencast and the code that may reach the stream.
- **Secrets.** Pixels are outside `SecretRegistry` masking. A registered
  secret typed into a visible text field appears in frames. `screenshot`
  has the same limit. The threat-model row for `live-view` says so, and so does
  the startup warning.
- **Untrusted.** A frame is page-sourced. The daemon renders it as an image and
  does not log, store or interpret it.
- **browxai-cloud.** Frames go to the local daemon only, then over remotxai's
  own encrypted channel. The design uses nothing from browxai-cloud.

```jsonc
// daemon to browxai (every field but session is optional)
{ "v": 1, "type": "view.start", "session": "default", "maxFps": 2, "format": "jpeg", "quality": 60, "maxWidth": 800 }
{ "v": 1, "type": "view.stop", "session": "default" }
{ "v": 1, "type": "frame.ack", "session": "default", "seq": 412 }

// browxai to daemon
{ "v": 1, "type": "view.started", "session": "default", "format": "jpeg", "maxFps": 2, "maxWidth": 800, "quality": 60 }
{ "v": 1, "type": "frame", "session": "default", "seq": 412, "at": 1790000000000, "format": "jpeg", "width": 800, "height": 450, "part": 0, "parts": 2, "data": "<base64>" }
{ "v": 1, "type": "view.stopped", "session": "default", "reason": "daemon" }
{ "v": 1, "type": "error", "code": "unknown-session", "session": "default" }
```

Limits of this first cut:

- **Chromium family only.** `chromium`, an attached Chrome, `android` and
  `electron` stream, from CDP `Page.startScreencast` on the session's own CDP
  handle. A session on another engine is refused with `view-unsupported`.
  Polled screenshots for `firefox`, `webkit`, `safari` and the native engines
  are not built, and their rates are unmeasured.
- **One page.** The stream follows the session's own page, not tabs the agent
  opens later.
- **Open sessions only.** `view.start` for a session that is not open gets
  `unknown-session`. A view never launches a browser, so the daemon retries once
  the agent has made its first browser call.
- **Extension rebuild.** A session whose browser was rebuilt for `extensions`
  leaves a running stream with no source. The daemon restarts it with
  `view.start`.

A later option: stream the rrweb DOM events that `.browx` replay already
captures (`src/replay/`). Registered secrets are masked at capture there, so
the stream would carry `<NAME>` markers where frames carry pixels. The PWA
would need a replay player, and the stream carries full page DOM.

## 5. Credentials and secrets

### Exists

- `register_secret({ name, value, scope? })`, `secrets` capability. The value
  is held in memory for the session, never persisted, and masked back to
  `<NAME>` in every text result. The value is a tool argument, so the model
  that calls it has already seen it.
- `get_credential({ account })`, needs `credentials` and `secrets`. The
  password is fetched server-side from the operator's `op`, `bw` or `lpass`
  CLI and registered as `<PASSWORD_<ACCOUNT>>`. The model never sees it.
- `get_totp({ account })`, `credentials`. Returns the code in plain text.
- `auth_save` / `auth_load` write and read `<ws>/.auth-states/<name>.json`.
  These files hold cookie values in plain JSON (`docs/tool-reference.md`,
  storage security note).

### Recommendation

remotxai never passes credential values into a session. It points each
session at a workspace and a credentials backend:

- For logins, set `BROWX_CREDENTIALS_PROVIDER` per remotxai profile, and
  enable `credentials,secrets` only for sessions that log in. The operator
  authenticates the vault CLI on the host. Values move from the vault to the
  browser without crossing the harness, the daemon or the relay.
- For session reuse, `auth_save` / `auth_load` inside the workspace. Don't
  copy auth-state files between hosts or through the relay.
- Don't send a credential as a prompt or a queued instruction. It lands in
  the transcript, and `register_secret` masking starts only after that.

**Proposed:** `await_human({ kind: "input", secretName: "OTP" })`. The
operator's answer is registered as `<OTP>` and the tool returns the alias,
never the value. This matches remotxai's masked `secret` form field: the value
goes from the phone into the browser and nowhere else. Requires `secrets`.

## 6. Distribution, bundling and shared infrastructure

### Licensing

browxai is MIT. Its production dependencies are MIT or Apache-2.0
(`playwright-core`), listed in `THIRD_PARTY_NOTICES.md`. The
`pnpm licenses:check` gate restricts the production tree to MIT, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense and CC0-1.0. Nothing GPL is
reachable. remotxai can depend on browxai or ship it inside a proprietary
product, keeping browxai's `LICENSE`, `THIRD_PARTY_NOTICES.md` and Playwright's
`NOTICE`. Nothing in this design adds a dependency to browxai.

### Runtime

The browser runs on the operator's host next to the harness. The browser
never runs on the relay. browxai needs Node 22 or later; remotxai's host needs
Node 26, so one Node serves both. Chromium is a separate one-time download
(`playwright-core install chromium`).

### Shipping options

1. The operator installs browxai. remotxai detects `browxai` on `PATH` and
   checks `browxai --version` in `remotxai doctor`. Loosest coupling; the
   version drifts.
2. remotxai pins browxai as a dependency and spawns its `dist/cli.js`.
   remotxai controls the version and tracks browxai's semver surface.
3. Option 2, with an operator override path to a different `browxai` binary.

### Shared infrastructure with browxai-cloud

Options only. Pricing and packaging are Rowin's call.

1. Separate products, separate accounts, no shared infrastructure.
2. One Kalebtec account and billing identity across both; separate relays
   and keys.
3. A shared hosting footprint (one provider organisation, shared edge
   config), with separate apps and separate secrets.
4. A bundled plan covering both.

Whatever the choice: remotxai's encrypted channel does not terminate in
browxai-cloud, and the live view in section 4 does not depend on it.

## 7. remotxai's own UI audits with browxai

What fits today:

- Phone viewports: `open_session({ device: "iPhone 14" })` or
  `set_viewport`, then `overflow_detect` for layout breakage.
- Real Safari on macOS: `engine: "safari"`. iOS Web Push needs a Home Screen
  PWA on a device, which no browxai engine reaches.
- Flake diagnosis: `flake_check({ calls, n })` reruns a sequence 3 to 20 times
  and reports the first step whose outcome differs.
- Assertions: `verify_text`, `verify_visible`, `verify_count`,
  `verify_attribute`.
- Failure evidence: `start_recording({ replay })` writes a `.browx` archive
  with the DOM stream, network, console and tool timeline (`replay`
  capability).
- Scripted runs: the SDK, `createBrowxai({ transport: "stdio-child" })`.
- `export_playwright_script` turns a recorded flow into a Playwright script.

What does not fit: pixel baselines. browxai has no screenshot-baseline diff.
`canvas_diff` compares RGBA captures of `<canvas>` elements and only
byte-compares PNGs. Keep Playwright's screenshot assertions in
`packages/e2e-tests` for baselines. Use browxai for agent-driven audits and
flake hunts.

## Integration steps

1. Add a per-session browxai stdio entry to Claude Code sessions with
   `BROWX_WORKSPACE` per remotxai profile, `BROWX_DEFAULT_PROFILE` per session
   outside the workspace, `BROWX_CONFIG_READONLY=1` and the default capability
   set. Needs browxai v0.11.0 or later. No browxai change.
2. Let the other `mcp__browxai__*` calls go through the existing approval
   cards. No browxai change.
3. Forward browxai screenshot results to the PWA as the first live view, if
   the adapter does not already.
4. Set `BROWX_CREDENTIALS_PROVIDER` per remotxai profile, and enable
   `credentials,secrets` per session on request.
5. browxai: `operator-channel`, built, with its threat-model row and keystones.
   remotxai: the per-session socket and the approval and elicit cards.
6. browxai: `elicitation/create` for `await_human` and confirm hooks, for
   harnesses that forward it.
7. browxai: `live-view` on the operator socket, built for the Chromium family. Polled
   screenshots for the other engines are open.
8. browxai: `await_human({ secretName })`.
9. Pick a shipping option and the browxai-cloud relationship.

## Open questions for remotxai

1. Does the Claude Agent SDK hand an `elicitation/create` from a stdio MCP
   server to remotxai's adapter? Does Codex's app-server? Pi's MCP adapter?
2. Can Codex's `thread/start` `config` override `mcp_servers.browxai.env` for
   one thread?
3. How does a Pi session get per-session MCP env?
4. Does the adapter forward MCP image content from tool results to the PWA
   today?
5. Which directories under the daemon's runtime dir should hold browxai
   workspaces and per-session profile directories, and what deletes them?
6. Which remotxai approval scopes should map to a browxai `grant`? browxai
   accepts one-shot (no `grant`), `session` and `workspace`, and rejects
   `global`. A remotxai scope wider than a workspace has to be kept on the
   daemon side, which would answer each request itself.
7. What frame budget is acceptable on cellular: fps, width, quality?
8. Until `operator-channel` exists, is a 5 minute refusal on a confirm hook
   acceptable for a phone-driven session, or should remotxai drop the hook
   from `BROWX_CONFIRM_REQUIRED` for sessions the operator marks unattended?
