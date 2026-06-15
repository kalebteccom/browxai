---
title: What browxai is
description: browxai is a browser-control surface designed for AI agents, not for human developers. It owns its own multi-engine transport so it can own the whole session lifecycle.
---

browxai is an [MCP](https://modelcontextprotocol.io/) server that hands an AI
agent a curated browser. It runs over stdio, it speaks to any MCP client, and
it is built around one idea: the consumer of this surface is a model, not a
person.

That single constraint drives every design choice below.

## Built for an agent, not a developer

A human developer reading a page has eyes, a viewport, and infinite patience
for scrolling. A model has a token budget and no eyes. So the primitives are
different:

- `snapshot()` returns a compact accessibility tree with stable `[ref=eN]`
  handles, not a DOM dump. It is scoped, paginated, and budgeted on purpose.
- `find()` takes a plain-language description and returns ranked candidates
  with evidence: a stability flag, an actionable verdict, and a visible-rect
  bounding box. It does not return one guess.
- Every action returns a structured `ActionResult` that says what navigated,
  what structure changed, and gives a slice of console and network activity.
  The agent learns the consequences of its click without a second round trip.

The whole surface is shaped so an agent can drive a real page without drowning
in tokens or guessing at selectors.

## Not a wrapper

browxai is not a thin shell over someone else's MCP server. It owns its own
multi-engine transport spanning Chromium, Firefox, and WebKit, real
Chrome-on-Android, and real Safari, each over the automation protocol that fits
it, behind one capability-port seam. That ownership is the point: it lets browxai
own the full session lifecycle rather than inheriting whatever a wrapped tool
allows.

Owning the transport is what makes the rest possible: managed profiles,
incognito contexts, attach-to-an-existing-Chrome (BYOB), authenticated and
resumable sessions, headed and headless, and per-session policies for dialogs,
permissions, notifications, and file pickers.

## Safe because it has to be

An agent driving a browser is powerful and dangerous. browxai's default
posture is closed:

- Tools are grouped into capabilities. The default set is `read`, `navigation`,
  `action`, and `human`. Arbitrary JavaScript, full response bodies, the OS
  clipboard, file I/O, and a few other sharp tools are off until you opt in.
- Navigation can be scoped to an origin allow and block list.
- Sensitive actions can route through a human confirmation hook before they
  dispatch.
- Every call carries a hard anti-wedge deadline, so a stuck page returns a
  structured failure instead of hanging the agent forever.

See [Capabilities and safety](/concepts/capabilities-and-safety/) for the model,
and the [threat model](/security/threat-model/) for the trust boundaries and
what browxai deliberately does not defend against.

## Where to go next

- [The agent loop](/concepts/the-agent-loop/) is how navigate, snapshot, find,
  and act fit together in practice.
- [Sessions and lifecycle](/concepts/sessions-and-lifecycle/) covers managed,
  incognito, and attached browsers, and the multi-agent concurrency model.
- [Getting started](/getting-started/) installs it and wires it into a client.
