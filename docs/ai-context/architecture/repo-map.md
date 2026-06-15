# Repo map (deep)

`AGENTS.md` carries the high-level map. This page goes one level deeper for the substructure agents most often need to navigate.

## `src/`

### `src/server.ts`

MCP server composition root. **Registry composition only — ~382 lines, no business logic.** It builds the shared `ToolHost` (via `src/tools/host-build.ts`) and hands it to each `registerXxxTools(host)` module under `src/tools/`. It does not touch a `src/page/*` handler directly — that path runs through the tool modules. Its 400-line ceiling is enforced (the composition-root guard, see [`fitness-functions.md`](fitness-functions.md)); a feature that needs a server-level concern adds a tool module or a `src/util/` helper, never inline logic here.

### `src/tools/`

The per-family tool-registration layer and the composition seam between `server.ts` and the handlers. `host.ts` declares the `ToolHost` interface — the single seam `createServer` builds once and every `registerXxxTools(host)` module consumes; `host-build.ts` constructs it (closures, capability gate, the engine-selected substrate ports). The `*-tools.ts` modules own the `host.register(name, def, handler)` blocks per family; `session-registry.ts` owns the `[ref=eN]` / session-entry registry. A new tool family is one new `*-tools.ts` module + one `registerXxxTools(host)` line in `server.ts` — composition stays one line longer, the existing families are untouched. Tool metadata (`capability` / `batchable` / `deep`) is **colocated at `host.register`** and the central maps are **derived** from it (RFC 0004 D2), so a tool cannot drift out of the capability/batch/deep sets.

### `src/engine/`

The engine seam. `types.ts` declares `EngineKind` (`"chromium" | "firefox" | "webkit" | "android" | "safari"`) and the `EngineSubInterface` capability dimensions; `capabilities.ts` declares the per-engine `CAPABILITIES` consts; `registry.ts` is the `EngineRegistry` — the **one place an engine name appears as data**; `tool-gate.ts` is the engine-dimension gate; `adapters/` holds the five real adapters + the thin `*.engine.ts` registration modules. **The seam the doctrine grows along** — a new engine is a new adapter file + a `CAPABILITIES` row + one `registerEngine(...)` registration, with no edit to `src/session/{managed,incognito,byob}.ts` or `host-build.ts` (RFC 0004 D1). The `no-engine-literal-branches` lint rule and the `ocp-engine-contract` keystone enforce it.

### `src/cli/` + `src/cli.ts`

The `browxai` bin. Subcommands: `serve` (socket mode), `install-browser`, and the default stdio MCP server. The bin is `dist/cli.js` after build.

### `src/page/`

Per-tool handlers. One file per tool. Files of note:

- `actions.ts` — click / fill / select / hover / press dispatch.
- `dom-export.ts`, `asset-export.ts`, `archive.ts` — bulk read tools.
- `a11y.ts`, `dom-walk.ts` — the snapshot pipeline.
- `bbox.ts`, `compose.ts` — geometry helpers used by `find`, `actions`, `screenshot`.
- `clock.ts`, `await_network.ts`, `coverage.ts`, `dom_diff.ts` — diagnostics and timing.
- `drop-files.ts`, `downloads.ts` — file-io capability surface.
- `canvas.ts` — canvas-app eval routing (used by figma/tldraw/excalidraw plugins).
- `clipboard.ts`, `console.ts` — read surfaces.

Each handler file ends with a `.test.ts` for unit coverage and is also covered by a keystone test in `test/`.

### `src/session/`

Session lifecycle: open/close, persistent profile vs. incognito vs. BYOB-attach, cookie jar isolation, `[ref=eN]` registry.

### `src/util/`

Cross-cutting utilities:

- `capabilities.ts` — the gate. Source of truth for default-on / off-by-default. `RETIRED_CAPABILITIES` is the reference deprecation pattern.
- `workspace.ts` — `resolveWorkspacePath` chokepoint. **All filesystem IO goes through this.**
- `secrets.ts` + `secrets-sinks.ts` — secrets registration + masking at egress.
- `url-sanitizer.ts` — origin allow/blocklist.
- `no-trace.ts` — the no-trace contract (recorded session artifacts leave no trace outside the workspace).
- `deadline.ts` — anti-wedge deadlines on every tool call.
- `config.ts`, `config-store.ts` — config parsing + persistence.
- `diagnostics.ts`, `flake-check.ts` — diagnostics capability surface.

### `src/plugin/`

Plugin runtime: loader, namespace registry, `dependsOn` resolver with cycle detection, capability composition, call-graph enforcement.

### `src/sdk/`

The typed in-process / stdio-child / socket-attached SDK. Same tool registry, same gates, different transport.

### `src/policy/`

Origin policy, confirmation hooks, capability lattice.

### `src/helper/`

Shared internals for handlers (locator resolution, ActionResult builders, probe helpers).

## `packages/plugins/`

Workspace plugins:

- `example/` — minimal plugin demonstrating the v0.7 manifest contract.
- `figma/`, `tldraw/`, `excalidraw/` — first-party canvas-app adapters. Each declares `eval` + `canvas`, routes through `api.callTool("eval_js", {expr})`, and returns a structured `code:"<adapter>-not-loaded"` envelope when the host app isn't on the page.

## `harness/`

- `driving-browxai/SKILL.md` — the portable "drive browxai well" agent skill (loop discipline, anti-wedge, recovery cap).
- `adapters/claude-code/`, `adapters/codex/`, `adapters/pi/` — per-harness MCP registration and adapter notes.

## `test/`

Keystone tests against real Chromium + investigation harness.

## `docs/`

Public VitePress-published documentation. Source of truth for the adopter contract.

## `dist/`

Build output. Regenerated by `pnpm build`. The MCP server runs from here.

## Architecture enforcement

The invariants these boundaries depend on are executable. See
[`fitness-functions.md`](fitness-functions.md) for the index of every fitness
function, custom lint rule, dependency-cruiser rule, and budget — and which law
(L1–L10) each enforces. Boundary changes verify against it (the
`test/architecture/**` lane + `pnpm depcruise`).
