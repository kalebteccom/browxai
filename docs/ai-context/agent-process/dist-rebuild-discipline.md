# dist-rebuild discipline — the daemon trap

The MCP server runs the compiled `dist/cli.js`. **Source changes are NOT live until `pnpm build`.** A stale `dist/` that predates a config-parser change can crash the server at MCP handshake.

## The trap

1. Edit source.
2. Believe the change is live because tests pass.
3. The running daemon (Claude Code, Codex, Pi) still holds the *old* `dist/` import graph in memory.
4. Spend an hour debugging a "bug" that's actually stale compiled code.

## The discipline

- After any source change, `pnpm build` regenerates `dist/`.
- A running MCP daemon does **not** pick up the rebuild. Node's `import()` is one-shot at boot. Any `dist/` rebuild after the daemon started means the running daemon is executing stale code.
- **Restart the daemon and surface the new PID explicitly to the operator** before declaring the change verified. Don't assume "I rebuilt" means "the running session sees it."
- For Claude Code: kill the MCP server process tied to the `.mcp.json` entry, then re-run.
- For Codex: same — the server is a child process of Codex; restart Codex's MCP layer.

## CI quality gate

Before pushing:

```
pnpm typecheck && pnpm test && pnpm test:keystone && pnpm lint && pnpm format:check && pnpm build
```

All exit 0. CI runs the same gate. A CI failure on push is a self-inflicted wound — verify locally first.

## Related

- [`code-quality.md`](code-quality.md) — full quality gate contract.
- [`docs-impact.md`](docs-impact.md) — docs updates that travel with behavior changes.
