# @kalebtec/browxai-plugin-tldraw

First-party browxai canvas-app adapter for Tldraw. Exposes five small,
useful tools (`tldraw.get_selected_shapes`, `tldraw.get_viewport`,
`tldraw.create_shape`, `tldraw.delete_shape`, `tldraw.select_shapes`)
over the `window.editor` global that Tldraw v2+ exposes when an Editor
component is mounted on the page. Each tool is a thin wrapper around an
`eval_js` round-trip: the plugin builds the appropriate `editor.*`
expression, dispatches through `eval_js`, and parses the value back.
When `window.editor` is undefined (Tldraw not mounted), every tool
returns the structured `code:"tldraw-not-loaded"` envelope.

## Install

```sh
$ browxai plugin install @kalebtec/browxai-plugin-tldraw
```

The host must have the `eval` and `canvas` capabilities enabled — the
plugin declares both at the manifest level. Restart the browxai server
after install (plugin lifecycle is resolved-once-at-server-start).

The tools surface as `tldraw.get_selected_shapes` (etc.) on MCP
`tools/list`, and on the SDK as
`client.plugins.tldraw.get_selected_shapes(...)`.

## Targeted Tldraw API surface

This plugin pokes the Tldraw v2.x Editor API as of 2026-06:
`editor.getSelectedShapes()`, `editor.getViewportPageBounds()`,
`editor.getZoomLevel()`, `editor.createShapes([...])`,
`editor.deleteShapes([...])`, `editor.setSelectedShapes(...)`. The
v2 API has been stable across minor versions; if Tldraw renames a
method, swap the eval-expression string in `src/index.ts` and the
unit tests stay green.
