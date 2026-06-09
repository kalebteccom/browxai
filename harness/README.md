# browxai harness adapters

browxai is a plain MCP server — any MCP-capable agent harness can drive it. But
an MCP surface only exposes _capability_; it cannot carry _operating discipline_
(run budgets, bounded waits, discard-on-wedge). This directory closes that gap.

## What's here

- **`driving-browxai/`** — the core. An [Agent Skill](https://agentskills.io)
  (`SKILL.md`) that teaches an agent to drive browxai well and not wedge the
  browser session. It is harness-neutral: the Agent Skills standard is shared
  by Claude Code, Codex, and Pi, so this _one_ folder works in all three.
- **`adapters/<harness>/`** — per-harness setup: how to register browxai as an
  MCP server in that harness, and where its skill / instruction files go. Thin
  by design — the difference between harnesses is packaging, not content.

## The model

```
driving-browxai/SKILL.md     one shared skill (the operating discipline)
        +
adapters/<harness>/          per-harness MCP registration + install steps
```

The skill is agent-agnostic. Each adapter is a thin shim that wires browxai's
MCP server into one harness and points it at the shared skill.

## Supported harnesses

| Harness                              | MCP registration               | Skill location                             |
| ------------------------------------ | ------------------------------ | ------------------------------------------ |
| [Claude Code](adapters/claude-code/) | `claude mcp add` / `.mcp.json` | `.claude/skills/`                          |
| [Codex](adapters/codex/)             | `~/.codex/config.toml`         | `.agents/skills/` (+ optional `AGENTS.md`) |
| [Pi](adapters/pi/)                   | `pi-mcp-adapter` + `mcp.json`  | `.pi/skills/` or `.agents/skills/`         |

Start with the README in your harness's adapter directory.
