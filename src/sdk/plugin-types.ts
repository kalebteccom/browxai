// Phase 8 — typed SDK seam for plugin tools.
//
// Plugin authors ship a TypeScript declaration shaped like:
//
//   export interface MyPluginSchema {
//     readonly figma: {
//       moveNode(args: { nodeId: string; dx: number; dy: number }): Promise<BrowxaiResult>;
//       resizeNode(args: { nodeId: string; width: number; height: number }): Promise<BrowxaiResult>;
//     };
//   }
//
// Consumers compose multiple plugin schemas via the {@link
// BrowxaiClientWithPlugins} helper and get full autocomplete on every
// plugin tool — `client.plugins.figma.moveNode({nodeId, dx, dy})` —
// while the underlying runtime still rides the same `callTool`
// dispatch path the in-process / socket / stdio-child transports use.
//
// The typing surface is purely additive — passing zero schemas leaves
// the plugin caller as the permissive
// `Record<string, Record<string, (args?) => Promise<BrowxaiResult>>>`
// from {@link BrowxaiClient.plugins}.

import type { BrowxaiArgs, BrowxaiClient, BrowxaiResult } from "./types.js";

/**
 * The lattice plugin authors implement. Each top-level key is a
 * plugin namespace; each inner key is a tool name; each inner value is
 * a function-returning-promise. Intentionally permissive — concrete
 * plugin schemas are typed precisely while composed types
 * (intersections of multiple plugin schemas) stay assignable.
 */
export type PluginSchema = Record<string, Record<string, (...args: never[]) => Promise<BrowxaiResult>>>;

// Suppress unused import (BrowxaiArgs kept for forward-compat consumers
// who want to widen the function-arg type).
export type _PluginSchemaArgs = BrowxaiArgs;

/**
 * A {@link BrowxaiClient} typed against a composition of one or more
 * plugin schemas. Use at the point you `createBrowxai()` — the runtime
 * surface is unchanged; this only widens the `plugins` namespace at
 * the type layer.
 *
 *   import type { FigmaPlugin } from "@kalebtec/browxai-plugin-figma";
 *   import type { ExamplePlugin } from "@kalebtec/browxai-plugin-example";
 *
 *   type Schema = FigmaPlugin & ExamplePlugin;
 *
 *   const client = (await createBrowxai({...})) as BrowxaiClientWithPlugins<Schema>;
 *   await client.plugins.figma.moveNode({nodeId: "n1", dx: 10, dy: 20});
 *   await client.plugins.example.echo({msg: "hi"});
 *
 * The type parameter is intentionally unconstrained — interface
 * schemas (which lack TS's "string index signature") still compose
 * cleanly. The runtime is shape-agnostic; the typing layer just
 * widens the `plugins` namespace.
 */
export type BrowxaiClientWithPlugins<P> = Omit<BrowxaiClient, "plugins"> & {
  readonly plugins: P & BrowxaiClient["plugins"];
};
