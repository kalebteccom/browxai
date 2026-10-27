---
title: What browxai is
description: browxai is a browser-control surface designed for AI agents. It owns its multi-engine transport and the whole session lifecycle.
---

browxai is an [MCP](https://modelcontextprotocol.io/) server that hands an AI
agent a curated browser. It runs over stdio and speaks to any MCP client.
The consumer of its surface is a model, and each design choice below follows
from that.

## At a glance

An agent gets a compact, readable view of the page and a short list of tools to find, click, fill and read it. browxai drives eight engines in three families: five browsers (Chromium, Firefox, WebKit, real Safari and real Chrome on an Android phone), two native-app engines on an Android emulator and the iOS Simulator, and a desktop Electron app. By default it launches the installed Google Chrome on one default profile per workspace. Every capability past the default four (read, navigation, action and human) starts off until you switch it on. It works with any MCP client over stdio, and ships a typed TypeScript SDK.

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

## Native apps, desktop apps and sessions

### Native apps, same tools

Switch on `native-device` and `find`, `click` and `fill` drive an app on an
Android emulator or the iOS Simulator. The tree comes off the app's view
hierarchy, with the same refs a page gets. Android is verified against a live
emulator; the iOS lane is newer and needs a WebDriverAgent you run. Native apps
run on an emulator or simulator only, with no real-device lane.

### The Electron app you have open

An Electron app is Chromium, so one started with `--remote-debugging-port`
answers the same CDP browxai already speaks. Attach to an app such as VS Code
and `snapshot` and `find` read its UI. It needs `byob-attach`. The engine is
attach-only, `navigate` refuses, and whether a port opens at all depends on the
app and its version.

### Sessions and lifecycle

Chromium sessions launch the installed Google Chrome, or the bundled Chromium
when Chrome is missing, on one default profile per workspace. Sessions are
isolated contexts: persistent, incognito, or attached to a Chrome you already
have open, on your desktop or on a plugged-in Android phone. Headed and
headless. Pick the engine per session, so one server can hold a Chromium page
and an emulator app at once.

### Sites behind bot protection

By default browxai does not defeat or spoof bot detection, and it cannot
guarantee access to any site. When a challenge needs a person,
`browxai chrome login` opens the installed Chrome on the workspace profile with
nothing attached. Clear it by hand, quit Chrome, and later sessions on that
profile reuse the cookies. The off-by-default `stealth` and `captcha`
capabilities patch four browser properties and hand captchas to a third-party
solving service. Read
[Sites behind bot protection](/guides/sites-behind-bot-protection/).

## Where to go next

- [The agent loop](/concepts/the-agent-loop/) is how navigate, snapshot, find,
  and act fit together in practice.
- [Sessions and lifecycle](/concepts/sessions-and-lifecycle/) covers managed,
  incognito, and attached browsers, and the multi-agent concurrency model.
- [Getting started](/getting-started/) installs it and wires it into a client.
