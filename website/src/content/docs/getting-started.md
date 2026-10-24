---
title: Getting started
description: Install browxai, wire it into an MCP client, and run a first agent flow against a real page.
---

browxai is an [MCP](https://modelcontextprotocol.io/) server that gives an AI
agent a curated browser-control surface. It runs over stdio and is driven by
any MCP client.

## Install

You need Node 22 or newer (`node --version` tells you). browxai drives the
Google Chrome you already have installed, so a machine with Chrome needs no
browser download.

```bash
npm install -g browxai
browxai doctor
```

`browxai doctor` checks the environment and prints a fix next to anything that
fails. On a machine with no Google Chrome it fails until you add a browser:
install Chrome, or fetch the bundled Chromium (about 150 MB).

```bash
npx playwright-core@1.64.1 install chromium
```

A bare Linux image also lacks the system libraries Chromium needs. Add
`--with-deps` to that command to install them (it needs root).

Firefox and WebKit sessions use their own Playwright builds
(`npx playwright-core@1.64.1 install firefox webkit`).

A global install puts the `browxai` binary on your `PATH`, so an MCP client can
launch it by name (`command: "browxai"`). The binary is the MCP server on the
stdio transport. Run by hand in a terminal it just waits for a client, so use
`browxai doctor` to check the machine instead: it reports the Node version, the
browser, the workspace and your configuration.

On Linux and macOS, `npm install -g` can fail with `EACCES` when npm's global
prefix sits in a root-owned directory. Don't reach for `sudo`. Either skip the
global install and use `npx -y browxai` as the client's command ([how to wire it into a
client](#wire-it-into-an-mcp-client)), or give npm a prefix in your home directory:

```bash
npm config set prefix ~/.npm-global
```

Then add `~/.npm-global/bin` to your `PATH` and run the install again.

browxai launches the Google Chrome already installed on the machine, on one
default profile per workspace (`<workspace>/profile`), so logins carry over
between sessions. It looks for Google Chrome at its default install path on each
OS, so a distro Chromium package is not picked up. When there is no Chrome it
falls back to Playwright's bundled Chromium. `browxai doctor` fails only when
neither browser is present.

## Wire it into an MCP client

Add browxai to your client's MCP server config. In Claude Code, one command does it:

```bash
claude mcp add browxai -- browxai
```

In Codex, `codex mcp add browxai -- browxai`. Any other client takes the same
command in its MCP config, for example an `.mcp.json`:

```json
{
  "mcpServers": {
    "browxai": {
      "command": "browxai"
    }
  }
}
```

Prefer not to install globally? Use `{ "command": "npx", "args": ["-y", "browxai"] }`
as the entry (`claude mcp add browxai -- npx -y browxai`). Restart the client
after editing its config, then check that `browxai` shows as connected (in
Claude Code, run `/mcp`).

Other clients keep the same entry in their own file:

| Client         | Config file                                                                                                                        | Entry key         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Claude Desktop | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers`      |
| Cursor         | all users: `~/.cursor/mcp.json`<br>one project: `.cursor/mcp.json`                                                                 | `mcpServers`      |
| VS Code        | one workspace: `.vscode/mcp.json`                                                                                                  | `servers`         |
| Windsurf       | `~/.codeium/windsurf/mcp_config.json`                                                                                              | `mcpServers`      |
| Zed            | `settings.json` (run `zed: open settings`)                                                                                         | `context_servers` |

The entry under that key is `"browxai": { "command": "browxai" }`, as in the
`.mcp.json` example above. Restart the client after saving.

By default the server launches a **managed** Chrome on the workspace's default
profile, headed, with the default capability set (`read`, `navigation`,
`action`, `human`). That is the installed Google Chrome, or the bundled
Chromium with a logged warning when Chrome is absent. Everything dangerous is
opt-in.

A headed browser needs a display. On a machine without one, such as a Linux
server or a container, the first session fails to open until you set
`BROWX_HEADLESS=1` in the server's environment. In the MCP config that is an
`env` entry next to `command`: `"env": { "BROWX_HEADLESS": "1" }`. With
Claude Code, add `--env BROWX_HEADLESS=1` to `claude mcp add`.

### Common environment variables

| Variable             | Purpose                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWX_WORKSPACE`    | Where all transient state lives (default `~/.browxai/`). Never `cwd`.                                                                                                                       |
| `BROWX_HEADLESS`     | `1` or `true` launches headless.                                                                                                                                                            |
| `BROWX_CAPABILITIES` | The full comma-separated capability set. It replaces the default, so keep `read,navigation,action,human` and add `eval`, `network-body`, `clipboard`, or `file-io` to opt into gated tools. |
| `BROWX_ENGINE`       | Default engine, `chromium` unless set. Also `--engine <kind>`. The values are in the [FAQ](/reference/faq/).                                                                                |
| `BROWX_ATTACH_CDP`   | Loopback CDP endpoint to attach to an existing Chrome (BYOB). Needs `byob-attach` in `BROWX_CAPABILITIES` too: `read,navigation,action,human,byob-attach`.                                  |

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
what the page says". The agent calls `navigate` and `snapshot`, and the heading
and link come back as refs it can `click`. A Chrome window opens on a machine
with a display. Headless runs show no window.

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
- **A site shows a challenge page.** browxai does not defeat or spoof bot
  detection, so it cannot clear the challenge for you. `browxai chrome login`
  opens the same Chrome profile with nothing attached so you can clear it by
  hand. See [Sites behind bot protection](/guides/sites-behind-bot-protection/).

## Where to go next

- **[Tool reference](/reference/tool-reference/)** is every tool, its inputs and outputs, example calls, the configuration and session model, and the stability policy.
- **[Agent guidance](https://github.com/kalebteccom/browxai/blob/main/docs/agent-guidance.md)** is the reach-for-this-not-that map: the footguns agents hit and the curated tool that avoids each one.
- **[Configuration](/guides/configuration/)** and **[Recipes](/guides/recipes/)** cover config layers and copy-adaptable flows.
- **[Security and threat model](/security/threat-model/)** is the capability model, what browxai defends against, and what it explicitly does not.
