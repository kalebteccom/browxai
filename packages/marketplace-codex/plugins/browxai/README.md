# browxai Codex plugin

This installable harness plugin adds browxai to Codex as a local stdio MCP
server and bundles the `driving-browxai` skill.

## What it installs

- `.codex-plugin/plugin.json` with Codex-compatible plugin metadata.
- `.mcp.json` declaring a `browxai` stdio MCP server.
- `skills/driving-browxai/SKILL.md`, copied from the repository harness
  guidance.

## Prerequisites

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

Set server behavior through environment variables before Codex starts the MCP
server, for example:

```sh
BROWX_HEADLESS=1 BROWX_CAPABILITIES=read,navigation,action,human codex
```

Capabilities are resolved once at browxai server start.
