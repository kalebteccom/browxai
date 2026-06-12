# browxai plugins — marketplace index

This is the operator-facing index of browxai plugins. For **authoring
a plugin**, see [`docs/plugin-authoring.md`](./plugin-authoring.md).
For the per-tool reference on the shipped first-party plugins, see
[`docs/plugins-first-party.md`](./plugins-first-party.md).

The plugin runtime ships as part of browxai's v1.0 foundations.
The first wave of plugins — the reference plugin plus the three
canvas-app adapters — consumes the runtime today; this index grows as
further plugins (e.g. the diagnostics-report plugin) land.

## How to install a plugin

The happy path is an npm install by package name:

```sh
$ browxai plugin install @browxai/plugin-figma
```

During plugin development (or pre-publish, e.g. working from a checkout
of this repo before the public flip), install from a local working
directory instead — same CLI, `file:` source, trust-tagged `local`:

```sh
# Dev-loop: build the plugin, then install its directory by path.
$ pnpm build                                            # in the browxai repo
$ browxai plugin install file:./packages/plugins/figma/
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

## `plugins.json` — a complete example

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

- `enabled: false` means "declared but skipped at server start" — a
  way to switch a plugin off without uninstalling it.
- A `trust` field per entry overrides the trust tier (the CLI writes
  `"trust": "local"` on `file:` installs automatically).
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
package's contents changed — audit before restarting the server.

`browxai doctor` reports this whole surface as its plugins section:
declaration parseability, declared-but-not-installed drift, orphan
installs, lock health (missing lock, `contentSha256` mismatch, stale
pins), and per-plugin manifest sanity (apiVersion, namespace,
capabilities, `dependsOn`) — all without executing any plugin code.
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

- **`plugins_list()`** — every declared plugin's load status. Read-only
  (gates under `read`).
- **`plugins_info({name})`** — full manifest dump + tool registry for
  one plugin. Read-only (`read`).

## First-party plugins

Four Kalebtec-maintained plugins ship from this repo and publish as
`@browxai/plugin-*`. **The per-tool reference — every op, its args, its
return shape, the not-loaded envelopes, and a usage walkthrough — lives
in [`docs/plugins-first-party.md`](./plugins-first-party.md).** The
one-line summary:

| Name                                                            | Tier       | Description                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@browxai/plugin-example`](../packages/plugins/example/)       | `kalebtec` | Reference plugin — exercises every registry feature (`example.echo`, `example.add`, `example.now`). Canonical source for plugin authors.                                                                                                                     |
| [`@browxai/plugin-figma`](../packages/plugins/figma/)           | `kalebtec` | Figma canvas-app adapter — selection, viewport, node mutate, rectangle create (`figma.get_selection`, `figma.get_viewport`, `figma.select_node`, `figma.move_node`, `figma.create_rectangle`). Capabilities `eval` + `canvas`.                               |
| [`@browxai/plugin-tldraw`](../packages/plugins/tldraw/)         | `kalebtec` | Tldraw canvas-app adapter — shapes/viewport/create/delete/select (`tldraw.get_selected_shapes`, `tldraw.get_viewport`, `tldraw.create_shape`, `tldraw.delete_shape`, `tldraw.select_shapes`). Capabilities `eval` + `canvas`.                                |
| [`@browxai/plugin-excalidraw`](../packages/plugins/excalidraw/) | `kalebtec` | Excalidraw canvas-app adapter — scene state, viewport, element add/delete, scroll (`excalidraw.get_scene_state`, `excalidraw.get_viewport`, `excalidraw.add_element`, `excalidraw.delete_element`, `excalidraw.set_scroll`). Capabilities `eval` + `canvas`. |

The three canvas-app adapter plugins are the v1.0 proof that the plugin
runtime + canvas substrate compose into a real ecosystem story. The
reference plugin remains the starting point for new plugin authors and
the keystone fodder for the runtime itself.

## Trust tiers

- **`kalebtec`** — Kalebtec-maintained plugins
  (`@browxai/plugin-*` on npm).
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
the generic primitive; the canvas adapter plugins are the first real
consumers, and the diagnostics-report plugin will follow as the first
demonstration of the inter-plugin composition model
(`dependsOn`-declared, call-graph-enforced).
