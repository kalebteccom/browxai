---
title: Getting started
description: Install browxai, wire it into an MCP client, and run a first agent flow against a real page.
---

browxai is an [MCP](https://modelcontextprotocol.io/) server that gives an AI
agent a curated browser-control surface. It runs over stdio and is driven by
any MCP client.

## Install

Node 22 or later is required.

```bash
npm install -g browxai
browxai doctor
```

A global install puts the `browxai` binary on your `PATH`, so an MCP client can
launch it by name (`command: "browxai"`). The binary is the MCP server on the
stdio transport. Run by hand in a terminal it just waits for a client, so use
`browxai doctor` to check the machine instead: it reports the Node version, the
browser, the workspace and your configuration, and prints a fix next to
anything that fails.

browxai launches the Google Chrome already installed on the machine. When there
is no Chrome it falls back to Playwright's bundled Chromium, which you download
once (about 150 MB):

```bash
npx playwright-core install chromium
```

`browxai doctor` fails only when neither browser is present.

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

Prefer not to install globally? Use `{ "command": "npx", "args": ["-y", "browxai"] }`
as the entry. Restart the client after editing its config, then check that
`browxai` shows as connected (in Claude Code, run `/mcp`).

By default the server launches a **managed** Chrome (the installed Google Chrome, or the bundled Chromium when Chrome is absent) on the workspace's default profile,
headed, with the default capability set (`read`, `navigation`, `action`,
`human`). Everything dangerous is opt-in. The Chrome opens on the first tool
call that needs a page, not when the server starts. On a machine with no display,
such as a Linux server or a container, set `BROWX_HEADLESS=1`.

### Common environment variables

| Variable             | Purpose                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWX_WORKSPACE`    | Where all transient state lives (default `~/.browxai/`). Never `cwd`.                                                                                                                       |
| `BROWX_HEADLESS`     | `1` launches headless.                                                                                                                                                                      |
| `BROWX_CAPABILITIES` | The full comma-separated capability set. It replaces the default, so keep `read,navigation,action,human` and add `eval`, `network-body`, `clipboard`, or `file-io` to opt into gated tools. |
| `BROWX_ENGINE`       | Browser engine: `chromium` (default), `firefox`, `webkit`, `android`, or `safari`. Also `--engine <kind>`.                                                                                  |
| `BROWX_ATTACH_CDP`   | Loopback CDP endpoint to attach to an existing Chrome (BYOB).                                                                                                                               |

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

Try it with a prompt such as "open https://example.com, snapshot it and tell me
what the page says". The agent calls `navigate` and `snapshot`; a browser window
opens and the heading and link come back as refs it can `click`.

## When something does not work

- **A session will not open and the error mentions a browser.** Run
  `browxai doctor`. It names whether Chrome and the bundled Chromium are present.
- **`profile-in-use`.** A browser profile is open in one browser at a time. A
  second session on the workspace default profile, or a Chrome opened by
  `browxai chrome start` or `chrome login`, holds it. Quit that Chrome, pass
  `profile: "name"` to `open_session`, or use `mode: "incognito"`.
- **A tool answers that it is disabled.** Its capability is off. Add it to
  `BROWX_CAPABILITIES` together with the default four and restart the server, as
  capabilities are read once at start.
- **A site shows a challenge page.** See
  [Sites behind bot protection](/guides/sites-behind-bot-protection/): browxai
  cannot clear it for you, and `browxai chrome login` lets you do it by hand.

## Where to go next

- **[Tool reference](/reference/tool-reference/)** is every tool, its inputs and outputs, example calls, the configuration and session model, and the stability policy.
- **[Agent guidance](https://github.com/kalebteccom/browxai/blob/main/docs/agent-guidance.md)** is the reach-for-this-not-that map: the footguns agents hit and the curated tool that avoids each one.
- **[Security and threat model](/security/threat-model/)** is the capability model, what browxai defends against, and what it explicitly does not.
