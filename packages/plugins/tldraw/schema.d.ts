// Typed SDK overlay for `@browxai/plugin-tldraw` consumers.

/** What a tldraw tool resolves to: the tool's own result, a parsed JSON object. */
type TldrawToolResult = Record<string, unknown>;

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
    get_selected_shapes(args?: Record<string, never>): Promise<TldrawToolResult>;
    /** Read viewport page bounds + zoom — returns `{ok, x, y, w, h, zoom}`. */
    get_viewport(args?: Record<string, never>): Promise<TldrawToolResult>;
    /** Create a shape via `editor.createShapes(...)` — returns `{ok, shapeId}`. */
    create_shape(args: {
      type: string;
      x: number;
      y: number;
      props?: Record<string, unknown>;
    }): Promise<TldrawToolResult>;
    /** Delete one shape via `editor.deleteShapes([shapeId])`. */
    delete_shape(args: { shapeId: string }): Promise<TldrawToolResult>;
    /** Set the selected-shape ids via `editor.setSelectedShapes(shapeIds)`. */
    select_shapes(args: { shapeIds: ReadonlyArray<string> }): Promise<TldrawToolResult>;
  };
}
