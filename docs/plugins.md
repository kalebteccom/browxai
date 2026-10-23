# browxai plugin marketplace index

This is the operator-facing index of browxai plugins. For **authoring
a plugin**, see [`docs/plugin-authoring.md`](./plugin-authoring.md).
For the per-tool reference on the shipped first-party plugins, see
[`docs/plugins-first-party.md`](./plugins-first-party.md).

Four plugins exist today: the reference plugin and three canvas-app
adapters. All four ship from this repo.

## Quick start

```sh
# 1. Install by package name (workspace-rooted, see below).
$ browxai plugin install @browxai/plugin-figma

# 2. Start the server. Keep the four default capabilities in the list and add
#    what the plugin declares (figma needs eval and canvas).
$ BROWX_CAPABILITIES=read,navigation,action,human,eval,canvas browxai

# Optional: check the declaration, install and manifests without running plugin code.
# Doctor reads BROWX_CAPABILITIES too, so pass the same value.
$ BROWX_CAPABILITIES=read,navigation,action,human,eval,canvas browxai doctor
```

Then call `plugins_list()` from your agent and look for
`status: "loaded"`. A plugin whose capabilities are missing from
`BROWX_CAPABILITIES` shows `disabled-by-capability-mismatch` and the
reason. Every first-party plugin README says which capabilities it
needs.

## How to install a plugin

The happy path is an npm install by package name:

```sh
$ browxai plugin install @browxai/plugin-figma
```

During plugin development (or from a checkout of this repo), install
from a local working directory instead, over the same CLI with a `file:`
source and the `local` trust tag. The path can be relative (it resolves
from your shell's working directory) or absolute. The CLI records the
`name` from the directory's `package.json`, for example
`@browxai/plugin-figma`.

```sh
# Dev-loop: build the plugin, then install its directory by path.
$ pnpm build                                            # in the browxai repo
$ browxai plugin install file:./packages/plugins/figma
$ browxai plugin list
```

Every install writes under the workspace root (`$BROWX_WORKSPACE`, default `~/.browxai/`):

- `plugins.json`: the declarative truth (which plugins should load).
- `plugins/node_modules/`: the package-manager-managed install dir. The CLI
  uses `pnpm` when it is on PATH and falls back to `npm` otherwise (so
  npm-installed adopters need no extra tooling); with neither present it
  exits with an actionable error.
- `plugins-lock.json`: an auto-generated pin (version + sha256 of the
  installed package) for reproducibility.

**Server restart required after every install/remove/upgrade.** Plugin
lifecycle is resolved-once-at-server-start. `get_config({scope:"resolved"})`
returns the LIVE enabled set; a divergence between live and persisted
surfaces as the `pluginsPendingRestart` flag.

## A complete `plugins.json`

The declarative file at `<workspace>/plugins.json` after installing the
example plugin plus all three canvas adapters:

```json
{
  "plugins": {
    "@browxai/plugin-example": { "enabled": true },
    "@browxai/plugin-figma": { "enabled": true },
    "@browxai/plugin-tldraw": { "enabled": true },
    "@browxai/plugin-excalidraw": { "enabled": true }
  }
}
```

- `enabled: false` means "declared but skipped at server start", a
  way to switch a plugin off without uninstalling it.
- A `trust` field per entry overrides the trust tier. The CLI writes
  `"trust": "local"` on `file:` installs automatically. There is no
  `trust` subcommand, so any other override is a hand edit.
- A shorthand array form (`"plugins": ["@browxai/plugin-example", …]`)
  is also accepted; every entry is treated as enabled.

`browxai plugin install` maintains this file for you; hand-editing is
supported for the `enabled`/`trust` toggles. After any change, restart
the server.

### The `sync` + lock flow

Each install/upgrade pins `{version, source, contentSha256}` per plugin
into `<workspace>/plugins-lock.json`. `browxai plugin sync` re-runs the
package-manager install inside `<workspace>/plugins/` (reconciling
`node_modules/` with what was previously installed there) and refreshes
the lock pin for every plugin declared in `plugins.json`:

```sh
$ browxai plugin sync
browxai plugin: syncing 4 declared plugin(s)
browxai plugin: sync done. Server restart required — …
```

Use it when the install dir has drifted (a wiped `node_modules/`, a
workspace restored from backup) or to re-pin after out-of-band changes.
A `contentSha256` mismatch against the previous pin means the installed
package's contents changed. Audit before restarting the server.

`browxai doctor` reports this whole surface as its plugins section:
declaration parseability, declared-but-not-installed drift, orphan
installs, lock health (missing lock, `contentSha256` mismatch, stale
pins), and per-plugin manifest sanity (apiVersion, namespace,
capabilities, `dependsOn`), all without executing any plugin code.
Each `✗` comes with a one-line fix, usually `browxai plugin sync`.

## Other CLI subcommands

```sh
$ browxai plugin list                       # list declared plugins
$ browxai plugin info <pkg>                 # full manifest + lock entry
$ browxai plugin remove <pkg>               # uninstall
$ browxai plugin upgrade [<pkg>]            # upgrade one plugin, or all
$ browxai plugin sync                       # reconcile installed dir with plugins.json
```

## MCP introspection

- `plugins_list()` returns every declared plugin's load status. It is
  read-only and gates under `read`.
- `plugins_info({name})` returns the full manifest dump plus the tool
  registry for one plugin. Also read-only, also `read`.

## First-party plugins

Four Kalebtec-maintained plugins ship from this repo and publish as
`@browxai/plugin-*`. **[`docs/plugins-first-party.md`](./plugins-first-party.md) carries the
per-tool reference: every op, its args, its return shape, the not-loaded
envelopes, and a usage walkthrough.** The one-line summary:

| Name                                                            | Tier       | Description                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@browxai/plugin-example`](../packages/plugins/example/)       | `kalebtec` | Reference plugin. Exercises every registry feature (`example.echo`, `example.add`, `example.now`). Canonical source for plugin authors.                                                                                                                     |
| [`@browxai/plugin-figma`](../packages/plugins/figma/)           | `kalebtec` | Figma canvas-app adapter: selection, viewport, node mutate, rectangle create (`figma.get_selection`, `figma.get_viewport`, `figma.select_node`, `figma.move_node`, `figma.create_rectangle`). Capabilities `eval` + `canvas`.                               |
| [`@browxai/plugin-tldraw`](../packages/plugins/tldraw/)         | `kalebtec` | Tldraw canvas-app adapter: shapes/viewport/create/delete/select (`tldraw.get_selected_shapes`, `tldraw.get_viewport`, `tldraw.create_shape`, `tldraw.delete_shape`, `tldraw.select_shapes`). Capabilities `eval` + `canvas`.                                |
| [`@browxai/plugin-excalidraw`](../packages/plugins/excalidraw/) | `kalebtec` | Excalidraw canvas-app adapter: scene state, viewport, element add/delete, scroll (`excalidraw.get_scene_state`, `excalidraw.get_viewport`, `excalidraw.add_element`, `excalidraw.delete_element`, `excalidraw.set_scroll`). Capabilities `eval` + `canvas`. |

The reference plugin is the starting point for new plugin authors and
the fixture the runtime keystone test loads.

## Trust tiers

- `kalebtec`: Kalebtec-maintained plugins
  (`@browxai/plugin-*` on npm).
- `community`: third-party npm plugins
  (`browxai-plugin-*` or `@<org>/browxai-plugin-*`).
- `local`: installed from a file path during development
  (`browxai plugin install file:/abs/path/to/plugin`).

Trust is advisory: the runtime gates all three tiers identically at
capability + call-graph time. Surfaced on `plugins_list` so the
operator can audit.
