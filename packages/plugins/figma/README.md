# @browxai/plugin-figma

Adds five Figma tools to browxai: `figma.get_selection`, `figma.get_viewport`, `figma.select_node`, `figma.move_node` and `figma.create_rectangle`. Each one runs a short expression against the `figma.*` global on the page, through `eval_js`. When the page has no `figma` global, every tool returns `code:"figma-not-loaded"`.

## Capabilities it needs

`eval` and `canvas`. Both are off by default. If either is missing when the server starts, the plugin loads as `disabled-by-capability-mismatch` and the reason shows up in `plugins_list`.

## Enable it

```sh
browxai plugin install @browxai/plugin-figma
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

> In the open Figma file, select the node with id `12:34`, move it 40 px to the right, then add a 200 by 120 red rectangle at 0,0.

## Notes

- The tools act on the default session. Open the Figma page there first.
- They use the long-lived parts of the Figma plugin API: `figma.viewport.{center,zoom}`, `figma.currentPage.selection`, `figma.getNodeById()`, `figma.createRectangle()`, and the `x`, `y` and `fills` properties of scene nodes.
- Typed SDK access: `client.plugins.figma.get_selection({})`, with the types from `@browxai/plugin-figma/schema`.

## Full reference

Every tool with args, return shape and error codes, plus a walkthrough: <https://browxai.com/plugins/first-party/>.
