# Plugin runtime: lifecycle and namespacing

browxai ships a workspace plugin runtime so external packages can extend the tool surface without touching the core. The runtime keeps namespaces isolated, composes capabilities, resolves `dependsOn` and rejects cycles, and enforces the call graph.

## Lifecycle

Plugins are **resolved once at server start**, never lazily mid-session.

1. Server boot reads `BROWX_PLUGINS` (env) or `createBrowxai({ plugins })` (SDK).
2. Each plugin's manifest is loaded from `packages/plugins/<name>/package.json`, or from an external workspace.
3. The runtime resolves `dependsOn` order. A cycle is a fatal startup error, never a runtime warning you can ignore.
4. For each plugin, in topological order, `register(api)` is called once. The plugin registers its tools, declares what capabilities it needs, and may call `api.callTool(...)` against other tools, subject to call-graph enforcement.
5. Once every plugin has registered, the MCP server exposes the composed tool surface.

A plugin that throws during `register()` kills server startup. Plugins do not have a "running but degraded" mode.

## Namespacing

Every plugin declares a mandatory `namespace` in kebab-case, and every tool it registers shows up as `<namespace>.<tool>` on the MCP surface. The first-party adapters declare `figma`, `tldraw` and `excalidraw`.

A namespace collision is a fatal startup error. Two plugins declaring the same namespace cannot coexist.

## Capability composition

A plugin declares in its manifest what capabilities it needs. Its tools inherit those requirements, and composition with the adopter's active set is multiplicative: miss any required capability and the plugin's tools are denied. A plugin can't escalate. If `eval` isn't in the adopter's set, a plugin requiring `eval` is gated out entirely.

## dependsOn + call graph

Plugins may declare `dependsOn: ["<other-namespace>"]`. The runtime:

- Resolves load order topologically.
- Rejects circular `dependsOn` through cycle detection.
- Enforces the call graph, so a plugin's `api.callTool(...)` MUST target a tool from a declared dependency or from the core. Calling an undeclared plugin is a runtime error.

## What plugins MUST NOT do

- Reach into browxai internals. Use `api` exclusively.
- Inline capability checks. Declare requirements in the manifest.
- Write to disk outside `api.workspacePath(...)`, which routes through `resolveWorkspacePath`.
- Mutate global state across sessions.

## Substrate vs. plugin responsibility

The substrate team MUST NOT reach into substrate to fix plugin-app-side breakage. If a host app (Figma, tldraw, Excalidraw) ships an update that breaks the plugin's page-side adapter, the fix stays in the plugin, under `packages/plugins/<name>/`. The substrate's job is to keep the plugin runtime contract stable; the plugin's job is to track its host app.

See [`../agent-process/code-quality.md`](../agent-process/code-quality.md) under "Workspace plugin discipline."

## Related

- [`../../plugin-authoring.md`](../../plugin-authoring.md): public adopter contract.
- [`../tool-registration/server-tool-registry.md`](../tool-registration/server-tool-registry.md): how registry composition works.
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md): capability composition rules.
