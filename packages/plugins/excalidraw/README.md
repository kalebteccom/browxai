# @browxai/plugin-excalidraw

Adds five Excalidraw tools to browxai: `excalidraw.get_scene_state`, `excalidraw.get_viewport`, `excalidraw.add_element`, `excalidraw.delete_element` and `excalidraw.set_scroll`. Each one runs a short expression against the `window.excalidrawAPI` global through `eval_js`. When `window.excalidrawAPI` is undefined, every tool returns `code:"excalidraw-not-loaded"`.

## Capabilities it needs

`eval` and `canvas`. Both are off by default. If either is missing when the server starts, the plugin loads as `disabled-by-capability-mismatch` and the reason shows up in `plugins_list`.

## Enable it

```sh
browxai plugin install @browxai/plugin-excalidraw
BROWX_CAPABILITIES=read,navigation,action,human,eval,canvas browxai
```

`BROWX_CAPABILITIES` replaces the default set, so the line lists the four defaults (`read,navigation,action,human`) and adds `eval,canvas`. In an MCP client config:

```json
{
  "mcpServers": {
    "browxai": {
      "command": "browxai",
      "env": { "BROWX_CAPABILITIES": "read,navigation,action,human,eval,canvas" }
    }
  }
}
```

Restart the server after every install. Plugins load once, at server start. Then check `plugins_list()` for `status: "loaded"`.

## Example prompt

> On the open Excalidraw board, read the scene state, add a 200 by 120 rectangle at 64,64, then scroll the view to 0,0.

## Notes

- The tools act on the default session. Open the Excalidraw page there first. The host page has to forward the Excalidraw component's `excalidrawAPI` ref to `window.excalidrawAPI`. Check with `eval_js({expr: "typeof window.excalidrawAPI"})`.
- They use `getSceneElements()`, `getAppState()` and `updateScene({elements, appState})` from the imperative API of Excalidraw 0.17 and later.
- Typed SDK access: `client.plugins.excalidraw.get_scene_state({})`, with the types from `@browxai/plugin-excalidraw/schema`.

## Full reference

Every tool with args, return shape and error codes, plus a walkthrough: <https://browxai.com/plugins/first-party/>.
