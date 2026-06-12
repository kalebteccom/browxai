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

// We declare the relevant subset of the BrowxaiResult envelope here
// rather than importing it — keeps the schema declaration free of
// runtime deps. Adopters who want the structured payload can also
// import the host's `BrowxaiResult` type and substitute it.
interface ExampleBrowxaiResult {
  readonly content: ReadonlyArray<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  readonly data?: Record<string, unknown>;
}

export interface ExamplePluginSchema {
  readonly example: {
    /** Round-trip primitive — returns `{ok:true, result:msg}`. */
    echo(args: { msg: string }): Promise<ExampleBrowxaiResult>;
    /** Sums two numeric args — returns `{ok:true, sum: a+b}`. */
    add(args: { a: number; b: number }): Promise<ExampleBrowxaiResult>;
    /** Argless tool — returns `{ok:true, iso, epochMs}`. */
    now(args?: Record<string, never>): Promise<ExampleBrowxaiResult>;
  };
}
