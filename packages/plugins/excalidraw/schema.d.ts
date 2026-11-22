// Typed SDK overlay for `@browxai/plugin-excalidraw` consumers.

/** What an excalidraw tool resolves to: the tool's own result, a parsed JSON object. */
type ExcalidrawToolResult = Record<string, unknown>;

export interface ExcalidrawElement {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ExcalidrawAppState {
  readonly viewBackgroundColor: string;
  readonly viewModeEnabled: boolean;
  readonly zoom: { value: number };
}

export interface ExcalidrawPluginSchema {
  readonly excalidraw: {
    /** Read scene elements + app state — `{ok, elements:[...], appState:{...}}`. */
    get_scene_state(args?: Record<string, never>): Promise<ExcalidrawToolResult>;
    /** Derive viewport from `appState.scrollX/Y/zoom` — `{ok, scrollX, scrollY, zoom}`. */
    get_viewport(args?: Record<string, never>): Promise<ExcalidrawToolResult>;
    /** Append an element via `excalidrawAPI.updateScene({elements:[...existing, new]})`. */
    add_element(args: {
      type: string;
      x: number;
      y: number;
      width: number;
      height: number;
      [key: string]: unknown;
    }): Promise<ExcalidrawToolResult>;
    /** Remove an element by id via `excalidrawAPI.updateScene`. */
    delete_element(args: { elementId: string }): Promise<ExcalidrawToolResult>;
    /** Set `appState.scrollX/Y` via `excalidrawAPI.updateScene`. */
    set_scroll(args: { scrollX: number; scrollY: number }): Promise<ExcalidrawToolResult>;
  };
}
