# browxai plugin authoring guide (v1)

This guide is for plugin authors. If you're an operator looking to
_install_ a plugin, see [`docs/plugins.md`](./plugins.md). If you're
looking to extend browxai's core surface (not write a plugin), the
contribution path is `src/page/` / `src/session/`. Plugins are for
self-contained surfaces an outside team owns.

The plugin contract is version `1.0.0` (`apiVersion`). It is
**resolved-once-at-server-start**, plugins load as **in-process JS
modules**, and tool registration is **globally namespaced**.

The fastest start: copy
[`packages/plugins/example/`](../packages/plugins/example/), follow
"Worked example" below, install it with a `file:` path, and check it
with `browxai doctor` and `plugins_list()`.

## What a plugin is

A plugin is a normal npm package with:

- A `"browxai"` field on its `package.json` carrying the manifest.
- A JS entry module exporting a `register(api)` function.
- Zero, one, or many tools registered via `api.registerTool(name, def, handler)`.

That's the entire contract. There is no decorator, no auto-discovery,
no class hierarchy. The minimum viable plugin is one file plus a
`package.json#browxai` field with three required keys (`apiVersion`,
`namespace`, `register`).

## The manifest (`package.json#browxai`)

```json
{
  "name": "browxai-plugin-hello",
  "version": "0.1.0",
  "browxai": {
    "apiVersion": "1.0.0",
    "browxaiVersion": ">=0.13.0",
    "namespace": "hello",
    "register": "dist/index.js",
    "capabilities": [],
    "dependsOn": []
  }
}
```

Every field:

- **`apiVersion`** (required): semver of the plugin-runtime contract
  this plugin codes against. The runtime advertises
  `RUNTIME_API_VERSION = "1.0.0"`. Your plugin's `apiVersion` must
  share the runtime's major + have a minor ≤ runtime's minor. A
  plugin built for `1.0.0` runs under runtime `1.5.0`; a plugin built
  for `2.0.0` does NOT run under runtime `1.x` (rejected at load).
- **`browxaiVersion`** (optional, advisory): semver range of the
  browxai host the plugin was tested against. Surfaced on
  `plugins_list`; never used to reject loading. If the running host's
  version falls outside the range, the runtime logs a warning at load
  time (untested combination) and loads the plugin anyway. The check
  understands `^`, `~`, `>=`, an exact version and `*`. In `0.x`, `^0.13.0`
  matches `0.13.x` only, so every host minor release would log the warning.
  Use `>=` with the oldest host version you tested.
- **`namespace`** (required): the tool prefix. Every tool the
  plugin registers MUST be `<namespace>.<tool>`. Namespace must
  match `/^[a-z][a-z0-9_]*$/` (lowercase, alphanumeric + underscore,
  starts with a letter). Reserved namespaces: `browxai`, `browx`,
  `core`, `system`, `plugins`. Two plugins claiming the same
  namespace BOTH fail with a clear error. Pick something
  project-unique.
- **`register`** (required): relative path to the JS entry module.
  The module must export a `register(api)` function (named OR
  default). The runtime imports the module once at server start and
  calls `register(api)` exactly once.
- **`capabilities`** (default `[]`): capabilities the plugin's tools
  need. Subset of the operator's enabled set at load time. Mismatch
  → plugin disabled (`status: "disabled-by-capability-mismatch"`),
  server still starts.
- **`trust`** (optional): `kalebtec | community | local`. Leave it out
  unless you publish under `@browxai/*`: a `kalebtec` claim on any other
  package name is dropped with a warning. The tier comes from the install
  identity, and the operator can override it per entry in `plugins.json`
  (see [`docs/plugin-governance.md`](./plugin-governance.md)).
- **`dependsOn`** (default `[]`): other browxai plugins this one
  calls into. Each entry is `{plugin: <npm-name>, version: <semver-range>}`.

## The `register(api)` function

```ts
import { z } from "zod";

export function register(api) {
  api.log.info("registering tools", { namespace: api.namespace });

  api.registerTool(
    `${api.namespace}.echo`,
    { description: "Round-trip primitive.", inputSchema: { msg: z.string() } },
    async (args) => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true, result: args.msg ?? "" }) }],
    }),
  );
}

export default register; // either named OR default export works
```

The `api` argument exposes:

- `api.namespace` is your plugin's namespace string.
- `api.declaredCapabilities` is the array you set in the manifest.
- `api.registerTool(name, def, handler)` registers a tool.
  - `name` MUST start with `<namespace>.`. Anything else throws
    synchronously.
  - `def.description`: what the tool does, surfaced in MCP
    `tools/list`.
  - `def.inputSchema` (optional): the arguments the tool accepts, in
    one of two forms. A zod raw shape (`{ msg: z.string() }`, a
    `Record<string, ZodTypeAny>`) is the form core browxai tools use. A
    JSON Schema object needs no `zod` import:
    `{ type: "object", properties: { msg: { type: "string" } }, required: ["msg"] }`.
    The JSON Schema form covers `string`, `number`, `integer`, `boolean`,
    `array` (with `items`), nested `object`, string `enum`, `description`,
    `minLength`/`maxLength` and `minimum`/`maximum`. Any other keyword
    accepts every value. Add `additionalProperties: true` to the top-level
    object to keep keys you did not list. Pass an empty object (or omit)
    for argless tools. The host validates every call against this schema,
    and keys the schema does not declare are dropped before your handler
    runs, so declare every argument the tool reads. If you import `zod`,
    use `zod@^4` (what the host ships) and list it under
    `peerDependencies` (`"zod": "^4.0.0"`) so you share the host's copy.
  - `handler(args)` returns the MCP envelope `{content:[...]}`.
    Handlers should produce `{ok:true,...}` or `{ok:false, error,...}`
    JSON in the first text item, which matches the convention every
    core tool uses.
- `api.callTool(targetName, args?)` calls another tool by name.
  Subject to call-graph enforcement (see below).
- `api.log.{info,warn,error}` is the plugin-scoped logger. Output is
  funnelled through the host's structured logger with `plugin=<name>`
  attached. Plugins MUST NOT write to stdout/stderr directly: stdout
  is the MCP wire.

## Namespace rule (why mandatory)

Every plugin tool is `<namespace>.<tool>`. The bare name without a
prefix is **rejected** at `registerTool` time, even if the suffix
would otherwise be unique. This rule:

- Prevents plugins from overriding or wrapping core browxai tools.
  The core surface lives in the implicit-root namespace, and a plugin
  trying to register `click` would fail.
- Makes it obvious from a tool name alone which plugin owns it
  (`figma.move_node` vs the core `click`).
- Lets the SDK's typed seam expose plugin tools under
  `client.plugins.<namespace>.<tool>` for autocomplete.

## Call-graph enforcement

When your plugin calls `api.callTool(target, args)`:

- If `target` is a core browxai tool → **allowed** (implicit-root,
  always accessible).
- If `target` is one of your OWN tools → **allowed**.
- If `target` is a tool owned by a plugin in your **transitively-
  resolved** `dependsOn` set → **allowed**.
- Otherwise → **rejected** with a structured error:

  ```json
  {
    "ok": false,
    "error": "plugin call-graph violation: <fromPlugin> tried to call <targetPlugin>.<tool> but did not declare <targetPlugin> in dependsOn",
    "code": "plugin-call-graph-violation",
    "fromPlugin": "<your plugin>",
    "targetPlugin": "<target>",
    "targetTool": "<full tool name>",
    "declaredDeps": [...],
    "hint": "Add { plugin, version } to dependsOn, reinstall, restart."
  }
  ```

This is the v1 inter-plugin composition contract. To call another
plugin's tools, declare it in your `package.json#browxai.dependsOn`
with a version range:

```json
"dependsOn": [
  { "plugin": "@browxai/plugin-example", "version": "^0.1.0" }
]
```

The dep graph is built at server start; cycles abort startup loudly.
A missing dep, or one whose installed version doesn't satisfy your
range, downgrades YOUR plugin to `disabled-by-dep-missing`. The
target plugin still loads.

## Capability declarations

If your plugin's tools need a capability beyond the default set
(`read`, `navigation`, `action`, `human`), declare it in
`capabilities`:

```json
"capabilities": ["secrets"]
```

At load time the runtime checks every declared capability is in the
server's active set. Mismatch → your plugin is disabled with status
`disabled-by-capability-mismatch` and the reason surfaces on
`plugins_list`. The operator can fix by adding the capability to
`BROWX_CAPABILITIES` and restarting the server (a saved
`set_config({capabilities})` list can only narrow that set). Capabilities
are resolved ONCE at server start.

At dispatch time every tool you register goes through the host's
capability gate against your declared `capabilities` (specifically:
the first one). A call against the tool with the capability NOT in
the active set returns the same structured `requiredCapability` shape
core browxai tools return.

The v1 plugin-runtime contract gates the WHOLE plugin against the
declared `capabilities` list. Fine-grained per-tool capability
declarations may come in a future minor version.

## Trust tiers

- `kalebtec`: published by Kalebtec under `@browxai/plugin-*`.
  Reference plugins; same release/CI hygiene as browxai itself.
- `community`: third-party npm packages
  (`browxai-plugin-*` or `@<org>/browxai-plugin-*`).
- `local`: file-path-installed plugins. Used during plugin
  development (`browxai plugin install file:/abs/path/to/my-plugin`).

Trust is **advisory**: the runtime gates all three tiers identically
at capability + call-graph time. Surfaced on `plugins_list` so the
operator can audit.

## Running a local plugin

During development, install your plugin's working directory by file
path:

```sh
$ pnpm build                                          # inside my-plugin/
$ browxai plugin install file:./my-plugin             # a relative or an absolute path
$ browxai plugin list
$ browxai doctor                                      # plugins section: manifest, lock, drift
```

A relative path resolves from your shell's working directory. The CLI
reads the plugin's `name` from `<dir>/package.json` (`my-plugin` or
`@me/my-plugin`), then shells out to `pnpm add file:<absolute dir>` (or
`npm install`, when pnpm isn't on PATH) in the workspace's plugin install
dir (`<workspace>/plugins/`). It writes that name to `plugins.json`,
pins the content hash in `plugins-lock.json`, and tags the plugin's trust
tier as `local`. A directory with no `package.json`, or one without a
`name`, is refused before anything is installed.

**Restart the browxai server** for the change to
take effect: plugin lifecycle is resolved-once-at-server-start. Then
call `plugins_list()` and look for `status: "loaded"`. Any other status
comes with a `statusReason`. `plugins_info({name})` adds the manifest
and each tool's input fields.

Local mode is the right shape for fast iteration: edit the plugin's
source, rebuild it (`pnpm build` inside the plugin's own dir),
restart the browxai server. There is **no hot reload**. The
restart is intentional, mirrors the capability lifecycle, and keeps
the per-plugin call-graph deterministic across requests.

## Publishing to npm

For Kalebtec plugins:

1. Land the plugin under `packages/plugins/<name>/` in the
   `kalebteccom/browxai` repo.
2. The release pipeline picks it up alongside the host package and
   publishes `@browxai/plugin-<name>` on npm under the
   official scope.

For community plugins:

1. Use the package name shape `browxai-plugin-<name>` or
   `@<org>/browxai-plugin-<name>`. Operators install by this name.
2. Ship a built `dist/` directory and a typed `schema.d.ts`
   describing your tools' arg/result shapes (see "SDK typing" below).
   Set `"type": "module"`, `"main": "dist/index.js"`,
   `"files": ["dist", "schema.d.ts", "LICENSE"]` and
   `"engines": {"node": ">=22"}`, as the example plugin does. Add the
   `browxai-plugin` keyword so people can find it.
3. Publish the same way you'd publish any npm package
   (`npm publish` / `pnpm publish`). Drop the example's
   `publishConfig.provenance` unless you publish from a CI provider npm
   supports for provenance.

## Plugin lifecycle (resolved-once-at-server-start)

The plugin set is resolved exactly once, at server start. The
runtime reads `plugins.json` + each plugin's `package.json` field +
the resolved-config-store `plugins` array, validates the graph,
topo-sorts the load order, runs every plugin's `register(api)`
exactly once.

This means:

- **No hot reload.** Editing a plugin's source while the server is
  running has zero effect. Restart.
- **`set_config({plugins})` persists but doesn't apply** until the
  next restart, and a saved list can only name a subset of
  `BROWX_PLUGINS`. The `pluginsPendingRestart` flag on
  `get_config({scope:"resolved"})` flags the divergence.
- **Capability gating is server-startup-time, not per-call.** A
  plugin disabled at load time stays disabled until restart.
- **The call-graph is server-startup-time.** A plugin that didn't
  declare another in `dependsOn` cannot acquire that permission mid-
  session.

This contract matches browxai's capability lifecycle (same posture)
and gives operators a deterministic surface to reason about.

## SDK typing for plugin tools

Plugin tools surface on the SDK via the typed escape hatch
`client.callTool("<namespace>.<tool>", args)` AND, more ergonomically,
via the namespaced proxy `client.plugins.<namespace>.<tool>(args)`.

Plugins ship a TypeScript declaration overlay that consumers compose
into their SDK client type:

```ts
// In the plugin's `schema.d.ts`:
export interface ExamplePluginSchema {
  readonly example: {
    echo(args: { msg: string }): Promise<BrowxaiResult>;
    add(args: { a: number; b: number }): Promise<BrowxaiResult>;
    now(args?: Record<string, never>): Promise<BrowxaiResult>;
  };
}
```

```ts
// In the consumer's code:
import { createBrowxai, type BrowxaiClient } from "browxai";
import type { ExamplePluginSchema } from "@browxai/plugin-example/schema";

type Client = Omit<BrowxaiClient, "plugins"> & { readonly plugins: ExamplePluginSchema };

const client = (await createBrowxai({...})) as unknown as Client;
await client.plugins.example.echo({ msg: "hello" });
```

This gives the consumer full autocomplete + arg typing on every
plugin tool, while the runtime still rides the same dispatch path.

## Worked example

`packages/plugins/example/` in the browxai repo is the reference plugin
(`@browxai/plugin-example`). The runtime keystone test loads it end to
end. It has three tools (`example.echo`, `example.add`, `example.now`),
an empty `capabilities` array and an empty `dependsOn`.

Files to copy, and what to change in each:

| File                | What it is                                       | Change                                                                                                                                           |
| ------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json`      | npm metadata plus the `browxai` manifest         | `name`, `version`, `description`, `repository`, `homepage`, `browxai.namespace`, `capabilities`. Delete `trust` unless you publish `@browxai/*`. |
| `src/index.ts`      | `register(api)` and the handlers                 | Your tools. Keep `handlers` exported so tests can call them without a server.                                                                    |
| `src/index.test.ts` | Vitest unit tests that call `handlers` directly  | Test your handlers. Run with `pnpm test` inside the plugin dir.                                                                                  |
| `schema.d.ts`       | Typed SDK overlay (`client.plugins.<ns>.<tool>`) | Rename the interface and list your tools.                                                                                                        |
| `tsconfig.json`     | Compiles `src/` to `dist/`, tests excluded       | Nothing. The `dist/` it writes is what `browxai.register` points at.                                                                             |
| `LICENSE`           | MIT                                              | Your license.                                                                                                                                    |

Build with `pnpm build` (`tsc -p tsconfig.json`), then install it with
the `file:` flow above. The example's `devDependencies` are `typescript`
and `vitest`. The comment in `tsconfig.json` about source maps refers to a package-contents
check this repo's CI runs, so you can ignore it elsewhere.

The example declares its arguments as JSON Schema objects, so the file
needs no `zod` import. `example.now` takes none and declares `{}`. A
tool that reads arguments has to declare them, as `example.echo` and
`example.add` do, or the host drops them before your handler runs.

## Real-world plugins

The example plugin is the toy / learning path. The three canvas-app
adapter plugins show how a real first-party plugin consumes the
runtime: declared capabilities, an `api.callTool("eval_js", …)` inner
loop, structured app-not-loaded errors, and the typed schema overlay.

- [`@browxai/plugin-figma`](../packages/plugins/figma/):
  selection / viewport / node mutate / rectangle create over Figma's
  page-side `figma.*` global.
- [`@browxai/plugin-tldraw`](../packages/plugins/tldraw/):
  shapes / viewport / create / delete / select over Tldraw's
  `window.editor` global.
- [`@browxai/plugin-excalidraw`](../packages/plugins/excalidraw/):
  scene state / viewport / add / delete / scroll over Excalidraw's
  `window.excalidrawAPI` global.

Each is small (one `register(api)`, five tool handlers, a unit-test
file, a README). They all share a common shape: declare `eval` + `canvas`
at the manifest level, route every tool through `api.callTool("eval_js",
{expr})`, parse the envelope back to a structured `{ok, …}` shape, and
return a clear `code:"<adapter>-not-loaded"` error when the host app
isn't on the page. That shape is the recommended pattern for any new
canvas-app adapter.

[`docs/plugins-first-party.md`](./plugins-first-party.md) is the
operator-facing reference for these plugins: every op with args,
return shape, and error codes, plus a usage walkthrough.
