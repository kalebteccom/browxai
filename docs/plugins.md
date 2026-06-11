# browxai plugins — marketplace index

This is the operator-facing index of browxai plugins. For **authoring
a plugin**, see [`docs/plugin-authoring.md`](./plugin-authoring.md).

The plugin runtime ships as part of browxai's v1.0 foundations.
The first wave of plugins consumes the runtime; this index will grow
as the canvas plugins and the diagnostics-report plugin land.

## How to install a plugin

```sh
# From npm:
$ browxai plugin install @kalebtec/browxai-plugin-example
# From a local working directory:
$ browxai plugin install file:./my-plugin/
```

Every install writes under the workspace root (`$BROWX_WORKSPACE`, default `~/.browxai/`):

- `plugins.json` — the declarative truth (which plugins should load).
- `plugins/node_modules/` — pnpm-managed install dir.
- `plugins-lock.json` — auto-generated pin (version + sha256 of the
  installed package) for reproducibility.

**Server restart required after every install/remove/upgrade.** Plugin
lifecycle is resolved-once-at-server-start. `get_config({scope:"resolved"})`
returns the LIVE enabled set; a divergence between live and persisted
surfaces as the `pluginsPendingRestart` flag.

## Other CLI subcommands

```sh
$ browxai plugin list                       # list declared plugins
$ browxai plugin info <pkg>                 # full manifest + lock entry
$ browxai plugin remove <pkg>               # uninstall
$ browxai plugin upgrade [<pkg>]            # upgrade one plugin, or all
$ browxai plugin sync                       # reconcile installed dir with plugins.json
```

## MCP introspection

- **`plugins_list()`** — every declared plugin's load status. Read-only
  (gates under `read`).
- **`plugins_info({name})`** — full manifest dump + tool registry for
  one plugin. Read-only (`read`).

## Currently published

| Name | Tier | Description |
| ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@kalebtec/browxai-plugin-example`](../packages/plugins/example/) | `kalebtec` | Reference plugin — exercises every registry feature (`example.echo`, `example.add`, `example.now`). Canonical source for plugin authors. |
| [`@kalebtec/browxai-plugin-figma`](../packages/plugins/figma/) | `kalebtec` | Figma canvas-app adapter — selection, viewport, node mutate, rectangle create (`figma.get_selection`, `figma.get_viewport`, `figma.select_node`, `figma.move_node`, `figma.create_rectangle`). Capabilities `eval` + `canvas`. |
| [`@kalebtec/browxai-plugin-tldraw`](../packages/plugins/tldraw/) | `kalebtec` | Tldraw canvas-app adapter — shapes/viewport/create/delete/select (`tldraw.get_selected_shapes`, `tldraw.get_viewport`, `tldraw.create_shape`, `tldraw.delete_shape`, `tldraw.select_shapes`). Capabilities `eval` + `canvas`. |
| [`@kalebtec/browxai-plugin-excalidraw`](../packages/plugins/excalidraw/) | `kalebtec` | Excalidraw canvas-app adapter — scene state, viewport, element add/delete, scroll (`excalidraw.get_scene_state`, `excalidraw.get_viewport`, `excalidraw.add_element`, `excalidraw.delete_element`, `excalidraw.set_scroll`). Capabilities `eval` + `canvas`. |

The three canvas-app adapter plugins are the v1.0 proof that the plugin
runtime + canvas substrate compose into a real ecosystem story. The
reference plugin remains the starting point for new plugin authors and
the keystone fodder for the runtime itself.

## Trust tiers

- **`kalebtec`** — Kalebtec-maintained plugins
  (`@kalebtec/browxai-plugin-*` on npm).
- **`community`** — third-party npm plugins
  (`browxai-plugin-*` or `@<org>/browxai-plugin-*`).
- **`local`** — installed from a file path during development
  (`browxai plugin install file:./path/`).

Trust is advisory — the runtime gates all three tiers identically at
capability + call-graph time. Surfaced on `plugins_list` so the
operator can audit.

## Why plugins?

The plugin runtime turns browxai from "the best curated agentic-
browser substrate" into "the ecosystem substrate". The runtime is
the generic primitive; the canvas plugins and
the diagnostics-report plugin will be the first real consumers, and
will demonstrate the inter-plugin composition model
(`dependsOn`-declared, call-graph-enforced).
