---
title: Getting started
description: Install browxai, wire it into an MCP client, and run a first agent flow against a real page.
---

browxai is an [MCP](https://modelcontextprotocol.io/) server that gives an AI
agent a curated browser-control surface. It runs over stdio and is driven by
any MCP client.

## Install

You need Node 22 or newer. browxai drives the Google Chrome you already have
installed, so no browser download is required on a machine with Chrome.

```bash
npm install -g browxai
browxai doctor                          # checks the environment and your setup
npx playwright-core install chromium    # optional, ~150 MB: the fallback when Chrome is missing
```

Firefox and WebKit sessions use their own Playwright builds
(`npx playwright-core install firefox webkit`).

A global install puts the `browxai` binary on your `PATH`, so an MCP client can
launch it by name (`command: "browxai"`). The binary is the MCP server on the
stdio transport.

## Wire it into an MCP client

Add browxai to your client's MCP server config. For example, an `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "browxai": {
      "command": "browxai",
    },
  },
}
```

By default the server launches a **managed** Chrome on the workspace's default
profile, headed, with the default capability set (`read`, `navigation`,
`action`, `human`). That is the installed Google Chrome, or the bundled
Chromium with a logged warning when Chrome is absent. Everything dangerous is
opt-in.

### Common environment variables

| Variable             | Purpose                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `BROWX_WORKSPACE`    | Where all transient state lives (default `~/.browxai/`). Never `cwd`.                                          |
| `BROWX_HEADLESS`     | `1` launches headless.                                                                                         |
| `BROWX_CAPABILITIES` | Comma-separated capability set. Add `eval`, `network-body`, `clipboard`, or `file-io` to opt into gated tools. |
| `BROWX_ENGINE`       | Default engine, `chromium` unless set. Also `--engine <kind>`. All eight are in the [FAQ](/reference/faq/).    |
| `BROWX_ATTACH_CDP`   | Loopback CDP endpoint to attach to an existing Chrome (BYOB).                                                  |

See the [tool reference](/reference/tool-reference/) for the full configuration
surface, and note that **capabilities are resolved once at server start**:
changing them means restarting the server.

## A first flow

A typical agent loop:

1. **`navigate`** to a URL.
2. **`snapshot`** to get the accessibility tree plus DOM-walk; every node has a stable `[ref=eN]`.
3. **`find`** to describe the target in natural language; get ranked candidates with a `stability` flag, an `actionable` verdict, and a visible-rect `bbox`.
4. **`click` / `fill` / ...** to act by `ref`; each returns a structured `ActionResult` describing what navigated, what structure changed, and a console/network slice.

For verification use `text_search`, `inspect`, and the read tools; for
flaky or transient UI use `wait_for`, `sample`, and `act_and_sample`.

## A site with a bot-protection challenge

browxai does not defeat or spoof bot detection. When a site shows a challenge
that needs a person, run `browxai chrome login --url https://the-site.example/`,
clear the challenge by hand in the Chrome it opens, then quit that Chrome.
Sessions on the same profile reuse the cookies. The
[guide](/guides/sites-behind-bot-protection/) has the full steps.

## Where to go next

- **[Tool reference](/reference/tool-reference/)** is every tool, its inputs and outputs, example calls, the configuration and session model, and the stability policy.
- **[Agent guidance](https://github.com/kalebteccom/browxai/blob/main/docs/agent-guidance.md)** is the reach-for-this-not-that map: the footguns agents hit and the curated tool that avoids each one.
- **[Configuration](/guides/configuration/)** and **[Recipes](/guides/recipes/)** cover config layers and copy-adaptable flows.
- **[Security and threat model](/security/threat-model/)** is the capability model, what browxai defends against, and what it explicitly does not.
