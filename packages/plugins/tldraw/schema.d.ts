// Typed SDK overlay for `@browxai/plugin-tldraw` consumers.

interface TldrawBrowxaiResult {
  readonly content: ReadonlyArray<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  readonly data?: Record<string, unknown>;
}

export interface TldrawShape {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly props: Record<string, unknown>;
}

export interface TldrawPluginSchema {
  readonly tldraw: {
    /** Read `editor.getSelectedShapes()` — returns `{ok, shapes:[...]}`. */
    get_selected_shapes(args?: Record<string, never>): Promise<TldrawBrowxaiResult>;
    /** Read viewport page bounds + zoom — returns `{ok, x, y, w, h, zoom}`. */
    get_viewport(args?: Record<string, never>): Promise<TldrawBrowxaiResult>;
    /** Create a shape via `editor.createShapes(...)` — returns `{ok, shapeId}`. */
    create_shape(args: {
      type: string;
      x: number;
      y: number;
      props?: Record<string, unknown>;
    }): Promise<TldrawBrowxaiResult>;
    /** Delete one shape via `editor.deleteShapes([shapeId])`. */
    delete_shape(args: { shapeId: string }): Promise<TldrawBrowxaiResult>;
    /** Set the selected-shape ids via `editor.setSelectedShapes(shapeIds)`. */
    select_shapes(args: { shapeIds: ReadonlyArray<string> }): Promise<TldrawBrowxaiResult>;
  };
}
