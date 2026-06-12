// Typed SDK overlay for `@browxai/plugin-figma` consumers.
//
// Compose this schema into the host's `BrowxaiClientWithPlugins` helper to
// get autocomplete on every figma.* tool:
//
//   import type { FigmaPluginSchema } from "@browxai/plugin-figma/schema";
//   import type { BrowxaiClientWithPlugins } from "browxai";
//
//   const client = (await createBrowxai({...})) as BrowxaiClientWithPlugins<FigmaPluginSchema>;
//   await client.plugins.figma.get_selection({});

interface FigmaBrowxaiResult {
  readonly content: ReadonlyArray<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  readonly data?: Record<string, unknown>;
}

export interface FigmaSceneNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FigmaPluginSchema {
  readonly figma: {
    /** Read the current `figma.currentPage.selection` shape. */
    get_selection(args?: Record<string, never>): Promise<FigmaBrowxaiResult>;
    /** Read `figma.viewport.center` + `figma.viewport.zoom`. */
    get_viewport(args?: Record<string, never>): Promise<FigmaBrowxaiResult>;
    /** Set `figma.currentPage.selection` to the node with `nodeId`. */
    select_node(args: { nodeId: string }): Promise<FigmaBrowxaiResult>;
    /** Mutate `node.x += dx; node.y += dy` on the addressed node. */
    move_node(args: { nodeId: string; dx: number; dy: number }): Promise<FigmaBrowxaiResult>;
    /** Create a rectangle via `figma.createRectangle()` — returns `{nodeId}`. */
    create_rectangle(args: {
      x: number;
      y: number;
      width: number;
      height: number;
      fillColor?: { r: number; g: number; b: number };
    }): Promise<FigmaBrowxaiResult>;
  };
}
