# browxai plugins — marketplace index

This is the operator-facing index of browxai plugins. For **authoring
a plugin**, see [`docs/plugin-authoring.md`](./plugin-authoring.md).

The Phase 8 plugin runtime ships as part of browxai v1.0 foundations.
The first wave of plugins consumes the runtime; this index will grow
as Phase 9 (canvas plugins) and the diagnostics-report plugin land.

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
|---|---|---|
| [`@kalebtec/browxai-plugin-example`](../packages/plugins/example/) | `kalebtec` | Reference plugin — exercises every registry feature (`example.echo`, `example.add`, `example.now`). Canonical source for plugin authors. |

Real plugins are landing in Phase 9 (canvas plugins) and the
diagnostics-report plugin follow-up. The reference plugin is the
starting point for new plugin authors and the keystone fodder for the
runtime itself.

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
the generic primitive (Phase 8); the canvas plugins (Phase 9) and
the diagnostics-report plugin will be the first real consumers, and
will demonstrate the inter-plugin composition model
(`dependsOn`-declared, call-graph-enforced).
