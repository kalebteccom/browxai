# browxai on Claude Code

Register browxai as an MCP server in Claude Code, and install the
`driving-browxai` skill so the agent drives it well.

## Prerequisites

- A recent Claude Code (`claude --version`).
- Node.js 20+.
- One-time Chromium download: `npx playwright-core install chromium`.

## 1. Register the MCP server

From your project directory:

```bash
claude mcp add browxai -- npx -y browxai
```

Start `claude`, run `/mcp`, and confirm `browxai` is connected.

To share the config with your team — a committable `.mcp.json` at the project
root — use project scope:

```bash
claude mcp add browxai --scope project -- npx -y browxai
```

Equivalently, copy [`mcp.json`](mcp.json) from this directory to your project
root as `.mcp.json`.

Set browxai options with `--env` (resolved once at server start — restart to
change):

```bash
claude mcp add browxai \
  --env BROWX_HEADLESS=1 \
  --env BROWX_CAPABILITIES=read,navigation,action,human \
  -- npx -y browxai
```

## 2. Install the skill

Copy the [`driving-browxai/`](../../driving-browxai/) folder into a skills
directory:

- This project (committable): `.claude/skills/driving-browxai/SKILL.md`
- All your projects: `~/.claude/skills/driving-browxai/SKILL.md`

Claude loads it automatically when a request matches its description, or invoke
it directly with `/driving-browxai`.

## 3. Use it

Ask Claude to do something browser-related — it spawns browxai over stdio and
calls its tools. `/mcp` shows live connection status and the tool count.

## Manage the server

```bash
claude mcp list
claude mcp get browxai
claude mcp remove browxai
```
