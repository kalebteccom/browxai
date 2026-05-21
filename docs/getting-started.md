# Getting started

browxai is an [MCP](https://modelcontextprotocol.io/) server that gives an AI
agent a curated browser-control surface. It runs over stdio and is driven by
any MCP client.

## Install

```bash
npm install browxai
npx playwright-core install chromium    # one-time, ~150 MB
```

`browxai` ships a `browxai` binary — the MCP server (stdio transport).

## Wire it into an MCP client

Add browxai to your client's MCP server config. For example, an `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "browxai": {
      "command": "browxai"
    }
  }
}
```

By default the server launches a **managed** Chromium with its own profile,
headed, with the default capability set (`read`, `navigation`, `action`,
`human`). Everything dangerous is opt-in.

### Common environment variables

| Variable | Purpose |
|---|---|
| `BROWX_WORKSPACE` | Where all transient state lives (default `~/.browxai/`). Never `cwd`. |
| `BROWX_HEADLESS` | `1` launches headless. |
| `BROWX_CAPABILITIES` | Comma-separated capability set. Add `eval`, `network-body`, `clipboard`, or `file-io` to opt into gated tools. |
| `BROWX_ATTACH_CDP` | Loopback CDP endpoint to attach to an existing Chrome (BYOB). |

See the [tool reference](/tool-reference) for the full configuration surface —
and note that **capabilities are resolved once at server start**: changing
them means restarting the server.

## A first flow

A typical agent loop:

1. **`navigate`** to a URL.
2. **`snapshot`** — get the accessibility tree + DOM-walk; every node has a stable `[ref=eN]`.
3. **`find`** — describe the target in natural language; get ranked candidates with a `stability` flag, an `actionable` verdict, and a visible-rect `bbox`.
4. **`click` / `fill` / …** — act by `ref`; each returns a structured `ActionResult` describing what navigated, what structure changed, and a console/network slice.

For verification use `text_search`, `inspect`, and the read tools; for
flaky/transient UI use `wait_for`, `sample`, and `act_and_sample`.

## Where to go next

- **[Tool reference](/tool-reference)** — every tool, its inputs/outputs, the configuration and session model, and the stability policy.
- **[Security & threat model](/threat-model)** — the capability model, what browxai defends against, and what it explicitly does not.
