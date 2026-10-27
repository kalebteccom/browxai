---
title: What browxai is
description: browxai is a browser-control surface designed for AI agents. It owns its multi-engine transport and the whole session lifecycle.
---

browxai is an [MCP](https://modelcontextprotocol.io/) server that hands an AI
agent a curated browser. It runs over stdio and speaks to any MCP client.
The consumer of its surface is a model, and each design choice below follows
from that.

## Built for an agent

A human developer reading a page has eyes and a viewport, and scrolls as long
as needed. A model has a token budget and no eyes. The primitives differ
accordingly:

- `snapshot()` returns a compact accessibility tree with stable `[ref=eN]`
  handles. It is scoped, paginated, and budgeted.
- `find()` takes a plain-language description and returns ranked candidates
  with evidence: a stability flag, an actionable verdict, and a visible-rect
  bounding box.
- Every action returns a structured `ActionResult` that says what navigated,
  what structure changed, and gives a slice of console and network activity.
  The agent learns the consequences of its click without a second round trip.

## What browxai owns

browxai has its own multi-engine transport across eight engines in three families: Chromium,
Firefox, WebKit, real Safari and real Chrome-on-Android; native apps on an
Android emulator and the iOS Simulator; and an attached desktop Electron app.
Each speaks the automation protocol that fits it, behind one capability-port
seam. Because browxai owns the transport, it also provides managed profiles,
incognito contexts, attach-to-an-existing-Chrome (BYOB), authenticated and
resumable sessions, headed and headless modes, and per-session policies for
dialogs, permissions, notifications, and file pickers.

## Default posture

browxai's default posture is closed:

- Tools are grouped into capabilities. The default set is `read`, `navigation`,
  `action`, and `human`. Arbitrary JavaScript, full response bodies, the OS
  clipboard, file I/O, the native-app engines, and a few other sharp tools are
  off until you opt in.
- Navigation can be scoped to an origin allow and block list.
- Sensitive actions can route through a human confirmation hook before they
  dispatch.
- Every call carries a hard anti-wedge deadline, so a stuck page returns a
  structured failure and the agent keeps running.

See [Capabilities and safety](/concepts/capabilities-and-safety/) for the model,
and the [threat model](/security/threat-model/) for the trust boundaries and
what browxai deliberately does not defend against.

## Where to go next

- [The agent loop](/concepts/the-agent-loop/) is how navigate, snapshot, find,
  and act fit together in practice.
- [Sessions and lifecycle](/concepts/sessions-and-lifecycle/) covers managed,
  incognito, and attached browsers, and the multi-agent concurrency model.
- [Getting started](/getting-started/) installs it and wires it into a client.
