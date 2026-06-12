# @browxai/plugin-figma

First-party browxai canvas-app adapter for Figma. Exposes five small,
useful tools (`figma.get_selection`, `figma.get_viewport`,
`figma.select_node`, `figma.move_node`, `figma.create_rectangle`) over the
page-side `figma.*` global that Figma's plugin context exposes. Each tool
is a thin wrapper around an `eval_js` round-trip: the plugin builds the
appropriate `figma.viewport` / `figma.currentPage.selection` /
`figma.createRectangle()` expression, dispatches through `eval_js`, and
parses the value back. When `figma` isn't defined on the page (no editor
loaded), every tool returns the structured `code:"figma-not-loaded"`
envelope rather than crashing.

## Install

```sh
$ browxai plugin install @browxai/plugin-figma
```

The host must have the `eval` and `canvas` capabilities enabled — the
plugin declares both at the manifest level and the runtime gates the
whole plugin against the operator's active capability set.

After install, restart the browxai server (plugin lifecycle is
resolved-once-at-server-start). The tools surface as
`figma.get_selection` (etc.) on MCP `tools/list`, and on the SDK as
`client.plugins.figma.get_selection(...)`.

## Targeted Figma API surface

This plugin pokes the long-stable parts of the Figma plugin API as of
2026-06: `figma.viewport.{center,zoom}`, `figma.currentPage.selection`,
`figma.getNodeById()`, `figma.createRectangle()`, plus mutable `x` / `y`
/ `fills` properties on scene nodes. Future Figma versions may add
fields; the targeted surface should remain compatible.

## Full reference

The per-tool reference for this adapter — every op with args, return
shape, and error codes, plus a usage walkthrough — lives at
<https://browxai.com/plugins/first-party/>.
