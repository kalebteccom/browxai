// Typed SDK overlay for `@kalebtec/browxai-plugin-excalidraw` consumers.

interface ExcalidrawBrowxaiResult {
  readonly content: ReadonlyArray<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  readonly data?: Record<string, unknown>;
}

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
    get_scene_state(args?: Record<string, never>): Promise<ExcalidrawBrowxaiResult>;
    /** Derive viewport from `appState.scrollX/Y/zoom` — `{ok, scrollX, scrollY, zoom}`. */
    get_viewport(args?: Record<string, never>): Promise<ExcalidrawBrowxaiResult>;
    /** Append an element via `excalidrawAPI.updateScene({elements:[...existing, new]})`. */
    add_element(args: {
      type: string;
      x: number;
      y: number;
      width: number;
      height: number;
      [key: string]: unknown;
    }): Promise<ExcalidrawBrowxaiResult>;
    /** Remove an element by id via `excalidrawAPI.updateScene`. */
    delete_element(args: { elementId: string }): Promise<ExcalidrawBrowxaiResult>;
    /** Set `appState.scrollX/Y` via `excalidrawAPI.updateScene`. */
    set_scroll(args: { scrollX: number; scrollY: number }): Promise<ExcalidrawBrowxaiResult>;
  };
}
