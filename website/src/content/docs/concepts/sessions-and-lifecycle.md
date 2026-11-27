---
title: Sessions and lifecycle
description: Managed, incognito, and attached browsers, the per-session isolation model that makes multi-agent and multi-user flows safe, and the MCP-restart gotcha.
---

Every browser-touching tool accepts an optional `session` argument (default
`"default"`). Each session id is a fully isolated browser context: its own
cookie jar and storage, its own ref registry, its own console and network
buffers. Concurrency between agents rests on that isolation. For `persistent`
sessions the cookie jar is the profile, so concurrent persistent sessions need
distinct `profile` names (see Session modes below), or use `incognito`.

<div class="browx-iso not-content" role="img" aria-label="One browxai server holds several isolated session contexts. Each session has its own cookie jar, ref registry, and console plus network buffers, so sessions driven by different agents or logged in as different users never bleed into each other.">
  <div class="browx-iso-server">
    <span class="browx-iso-server-k">browxai server</span>
    <span class="browx-iso-server-d">one process, no global active session</span>
  </div>
  <svg class="browx-iso-fan" viewBox="0 0 300 44" preserveAspectRatio="none" aria-hidden="true">
    <path d="M150 0 V14 M150 14 H40 V44 M150 14 H150 V44 M150 14 H260 V44" />
  </svg>
  <div class="browx-iso-row">
    <div class="browx-iso-cell">
      <span class="browx-iso-id">session "agent-a"</span>
      <span class="browx-iso-trait">own cookie jar</span>
      <span class="browx-iso-trait">own refs</span>
      <span class="browx-iso-trait">own buffers</span>
    </div>
    <div class="browx-iso-cell">
      <span class="browx-iso-id">session "agent-b"</span>
      <span class="browx-iso-trait">own cookie jar</span>
      <span class="browx-iso-trait">own refs</span>
      <span class="browx-iso-trait">own buffers</span>
    </div>
    <div class="browx-iso-cell">
      <span class="browx-iso-id">session "user-2"</span>
      <span class="browx-iso-trait">own cookie jar</span>
      <span class="browx-iso-trait">own refs</span>
      <span class="browx-iso-trait">own buffers</span>
    </div>
  </div>
</div>

## The concurrency model

- **Many agents, one server.** Give each agent its own `session` id and they
  cannot stomp each other. There is no server-global "active session".
- **One agent, many sessions.** Drive several windows or flows in parallel by
  id.
- **Multi-user.** Two sessions logged in as different users of the same app do
  not bleed, because they are different browser contexts with different cookie
  jars.

Omitting `session` resolves to a lazily created `"default"` session, so simple
single-session callers need to know none of this. A session id and a `profile`
name are each one plain name: letters, digits, `.`, `_` and `-`, starting with a
letter or digit, at most 128 characters. Anything else is refused with
`invalid-name`.

### Managing sessions

- `open_session({ session, mode?, engine?, profile?, channel?, backgroundThrottling?, device?, viewport?, har?, hars? })`
  eagerly creates an id. Re-opening a live id is an error.
- `close_session({ session })` tears one down.
- `close_sessions({ prefix?, all?, idleMs? })` is the bulk reap primitive for
  multi-agent cleanup. Selectors AND together, and at least one is required so
  you cannot accidentally close nothing or everything.
- `list_sessions()` returns `{ sessions: [{ id, mode, engine, url, pages, openedAt }] }`.

## Session modes

| Mode         | Isolation                                   | Persistence                                     | Use it for                                   |
| ------------ | ------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `persistent` | the workspace default profile, or `profile` | cookies and storage survive across runs         | logged-in flows you want to resume           |
| `incognito`  | own ephemeral context and browser           | nothing persisted, all state discarded on close | one-off driving with no profile trace        |
| `attached`   | the externally launched Chrome (not owned)  | that Chrome's own profile                       | BYOB, attach to a Chrome you already control |

Each `persistent` or `incognito` session is its own browser process, with its own
window unless the server runs headless (`BROWX_HEADLESS=1`). Ten sessions are ten
browsers. That is also true in a `browxai serve --socket` daemon: the daemon shares
one session list between its clients, and every session in it launches its own
browser. Only `attached` sessions share a browser, the Chrome you attach to.

`incognito` ids are always isolated contexts. With `persistent`, a session that
names no `profile` runs on the workspace's default profile, whatever its id, and
`profile: "name"` uses `<workspace>/profiles/name`. A profile is open in one
browser at a time, so a second live session on the same profile is refused with
`profile-in-use`, naming the profile and the session that holds it. Give each
session its own `profile`, or use `incognito`, when two sessions need two
identities.

## The MCP-restart gotcha

In `persistent` and `incognito` modes, browxai spawns Chrome as a child
process of the MCP server. When the MCP client restarts the server, for a
config edit, a code reload, or any other reason, that Chrome child dies with
it and any live page state is gone. A stored ref that pointed at a now-dead
page resolves to `about:blank` or a fresh document.

Two ways keep page state across a client restart. One is a daemon: run
`browxai serve --socket PATH` once and point the client at it with
`browxai bridge --socket PATH`. The daemon owns the browsers, so a client restart
leaves them running. See [Connect MCP clients to one daemon](/guides/bridge/).

The other is to run Chrome yourself and attach to it. `browxai chrome start` opens the installed Chrome on the
workspace's default profile with a debugging port (9222 unless `--port` says
otherwise):

```bash
browxai chrome start
```

Then point the browxai server at it. The server reads its environment once at
start, so set these in the `env` of the MCP config entry, with `byob-attach`
added to the capability list next to the defaults:

```json
{
  "mcpServers": {
    "browxai-attached": {
      "command": "browxai",
      "env": {
        "BROWX_ATTACH_CDP": "http://127.0.0.1:9222",
        "BROWX_CAPABILITIES": "read,navigation,action,human,byob-attach"
      }
    }
  }
}
```

Without `byob-attach` every attached session is refused, naming the
capability. `browxai init <workspace>` writes an MCP config with a
`browxai-attached` entry that already sets both. A profile is open in one Chrome
at a time, so quit any other Chrome on it first, or pass `--profile NAME`. Stop
the Chrome with `browxai chrome stop`.

With the default confirmation hooks, `byob_action` holds every action tool on an
attached browser until a person answers: `__browx.confirm(true)` in the DevTools
`browxai` console context of that Chrome. An unanswered prompt times out after
five minutes and the action does not run. For an unattended run, the operator
drops `byob_action` from `BROWX_CONFIRM_REQUIRED`, or enables `self-approval` and
lets the agent call `approve_actions`. See
[Capabilities and safety](/concepts/capabilities-and-safety/#confirmation-hooks).

An attached Chrome is not owned by browxai: it is never closed on shutdown and
it survives browxai restarts cleanly.

Each attached session opens a new tab in that Chrome and closes it when the
session closes, so your own tabs are left alone. Several browxai servers can
attach to one Chrome this way without sharing a tab. To have a session take
over a tab that is already open, set `BROWX_ATTACH_CLAIM_EXISTING=1` in the
server's `env`, and only when one browxai server is attached to that Chrome.

## Browser channel and background throttling

Two launch-time knobs on a chromium session:

- A chromium session with no `channel` launches the installed Google Chrome,
  without Playwright's `--enable-automation` switch. That has been the default
  since 0.13.0. It launches the bundled Chromium instead when Chrome is not
  installed (with a logged warning), and when the launch loads extensions and
  names no channel, because branded Chrome ignores `--load-extension`.
  `open_session({ channel: "chromium" })` pins the bundled build, and any other
  channel (`"msedge"`, `"chrome-beta"`) launches that installed browser. The
  browser version follows the install. Server-wide default via the `channel`
  config key or `BROWX_CHANNEL`. See
  [Sites behind bot protection](/guides/sites-behind-bot-protection/).
- `open_session({ backgroundThrottling: "disabled" })` launches with Chrome's
  three background-lifecycle flags off, so a backgrounded session keeps timers
  and `requestAnimationFrame` running at full rate. Worth turning on for pooled
  multi-agent work, where an agent polling a backgrounded tab otherwise stalls
  to its deadline and the stall looks like a page bug. The default keeps
  Chrome's own throttling, because reproducing a background-lifecycle bug needs
  a genuinely throttled tab.

Both are launch-time, so an attached session ignores them. Pass
`--disable-background-throttling` to `browxai chrome start` instead.

A window titled "Google Chrome for Testing" on a machine with Google Chrome
installed usually means the MCP client starts a browxai older than 0.13.0, which
launched the bundled build by default. Point the client entry at a current
version, for example `npx -y browxai@latest`, and restart the client.

## Running several clients

Each MCP client entry starts its own browxai server, with its own sessions and
its own browsers. What happens when two of them run at once depends on how you
set them up.

- **Two servers on one workspace.** A profile is open in one browser at a time.
  The first server to open its `default` session holds the workspace default
  profile, and the second server's `default` session is refused with
  `profile-in-use`, naming the profile and the holder. Open the second agent's
  session with `mode: "incognito"` for an ephemeral context that keeps nothing,
  or with its own `profile: "name"`. Each one is another browser and window. A
  separate `BROWX_WORKSPACE` per client also avoids the refusal.
- **One daemon for every client.** Run `browxai serve --socket PATH` and give
  each client `browxai bridge --socket PATH`. The clients share the daemon's
  sessions, capabilities and config, so give each client its own session ids.
  Each session still launches its own browser. See
  [Connect MCP clients to one daemon](/guides/bridge/).
- **Servers attached to one Chrome.** Start Chrome with `browxai chrome start`
  and set `BROWX_ATTACH_CDP` on the server. Every attached session leases its own
  tab in that Chrome and uses its logins, and actions wait for a person's
  confirmation by default. A server knows only the tabs its own sessions lease,
  so run one attached server per Chrome, and use the daemon when several clients
  need it.

## Device and viewport

- `open_session({ device })` takes any Playwright device-preset name (for
  example `"iPhone 14"`, `"Pixel 7"`, `"Desktop Chrome"`) and applies its
  viewport, scale factor, touch, and user agent.
- `open_session({ viewport: { width, height } })` overrides a preset's size
  while keeping its mobile, touch, and UA traits.
- `set_viewport({ session, width, height })` resizes mid-session for
  responsive testing and returns an `ActionResult`, since a re-layout often
  triggers responsive re-render or lazy loading. Only the size changes live;
  full device traits are fixed at session creation.

## Per-session policies

Beyond isolation, each session carries policies for browser events that would
otherwise deadlock a headless context or silently change app state: dialogs
(`alert` / `confirm` / `prompt`), permissions (camera, geolocation, and more),
the `Notification` constructor, and File System Access pickers.

Dialogs, permissions and pickers default to a `raise` posture. The event is
handled so the page does not hang, and the next result reports it as a failure.
Notifications default to `allow`, and each one is still listed on the result.
The [Sessions](/reference/tool-reference/sessions/) section of the tool reference
documents every policy mode.
