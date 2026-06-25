---
title: FAQ
description: "Short answers to the questions people ask first about browxai: which harnesses it works with, local stdio vs cloud relay, headless and CI, how it differs from a Playwright MCP wrapper, and where the security boundaries are."
---

## Which harnesses and MCP clients work with browxai?

Any MCP client, across multiple harnesses. It is model-agnostic on purpose: it
is not tied to one model or one vendor. How it connects depends on where the
harness runs:

- **Local harnesses** that can launch a process on your machine - Claude Code,
  Codex, and any generic MCP client - run browxai over **stdio** (`command:
  "browxai"`).
- **Cloud harnesses** that cannot reach a local process - Claude.ai, Claude
  Cowork, Claude Desktop sandboxed access, and ChatGPT - connect through a
  **remote MCP relay** (Streamable HTTP) paired to a browxai host running on
  your own hardware.

The per-harness setup, including the marketplace plugin path for Claude Code and
Codex, is in [Getting started](/getting-started/).

## Can I use it with Claude.ai or ChatGPT?

Yes, through a remote MCP relay. These are cloud surfaces that cannot launch a
local stdio server on your machine, so you point them at an HTTPS MCP endpoint
(`https://<relay-host>/mcp`) that is paired to a browxai host on your hardware.
The browser and the browxai process stay on your machine; the relay only gives
the cloud product a reachable MCP endpoint. Do not paste a local `.mcp.json`
command into Claude.ai or ChatGPT - it will not work. See the Claude.ai and
ChatGPT tabs in [Getting started](/getting-started/).

## How is this different from a Playwright MCP wrapper?

browxai is not a shell over `@playwright/mcp` or any other MCP server. It owns
its own **multi-engine transport** - Chromium, Firefox, and WebKit, real
Chrome-on-Android, and real Safari, each over the automation protocol that fits
it (CDP, WebDriver BiDi, safaridriver) behind one capability-port seam. That
ownership is what lets it own the whole session lifecycle: managed profiles,
incognito contexts, attach to an existing Chrome, authenticated and resumable
sessions, headed and headless, and per-session policies for dialogs,
permissions, notifications, and file pickers. A wrapper inherits whatever the
wrapped tool exposes; browxai does not.

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
