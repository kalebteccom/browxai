# Plugin runtime — lifecycle and namespacing

Phase-8 added a workspace plugin runtime so external packages can extend browxai's tool surface without touching the core. The runtime guarantees: namespace isolation, capability composition, dependsOn resolution with cycle detection, and call-graph enforcement.

## Lifecycle

Plugins are **resolved once at server start**, never lazily mid-session.

1. Server boot reads `BROWX_PLUGINS` (env) or `createBrowxai({ plugins })` (SDK).
2. Each plugin's manifest is loaded from `packages/plugins/<name>/package.json` (or external workspace).
3. The runtime resolves `dependsOn` order. **Cycles are a fatal startup error**, not a runtime warning.
4. For each plugin, in topological order: `register(api)` is called once. The plugin registers its tools, declares its capability requirements, and may call `api.callTool(...)` against other tools (subject to call-graph enforcement).
5. After all plugins are registered, the MCP server exposes the composed tool surface.

A plugin error during `register()` is a fatal server startup error. Plugins do not have a "running but degraded" mode.

## Namespacing

Every plugin declares a mandatory `namespace` (kebab-case). All tools it registers are exposed as `<namespace>.<tool>` on the MCP surface. The first-party adapters declare `figma`, `tldraw`, `excalidraw`.

Namespace collision is a fatal startup error. Two plugins declaring the same namespace cannot coexist.

## Capability composition

A plugin declares its capability requirements in the manifest:

- The plugin's tools inherit those requirements.
- Composition with adopter-active capabilities is multiplicative — missing any required capability denies the plugin's tools.
- A plugin cannot escalate capabilities. If `eval` is not in the adopter's set, a plugin that requires `eval` is gated out entirely.

## dependsOn + call graph

Plugins may declare `dependsOn: ["<other-namespace>"]`. The runtime:

- Resolves load order topologically.
- Cycle detection rejects circular `dependsOn`.
- Call-graph enforcement: a plugin's `api.callTool(...)` call MUST target a tool from a declared dependency (or the core). Calling an undeclared plugin is a runtime error.

## What plugins MUST NOT do

- Reach into browxai internals. Use `api` exclusively.
- Inline capability checks. Declare requirements in the manifest.
- Write to disk outside `api.workspacePath(...)` (which routes through `resolveWorkspacePath`).
- Mutate global state across sessions.

## Substrate vs. plugin responsibility

The substrate team MUST NOT reach into substrate to fix plugin-app-side breakage. If a host app (Figma, tldraw, Excalidraw) ships an update that breaks the plugin's page-side adapter, the fix stays in the plugin — `packages/plugins/<name>/`. The substrate's job is to keep the plugin runtime contract stable; the plugin's job is to track its host app.

This discipline is what makes the plugin model trustworthy. See [`../agent-process/code-quality.md`](../agent-process/code-quality.md) "Workspace plugin discipline."

## Related

- [`../../plugin-authoring.md`](../../plugin-authoring.md) — public adopter contract.
- [`../tool-registration/server-tool-registry.md`](../tool-registration/server-tool-registry.md) — how registry composition works.
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md) — capability composition rules.
