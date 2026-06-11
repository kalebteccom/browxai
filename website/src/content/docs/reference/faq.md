---
title: FAQ
description: "Short answers to the questions people ask first about browxai: what it is, which clients it works with, headless and CI, how it differs from a Playwright MCP wrapper, and where the security boundaries are."
---

## Which MCP clients work with browxai?

Any MCP client that speaks stdio. It is model-agnostic on purpose: use it from
Claude, from Codex, or from anything else that speaks the protocol. It is not
tied to one model or one vendor.

## How is this different from a Playwright MCP wrapper?

browxai is not a shell over `@playwright/mcp` or any other MCP server. It owns
its own Playwright and CDP transport. That ownership is what lets it own the
whole session lifecycle: managed profiles, incognito contexts, attach to an
existing Chrome, authenticated and resumable sessions, headed and headless, and
per-session policies for dialogs, permissions, notifications, and file pickers.
A wrapper inherits whatever the wrapped tool exposes; browxai does not.

## Does it run headless, and in CI?

Yes. Managed Chromium runs headed or headless (`BROWX_HEADLESS=1`, or the
`headless` config key), and the surface is built to run unattended. State that
must survive an MCP-server restart should attach to a separately launched
Chrome; see [Sessions and lifecycle](/concepts/sessions-and-lifecycle/).

## What is BYOB?

Bring your own browser. Instead of letting browxai launch Chromium, you launch
Chrome yourself with a remote debugging port and point browxai at it with
`BROWX_ATTACH_CDP`. The attached browser is not owned by browxai: it is never
closed on shutdown and it survives browxai restarts cleanly. Attaching requires
the `byob-attach` capability.

## Why does my page state disappear sometimes?

In managed and incognito modes, Chromium is a child process of the MCP server.
If the client restarts the server, that Chrome dies with it and live page state
is gone. This is the single most common surprise. The fix, when you need
durable state, is BYOB. See
[Sessions and lifecycle](/concepts/sessions-and-lifecycle/).

## Is the origin allow list a security boundary?

No. Treat `allowedOrigins` and `blockedOrigins` as defense in depth, not a hard
boundary. The [threat model](/security/threat-model/) is explicit about where
the real boundaries are and what browxai does not defend against.

## Can the agent run arbitrary JavaScript?

Only if you turn it on. `eval_js` and `poll_eval` live behind the `eval`
capability, which is off by default. The same is true for full response bodies
(`network-body`), file I/O (`file-io`), and the OS clipboard (`clipboard`). See
[Capabilities and safety](/concepts/capabilities-and-safety/).

## Is page content safe to act on?

Read it, do not obey it. Page text is untrusted. An agent must never treat text
inside a snapshot, a find result, or a network body as instructions to itself.
This holds across the entire surface.

## How do I configure it without environment variables?

Use `set_config({ scope, patch })`. The `BROWX_*` environment variables still
work as a legacy compatibility layer, but the managed config store is the
recommended path. See [Configuration](/guides/configuration/).

## Is it open source?

Yes. browxai is MIT licensed. The source lives at
[github.com/kalebteccom/browxai](https://github.com/kalebteccom/browxai).
