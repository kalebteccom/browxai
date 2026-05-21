# browxai on Pi

Pi (pi.dev) has no native MCP support — it is added with the community
`pi-mcp-adapter` extension. This registers browxai through it and installs the
`driving-browxai` skill.

## Prerequisites

- Pi: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
  (installs the `pi` CLI).
- Node.js 20+.
- One-time Chromium download: `npx playwright-core install chromium`.

## 1. Install browxai

```bash
npm install -g browxai
```

## 2. Add MCP support to Pi

```bash
pi install npm:pi-mcp-adapter
```

## 3. Register the MCP server

Create `~/.pi/agent/mcp.json` (global — browxai available in every project),
or `.mcp.json` in a project root, with the contents of [`mcp.json`](mcp.json):

```json
{
  "mcpServers": {
    "browxai": {
      "command": "browxai",
      "lifecycle": "lazy",
      "idleTimeout": 10
    }
  }
}
```

`lifecycle: "lazy"` means Chromium only starts when a browser tool is first
used. To set browxai options, add an `env` block:

```json
{
  "mcpServers": {
    "browxai": {
      "command": "browxai",
      "env": { "BROWX_HEADLESS": "1" },
      "lifecycle": "lazy"
    }
  }
}
```

In Pi, run `/mcp` — `browxai` should appear with its tool surface. Use
`/mcp reconnect browxai` if it does not connect.

## 4. Install the skill

Copy the [`driving-browxai/`](../../driving-browxai/) folder to a skills
directory Pi searches:

- All projects: `~/.pi/agent/skills/driving-browxai/SKILL.md`
- This project: `.pi/skills/driving-browxai/SKILL.md`

Invoke it with `/skill:driving-browxai`; Pi may also trigger it automatically
when a task matches its description.

## 5. Use it

Ask Pi to do something in a browser — it drives browxai through the MCP proxy.
