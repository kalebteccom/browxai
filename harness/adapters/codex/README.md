# browxai on Codex

Register browxai as an MCP server in the OpenAI Codex CLI, and give Codex the
`driving-browxai` guidance.

## Prerequisites

- OpenAI Codex CLI: `npm i -g @openai/codex`, then run `codex` once to sign in.
- Node.js 20+.
- browxai installed on `PATH`: `npm install -g browxai`.
- Browser binaries installed explicitly: `browxai browser install --engine chromium`.

## 1. Register the MCP server

```bash
codex mcp add browxai -- browxai
```

Or add the block from [`config.toml`](config.toml) to `~/.codex/config.toml`:

```toml
[mcp_servers.browxai]
command = "browxai"
startup_timeout_sec = 30
tool_timeout_sec = 120
```

Confirm with `codex mcp list` / `codex mcp get browxai`.

To set browxai options, add an `env` table (resolved once at server start):

```toml
[mcp_servers.browxai]
command = "browxai"
env = { BROWX_HEADLESS = "1", BROWX_CAPABILITIES = "read,navigation,action,human" }
startup_timeout_sec = 30
```

## 2. Give Codex the guidance

Use either or both:

- **Skill — best for the full playbook.** Copy the
  [`driving-browxai/`](../../driving-browxai/) folder to
  `.agents/skills/driving-browxai/SKILL.md` in your repo. Codex loads it on
  demand (progressive disclosure — no standing context cost).
- **`AGENTS.md` — always-on, short.** Append [`AGENTS.md`](AGENTS.md) from this
  directory to your repo-root `AGENTS.md`. Prefer the repo-root file over the
  global `~/.codex/AGENTS.md`, which has not always loaded reliably.

## 3. Use it

Start `codex` in your project and ask for something browser-related — it spawns
browxai over stdio and calls its tools.
