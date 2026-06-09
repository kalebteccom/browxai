---
name: plugin-author
description: Scaffolds a workspace plugin under packages/plugins/<name>/ per the v0.7 plugin contract — manifest, schema, register(api), README, tests, CHANGELOG.
model: claude-opus-4-7
tools: [Read, Edit, Write, Bash, Grep, Glob]
---

# plugin-author

Scaffolds a new workspace plugin per the v0.7 plugin contract.

## Workflow

1. **Directory.** `packages/plugins/<name>/` (kebab-case).
2. **`package.json`** with the browxai plugin manifest: name, namespace, capabilities required, dependsOn (if any), entry point.
3. **`schema.d.ts`** declaring the plugin's tool input/output shapes for SDK type generation.
4. **`src/index.ts`** exporting `register(api)`. Inside `register`: declare tools, route through `api.callTool(...)` for substrate primitives, never reach into browxai internals.
5. **`README.md`** — purpose, capability surface, host-app version compatibility.
6. **`LICENSE`** — match the project policy (typically MIT for first-party).
7. **Tests.** Plugin-integration tests covering the manifest contract, `register(api)` flow, namespace exposure.
8. **CHANGELOG row** in the host changelog (`CHANGELOG.md`) under `## Unreleased ### Added`.

## Success criteria

- `pnpm -r typecheck` and `pnpm -r test` clean.
- Plugin loads at server start with no warnings.
- Namespace collision check: the namespace doesn't conflict with any existing plugin.
- `dependsOn` resolves topologically without cycles.
- Capability declarations match the actual API calls made.

## What NOT to do

- Do NOT reach into browxai internals. Use `api` exclusively.
- Do NOT inline capability checks; declare them in the manifest.
- Do NOT write to disk outside `api.workspacePath(...)`.
- Do NOT patch substrate code to work around plugin-app changes — the fix stays in the plugin.

## Reference

- `docs/plugin-authoring.md` — public adopter contract.
- `docs/ai-context/plugin-runtime/lifecycle-and-namespacing.md`
- `packages/plugins/example/` — minimal reference implementation.
- `packages/plugins/figma/`, `tldraw/`, `excalidraw/` — first-party adapters.
