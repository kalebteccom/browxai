---
layout: home

hero:
  name: browxai
  text: A browser, built for agents.
  tagline: MCP-native, model-agnostic, agentic-first browser control — Playwright/CDP under the hood, a curated token-efficient surface on top.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Tool reference
      link: /tool-reference

features:
  - title: Token-efficient surface
    details: snapshot() is a compact accessibility tree + DOM-walk with stable refs — not a DOM dump. find() returns ranked candidates with evidence. Results are scoped, paginated, and token-budgeted.
  - title: Safe by default
    details: Capability-gated tools, an origin allow/blocklist, confirmation hooks, and a hard anti-wedge deadline on every call. Arbitrary JS, full response bodies, OS clipboard, and network mocking are all off by default.
  - title: Model-agnostic
    details: Any MCP client — Claude, Codex, others — over stdio. Not locked to one model, and it owns its own Playwright/CDP transport rather than wrapping someone else's.
  - title: Sessions & lifecycle
    details: Isolated per-session contexts — persistent, incognito, or attach-to-an-existing-Chrome (BYOB). Headed and headless. MCP-driven config; no out-of-band setup.
---
