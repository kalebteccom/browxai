# @browxai/plugin-excalidraw

First-party browxai canvas-app adapter for Excalidraw. Exposes five
small, useful tools (`excalidraw.get_scene_state`,
`excalidraw.get_viewport`, `excalidraw.add_element`,
`excalidraw.delete_element`, `excalidraw.set_scroll`) over the
`window.excalidrawAPI` global that the host page sets when embedding the
Excalidraw React component. Each tool is a thin wrapper around an
`eval_js` round-trip: the plugin builds the appropriate
`excalidrawAPI.*` expression, dispatches through `eval_js`, and parses
the value back. When `window.excalidrawAPI` is undefined (Excalidraw not
mounted, or the host page didn't forward the ref), every tool returns
the structured `code:"excalidraw-not-loaded"` envelope.

## Install

```sh
$ browxai plugin install @browxai/plugin-excalidraw
```

The host must have the `eval` and `canvas` capabilities enabled — the
plugin declares both at the manifest level. Restart the browxai server
after install (plugin lifecycle is resolved-once-at-server-start).

The tools surface as `excalidraw.get_scene_state` (etc.) on MCP
`tools/list`, and on the SDK as
`client.plugins.excalidraw.get_scene_state(...)`.

## Targeted Excalidraw API surface

This plugin pokes the Excalidraw 0.17+ ref API as of 2026-06:
`excalidrawAPI.getSceneElements()`, `excalidrawAPI.getAppState()`,
`excalidrawAPI.updateScene({elements, appState})`. These are the
top-level stable methods of the imperative API. Host pages that embed
the Excalidraw component must forward the `excalidrawAPI` ref to
`window.excalidrawAPI` for this plugin to find it; the public
excalidraw.com deployment does this by default.

## Full reference

The per-tool reference for this adapter — every op with args, return
shape, and error codes, plus a usage walkthrough — lives at
<https://browxai.com/plugins/first-party/>.
