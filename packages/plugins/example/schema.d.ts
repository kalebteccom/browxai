// Typed SDK overlay for `@browxai/plugin-example` consumers.
//
// SDK consumers import the schema type + compose it via the host's
// `BrowxaiClientWithPlugins` helper to get autocomplete on every
// example tool — `client.plugins.example.echo({msg:"hi"})` — with full
// argument typing.
//
//   import type { ExamplePluginSchema } from "@browxai/plugin-example/schema";
//   import type { BrowxaiClientWithPlugins } from "browxai";
//
//   const client = (await createBrowxai({...})) as BrowxaiClientWithPlugins<ExamplePluginSchema>;
//   await client.plugins.example.echo({msg: "hello"});

// The result type is declared here, not imported, to keep the schema
// declaration free of runtime deps.
/** What an example tool resolves to: the tool's own result, a parsed JSON object. */
type ExampleToolResult = Record<string, unknown>;

export interface ExamplePluginSchema {
  readonly example: {
    /** Round-trip primitive — returns `{ok:true, result:msg}`. */
    echo(args: { msg: string }): Promise<ExampleToolResult>;
    /** Sums two numeric args — returns `{ok:true, sum: a+b}`. */
    add(args: { a: number; b: number }): Promise<ExampleToolResult>;
    /** Argless tool — returns `{ok:true, iso, epochMs}`. */
    now(args?: Record<string, never>): Promise<ExampleToolResult>;
  };
}
