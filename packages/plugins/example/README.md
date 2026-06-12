# @browxai/plugin-example

The canonical browxai reference plugin. Exercises every primitive of
the v1 plugin-runtime contract — a `register(api)` entry module,
namespaced tool registration, an empty `capabilities` array (runs on a
server with the default capability set), an empty `dependsOn` graph, a
unit-test file, and a typed `schema.d.ts` SDK overlay. It is the
fixture the plugin-runtime keystone test loads end-to-end, and the
layout plugin authors copy to start their own plugin (see
`docs/plugin-authoring.md` in the browxai repo).

Three tools:

- `example.echo({msg})` → `{ok, result}` — round-trip primitive.
- `example.add({a, b})` → `{ok, sum}` — typed-arg demonstration.
- `example.now()` → `{ok, iso, epochMs}` — argless tool shape.

## Install

```sh
$ browxai plugin install @browxai/plugin-example
```

No extra capabilities required. Restart the browxai server after
install (plugin lifecycle is resolved-once-at-server-start). The tools
surface as `example.echo` (etc.) on MCP `tools/list`, and on the SDK as
`client.plugins.example.echo(...)`.

## Full reference

The first-party plugin reference — tool tables, error envelopes, and a
usage walkthrough for this plugin and the three canvas adapters — lives
at <https://browxai.com/plugins/first-party/>.
