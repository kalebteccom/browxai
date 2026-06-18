# browxai Claude Code plugin

This installable harness plugin adds browxai to Claude Code as a local stdio
MCP server and bundles the `driving-browxai` skill.

## What it installs

- `.claude-plugin/plugin.json` with Claude Code plugin metadata.
- `.mcp.json` declaring a `browxai` stdio MCP server.
- `skills/driving-browxai/SKILL.md`, copied from the repository harness
  guidance.

## Prerequisites

- A recent Claude Code with plugin support.
- Node.js 20+.
- The `browxai` CLI available on `PATH`.
- Browser binaries installed explicitly with:

```sh
browxai browser install --engine chromium
```

The plugin does not download browsers during install, does not enable
off-by-default browxai capabilities, and does not attach to an existing Chrome
profile.

## MCP server

The bundled MCP config invokes:

```sh
browxai
```

Claude Code applies its normal MCP approval flow to plugin-provided MCP servers.
Set server behavior through environment variables before Claude Code starts the
MCP server, for example:

```sh
BROWX_HEADLESS=1 BROWX_CAPABILITIES=read,navigation,action,human claude
```

Capabilities are resolved once at browxai server start.

## Validation note

Claude Code's plugin format is currently validated by the local Claude CLI. This
artifact intentionally uses only conservative manifest fields plus a skill and
MCP config component so it can be validated once the root marketplace catalog is
generated.
