# @browxai/plugin-example

The reference browxai plugin, and the layout to copy when you write your own. It adds three tools that touch no page and need no capability: `example.echo({msg})` returns `{ok, result}`, `example.add({a, b})` returns `{ok, sum}`, and `example.now()` returns `{ok, iso, epochMs}`. The plugin-runtime keystone test loads it end to end.

## Capabilities it needs

None. The manifest has `"capabilities": []`, so it loads on a server with the default four (`read`, `navigation`, `action`, `human`).

## Enable it

```sh
browxai plugin install @browxai/plugin-example
BROWX_CAPABILITIES=read,navigation,action,human browxai
```

`BROWX_CAPABILITIES` is optional here. The line lists the four defaults, so add to it if you also run other plugins that need more. Restart the server after every install. Plugins load once, at server start. Then check `plugins_list()` for `status: "loaded"`.

## Example prompt

> Call `example.echo` with the message "hello", then `example.add` with 2 and 3, and tell me what each returned.

## Use it as a template

Copy this directory, then change:

| File                | Change                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`      | `name`, `version`, `description`, `repository`, `homepage`, `browxai.namespace` and `browxai.capabilities`. Delete `browxai.trust` unless you publish under `@browxai/*`. |
| `src/index.ts`      | Replace the three tools. Keep `handlers` exported so tests can call them. Give a tool that reads arguments real `zod` fields in `inputSchema`.                            |
| `src/index.test.ts` | Test your handlers.                                                                                                                                                       |
| `schema.d.ts`       | Rename `ExamplePluginSchema` and list your tools for SDK users.                                                                                                           |

Leave `tsconfig.json` and `LICENSE` as they are (set your own license holder). Build with `pnpm build`, install from the directory with an absolute path, restart, and check:

```sh
pnpm build
browxai plugin install file:/abs/path/to/your-plugin
browxai doctor
```

The full contract (manifest fields, `register(api)`, call graph, SDK typing) is in the authoring guide: <https://browxai.com/plugins/authoring/>.

## Full reference

Tool tables, error envelopes and a walkthrough for this plugin and the three canvas adapters: <https://browxai.com/plugins/first-party/>.
