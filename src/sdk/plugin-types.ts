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
 * the method signature.
 *
 * The constraint is intentionally minimal — anything more would
 * couple plugin schemas to host-side Zod shapes (which the SDK
 * deliberately keeps opaque, per `src/sdk/types.ts`).
 */
export type PluginSchema = {
  readonly [namespace: string]: {
    readonly [tool: string]: (args?: BrowxaiArgs) => Promise<BrowxaiResult>;
  };
};

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
 */
export type BrowxaiClientWithPlugins<P extends PluginSchema> = Omit<BrowxaiClient, "plugins"> & {
  readonly plugins: P & BrowxaiClient["plugins"];
};
