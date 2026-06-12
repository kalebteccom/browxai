# browxai — first-party plugins

The four Kalebtec-maintained plugins that ship from this repo
(`packages/plugins/*`) and publish on npm under the `@browxai/*` scope.
This page is the adopter-facing reference for each plugin's full tool
surface — what it adapts, what it returns, and what it needs enabled on
the host. For the install model and CLI see
[`docs/plugins.md`](./plugins.md); for writing your own plugin see
[`docs/plugin-authoring.md`](./plugin-authoring.md).

| Plugin                                                          | Namespace    | Capabilities      | What it adapts                                          |
| --------------------------------------------------------------- | ------------ | ----------------- | -------------------------------------------------------- |
| [`@browxai/plugin-example`](../packages/plugins/example/)       | `example`    | _(none)_          | Nothing — the canonical runtime-contract reference.       |
| [`@browxai/plugin-figma`](../packages/plugins/figma/)           | `figma`      | `eval` + `canvas` | Figma, via the page-side `figma.*` plugin-context global. |
| [`@browxai/plugin-tldraw`](../packages/plugins/tldraw/)         | `tldraw`     | `eval` + `canvas` | Tldraw v2+, via the `window.editor` global.               |
| [`@browxai/plugin-excalidraw`](../packages/plugins/excalidraw/) | `excalidraw` | `eval` + `canvas` | Excalidraw 0.17+, via the `window.excalidrawAPI` global.  |

## Why the canvas adapters declare `eval` + `canvas`

Every canvas-adapter tool is a thin wrapper around an
`api.callTool("eval_js", {expr})` round-trip: the plugin builds an
app-API expression (`figma.currentPage.selection`,
`editor.createShapes([...])`, `excalidrawAPI.updateScene({...})`),
dispatches it through the host's `eval_js` tool, and parses the JSON
envelope back into a structured `{ok, …}` result. That inner `eval_js`
call goes through the same capability gate a direct MCP call would —
so the plugin honestly declares `eval` (arbitrary JS in page context)
plus `canvas` (the canvas-app automation lane that also gates
`canvas_query`). If either capability is missing from the server's
active set at startup, the plugin is disabled with
`status: "disabled-by-capability-mismatch"` and the reason surfaces on
`plugins_list`.

Enable both before starting the server:

```sh
$ BROWX_CAPABILITIES=read,navigation,action,human,eval,canvas browxai
```

(or persist via `set_config({scope:"user", patch:{capabilities:[...]}})`
and restart — capabilities and plugins are both resolved once at server
start.)

The example plugin declares **no** capabilities — it runs on a server
with the default set and exists to prove the runtime end-to-end.

## Host-app detection — the `<adapter>-not-loaded` envelope

Each canvas adapter probes for its host app's global before doing any
work (`typeof figma !== "undefined"`, `window.editor`,
`window.excalidrawAPI`). When the app isn't on the page — wrong tab,
editor still booting, or the deployment doesn't expose the global —
every tool returns the same structured envelope instead of throwing:

```json
{
  "ok": false,
  "error": "Tldraw not loaded — open the app first OR the surface is not exposed on this version of the app",
  "code": "tldraw-not-loaded"
}
```

The `code` is stable per adapter — `figma-not-loaded`,
`tldraw-not-loaded`, `excalidraw-not-loaded` — so an agent loop can
match on it and recover (navigate to the app, wait, retry). The other
structured codes the adapters share: `bad-arg` (missing/invalid
argument — checked _before_ the page is touched), `eval-failed` (the
page-side expression threw), plus per-tool codes noted below.

## Calling adapter tools

Two equivalent routes:

- **Direct** — the tools are plain namespaced MCP tools:
  `figma.get_selection`, `tldraw.create_shape`, … on `tools/list`.
  On the SDK: `client.plugins.figma.get_selection({})` (typed via each
  plugin's `schema.d.ts` overlay — see
  [`docs/plugin-authoring.md`](./plugin-authoring.md)).
- **Via `canvas_query`** — the canvas-substrate dispatcher maps
  `canvas_query({adapter, op, args})` to the `<adapter>.<op>` registry
  entry. Useful for adapter-generic agent loops; if the plugin isn't
  installed the dispatcher returns the structured `code:"no-adapter"`
  error naming the package to install.

## `@browxai/plugin-example`

The canonical reference plugin. Exercises every primitive of the v1
runtime contract — `register(api)` entry, namespaced registration, no
capabilities, empty `dependsOn` — and is the fixture the plugin-runtime
keystone test loads end-to-end. Install it to smoke-test your plugin
wiring; copy it to start your own plugin.

| Tool           | Args                       | Returns                  |
| -------------- | -------------------------- | ------------------------ |
| `example.echo` | `{msg: string}`            | `{ok: true, result}` — echoes `msg` back (missing `msg` echoes `""`). |
| `example.add`  | `{a: number, b: number}`   | `{ok: true, sum}` — non-numeric args coerce to `0`. |
| `example.now`  | _(none)_                   | `{ok: true, iso, epochMs}`. |

## `@browxai/plugin-figma`

Adapts Figma through the page-side `figma.*` global that Figma exposes
in its plugin-iframe context. Targets the long-stable core of Figma's
plugin API: `figma.viewport.{center,zoom}`,
`figma.currentPage.selection`, `figma.getNodeById()`,
`figma.createRectangle()`, and mutable `x`/`y`/`fills` on scene nodes.

| Tool                     | Args                                                                    | Returns                                                  |
| ------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `figma.get_selection`    | _(none)_                                                                 | `{ok, nodes: [{id, name, type, x, y, width, height}]}`     |
| `figma.get_viewport`     | _(none)_                                                                 | `{ok, center: {x, y}, zoom}`                               |
| `figma.select_node`      | `{nodeId: string}`                                                       | `{ok, nodeId}` — or `code:"node-not-found"`                |
| `figma.move_node`        | `{nodeId: string, dx: number, dy: number}`                               | `{ok, nodeId, x, y}` (post-move position) — or `code:"node-not-found"` |
| `figma.create_rectangle` | `{x, y, width, height, fillColor?: {r, g, b}}` (`r/g/b` are 0–1 floats — Figma's color convention; `width`/`height` must be > 0) | `{ok, nodeId}`                                             |

Error codes: `figma-not-loaded`, `bad-arg`, `node-not-found`,
`eval-failed`.

## `@browxai/plugin-tldraw`

Adapts Tldraw v2+ through the `window.editor` global that Tldraw
exposes when an Editor component is mounted. Targets the v2 Editor API:
`editor.getSelectedShapes()`, `editor.getViewportPageBounds()`,
`editor.getZoomLevel()`, `editor.createShapes()`,
`editor.deleteShapes()`, `editor.setSelectedShapes()`.

| Tool                         | Args                                              | Returns                                              |
| ---------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| `tldraw.get_selected_shapes` | _(none)_                                           | `{ok, shapes: [{id, type, x, y, props}]}`              |
| `tldraw.get_viewport`        | _(none)_                                           | `{ok, x, y, w, h, zoom}` (page-space viewport bounds)  |
| `tldraw.create_shape`        | `{type: string, x: number, y: number, props?: object}` | `{ok, shapeId}` — id resolved by diffing the page shape list before/after; `code:"create-failed"` if no new shape appeared |
| `tldraw.delete_shape`        | `{shapeId: string}`                                | `{ok, shapeId}`                                        |
| `tldraw.select_shapes`       | `{shapeIds: string[]}`                             | `{ok, shapeIds}`                                       |

Error codes: `tldraw-not-loaded`, `bad-arg`, `create-failed`,
`eval-failed`.

## `@browxai/plugin-excalidraw`

Adapts Excalidraw 0.17+ through the `window.excalidrawAPI` global —
the imperative ref the Excalidraw React component hands to its host
page (the public excalidraw.com deployment forwards it by default;
self-hosted embeds must do the same for this plugin to find it).
Targets `excalidrawAPI.getSceneElements()`,
`excalidrawAPI.getAppState()`, `excalidrawAPI.updateScene()`.

| Tool                         | Args                                                              | Returns                                                     |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `excalidraw.get_scene_state` | _(none)_                                                            | `{ok, elements: [{id, type, x, y, width, height}], appState: {viewBackgroundColor, viewModeEnabled, zoom}}` |
| `excalidraw.get_viewport`    | _(none)_                                                            | `{ok, scrollX, scrollY, zoom}`                                |
| `excalidraw.add_element`     | `{type, x, y, width, height, ...passthrough}` (extra fields forwarded to Excalidraw verbatim; `id` minted via `crypto.randomUUID()` when not supplied) | `{ok, elementId}`                                             |
| `excalidraw.delete_element`  | `{elementId: string}`                                               | `{ok, elementId}` — or `code:"element-not-found"`             |
| `excalidraw.set_scroll`      | `{scrollX: number, scrollY: number}`                                | `{ok, scrollX, scrollY}`                                      |

Error codes: `excalidraw-not-loaded`, `bad-arg`, `element-not-found`,
`eval-failed`.

## Usage walkthrough

End-to-end, using Tldraw as the example (the same flow works for any
adapter — swap the install name, the URL, and the ops):

```sh
# 1. Install the plugin (workspace-rooted; see docs/plugins.md).
$ browxai plugin install @browxai/plugin-tldraw

# 2. Start the server with eval + canvas enabled.
$ BROWX_CAPABILITIES=read,navigation,action,human,eval,canvas browxai
```

```
// 3. Confirm the plugin loaded.
plugins_list()
// → [{ "name": "@browxai/plugin-tldraw", "namespace": "tldraw",
//      "version": "0.1.0", "trust": "kalebtec",
//      "capabilities": ["eval", "canvas"], "dependsOn": [],
//      "status": "loaded",
//      "tools": ["tldraw.get_selected_shapes", "tldraw.get_viewport",
//                "tldraw.create_shape", "tldraw.delete_shape",
//                "tldraw.select_shapes"], ... }]

// 4. Open the canvas app.
navigate({ url: "https://www.tldraw.com/" })

// 5. Drive it through the dispatcher (or call tldraw.* directly).
canvas_query({ adapter: "tldraw", op: "get_viewport" })
// → { "ok": true, "x": 0, "y": 0, "w": 1280, "h": 720, "zoom": 1 }

canvas_query({ adapter: "tldraw", op: "create_shape",
               args: { type: "geo", x: 128, y: 128 } })
// → { "ok": true, "shapeId": "shape:abc123" }
```

Per-adapter step 5 equivalents:

```
// figma — open a Figma file in the editor first
canvas_query({ adapter: "figma", op: "get_selection" })
canvas_query({ adapter: "figma", op: "create_rectangle",
               args: { x: 0, y: 0, width: 200, height: 120,
                       fillColor: { r: 0.9, g: 0.2, b: 0.2 } } })

// excalidraw — open https://excalidraw.com/ first
canvas_query({ adapter: "excalidraw", op: "get_scene_state" })
canvas_query({ adapter: "excalidraw", op: "add_element",
               args: { type: "rectangle", x: 64, y: 64,
                       width: 200, height: 120 } })
```

If a step-5 call returns `code:"no-adapter"`, the plugin isn't loaded —
check `plugins_list()` for the status + reason, and remember the
runtime is resolved once at server start (install → restart → retry).
If it returns `code:"<adapter>-not-loaded"`, the plugin is fine but the
app isn't on the current page.

For deeper introspection on one plugin — full manifest, lock pin,
transitive deps, registered tool schemas — call
`plugins_info({name: "@browxai/plugin-tldraw"})`.

## Trust note

All four plugins are trust tier **`kalebtec`** — maintained in the
browxai monorepo, released through the same OIDC-trusted-publishing
pipeline as the host package, npm-provenance signed. But trust is
**advisory, not a sandbox**: browxai plugins run **in-process** with
full Node access, and the runtime gates every tier identically at
capability + call-graph time. Treat installing any plugin — including
these — like adding an npm dependency: review what it declares
(`browxai plugin info <pkg>`), grant only the capabilities it needs,
and audit the live set with `plugins_list`. See
[`docs/plugin-governance.md`](./plugin-governance.md) for the tier
definitions and review process.

## Versioning

Each plugin's manifest carries an advisory `browxaiVersion` range (the
host versions it was tested against) and a binding `apiVersion` (the
plugin-runtime contract major — see
[`docs/plugin-authoring.md`](./plugin-authoring.md)). The canvas
adapters track the upstream app APIs noted per section above; if an
upstream app renames a method, the fix is an eval-expression swap in
the plugin's `src/index.ts` and a patch release.
