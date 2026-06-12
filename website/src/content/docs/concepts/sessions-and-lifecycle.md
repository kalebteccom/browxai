---
title: Sessions and lifecycle
description: Managed, incognito, and attached browsers, the per-session isolation model that makes multi-agent and multi-user flows safe, and the MCP-restart gotcha.
---

Every browser-touching tool accepts an optional `session` argument (default
`"default"`). Each session id is a fully isolated browser context: its own
cookie jar and storage, its own ref registry, its own console and network
buffers. That isolation is the whole concurrency model.

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
single-session callers need to know none of this.

### Managing sessions

- `open_session({ session, mode?, profile?, device?, viewport?, har?, hars? })`
  eagerly creates an id. Re-opening a live id is an error.
- `close_session({ session })` tears one down.
- `close_sessions({ prefix?, all?, idleMs? })` is the bulk reap primitive for
  multi-agent cleanup. Selectors AND together, and at least one is required so
  you cannot accidentally close nothing or everything.
- `list_sessions()` returns `[{ id, mode, url, pages, openedAt }]`.

## Session modes

| Mode         | Isolation                                  | Persistence                                     | Use it for                                   |
| ------------ | ------------------------------------------ | ----------------------------------------------- | -------------------------------------------- |
| `persistent` | own profile dir under the workspace        | cookies and storage survive across runs         | logged-in flows you want to resume           |
| `incognito`  | own ephemeral context and browser          | nothing persisted, all state discarded on close | one-off driving with no profile trace        |
| `attached`   | the externally launched Chrome (not owned) | the user's real profile                         | BYOB, attach to a Chrome you already control |

Different ids are always isolated contexts regardless of mode. With
`persistent`, the `profile` argument lets two ids share a profile dir or pin a
stable name.

## The MCP-restart gotcha

In `persistent` and `incognito` modes, browxai spawns Chromium as a child
process of the MCP server. When the MCP client restarts the server, for a
config edit, a code reload, or any other reason, that Chrome child dies with
it and any live page state is gone. A stored ref that pointed at a now-dead
page resolves to `about:blank` or a fresh document.

If you need page state to survive server restarts, run Chrome yourself and
attach to it:

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$BROWX_WORKSPACE/byob-profile"
```

```bash
BROWX_ATTACH_CDP=http://127.0.0.1:9222
```

An attached Chrome is not owned by browxai: it is never closed on shutdown and
it survives browxai restarts cleanly.

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
the `Notification` constructor, and File System Access pickers. Each defaults
to a `raise` posture, meaning the event is handled so the page does not hang,
but the next result reports it rather than letting it pass silently. The
[tool reference](/reference/tool-reference/) documents every policy mode.
