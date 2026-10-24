# @browxai/plugin-tldraw

Adds five Tldraw tools to browxai: `tldraw.get_selected_shapes`, `tldraw.get_viewport`, `tldraw.create_shape`, `tldraw.delete_shape` and `tldraw.select_shapes`. Each one runs a short expression against the `window.editor` global (Tldraw v2 and later) through `eval_js`. When `window.editor` is undefined, every tool returns `code:"tldraw-not-loaded"`.

## Capabilities it needs

`eval` and `canvas`. Both are off by default. If either is missing when the server starts, the plugin loads as `disabled-by-capability-mismatch` and the reason shows up in `plugins_list`.

## Enable it

```sh
browxai plugin install @browxai/plugin-tldraw
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

> On the open Tldraw board, tell me which shapes are selected, then create a `geo` shape at 128,128 and select it.

## Notes

- The tools act on the default session. Open the Tldraw page there first. The page has to expose the editor as `window.editor`. Check with `eval_js({expr: "typeof window.editor"})`.
- They use these Editor methods: `getSelectedShapes()`, `getViewportPageBounds()`, `getZoomLevel()`, `createShapes()`, `deleteShapes()`, `setSelectedShapes()`. If Tldraw renames one, change the expression string in `src/index.ts`.
- Typed SDK access: `client.plugins.tldraw.get_viewport({})`, with the types from `@browxai/plugin-tldraw/schema`.

## Full reference

Every tool with args, return shape and error codes, plus a walkthrough: <https://browxai.com/plugins/first-party/>.
