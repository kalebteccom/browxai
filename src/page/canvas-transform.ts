// canvas_world_to_screen / canvas_screen_to_world — affine transform helpers
// (explicit transform OR heuristic discovery of common app-side globals), and
// canvas_query's structured no-adapter error. (See canvas.ts header.)

export interface CanvasTransform {
  scale: number;
  panX: number;
  panY: number;
  /** Optional origin offsets — added after the scale/pan. Default 0. */
  originX?: number;
  originY?: number;
}

export type CanvasAdapterHint = "figma" | "tldraw" | "excalidraw" | "generic";

export interface CanvasWorldToScreenArgs {
  worldX: number;
  worldY: number;
  ref?: string;
  selector?: string;
  transform?: CanvasTransform;
}

export interface CanvasScreenToWorldArgs {
  screenX: number;
  screenY: number;
  ref?: string;
  selector?: string;
  transform?: CanvasTransform;
}

export interface CanvasWorldToScreenResult {
  ok: boolean;
  screenX?: number;
  screenY?: number;
  transformDiscovered?: CanvasTransform;
  adapterHint?: CanvasAdapterHint;
  warnings?: string[];
  error?: string;
  code?: string;
}

export interface CanvasScreenToWorldResult {
  ok: boolean;
  worldX?: number;
  worldY?: number;
  transformDiscovered?: CanvasTransform;
  adapterHint?: CanvasAdapterHint;
  warnings?: string[];
  error?: string;
  code?: string;
}

const DISCOVERY_HEURISTIC_WARNING =
  "discovery probes are HEURISTIC — they match common app-side global shapes (Figma/Excalidraw `app.viewport.{zoom,center}`, Tldraw `app.{scale,offset}`, generic `app.transform.matrix`). Confirm the transform on a known landmark before relying on the result; for production, pass `transform` explicitly or install a canvas-app adapter plugin.";

/** Pure math — apply an affine transform to a world point.
 *  `screen = (world + pan) * scale + origin`. Documented this way (rather
 *  than the matrix form) because that's the shape the discovery probes
 *  return for the three named editors. */
export function applyWorldToScreen(
  world: { x: number; y: number },
  t: CanvasTransform,
): { x: number; y: number } {
  const ox = t.originX ?? 0;
  const oy = t.originY ?? 0;
  return {
    x: (world.x + t.panX) * t.scale + ox,
    y: (world.y + t.panY) * t.scale + oy,
  };
}

/** Inverse: `world = (screen - origin) / scale - pan`. Round-trips with
 *  `applyWorldToScreen` to within fp precision. */
export function applyScreenToWorld(
  screen: { x: number; y: number },
  t: CanvasTransform,
): { x: number; y: number } {
  if (t.scale === 0 || !Number.isFinite(t.scale)) {
    return { x: NaN, y: NaN };
  }
  const ox = t.originX ?? 0;
  const oy = t.originY ?? 0;
  return {
    x: (screen.x - ox) / t.scale - t.panX,
    y: (screen.y - oy) / t.scale - t.panY,
  };
}

/** Page-side discovery probe — REAL function literal. Returns the best
 *  candidate transform found by walking known app-side global shapes,
 *  plus an adapter hint naming which shape matched. Order matters:
 *  Figma/Excalidraw shape is the most common; Tldraw's distinct shape
 *  is tried next; finally the generic 3x3 matrix path. */
export const PAGE_DISCOVER_TRANSFORM_FN = (): {
  ok: boolean;
  transform?: CanvasTransform;
  adapterHint?: CanvasAdapterHint;
} => {
  // Helper — pull a finite number out of `obj[path]` (dot-path); returns
  // undefined if any segment misses or the leaf is non-finite.
  function get(obj: unknown, path: string): number | undefined {
    const parts = path.split(".");
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;
  }

  const w = window as unknown as Record<string, unknown>;

  // 1) Figma / Excalidraw shape — `app.viewport.zoom` + `app.viewport.center.{x,y}`.
  const zoom = get(w.app, "viewport.zoom");
  const cx = get(w.app, "viewport.center.x");
  const cy = get(w.app, "viewport.center.y");
  if (zoom !== undefined && cx !== undefined && cy !== undefined) {
    return {
      ok: true,
      transform: { scale: zoom, panX: -cx, panY: -cy, originX: 0, originY: 0 },
      adapterHint: "figma",
    };
  }

  // 2) Tldraw-like shape — `app.scale` + `app.offset.{x,y}`.
  const tlScale = get(w.app, "scale");
  const tlOffsetX = get(w.app, "offset.x");
  const tlOffsetY = get(w.app, "offset.y");
  if (tlScale !== undefined && tlOffsetX !== undefined && tlOffsetY !== undefined) {
    return {
      ok: true,
      transform: { scale: tlScale, panX: tlOffsetX, panY: tlOffsetY, originX: 0, originY: 0 },
      adapterHint: "tldraw",
    };
  }

  // 3) Generic matrix shape — `app.transform.matrix` as a 6-element
  //    affine (a,b,c,d,e,f → [[a,c,e],[b,d,f],[0,0,1]]) or as a uniform
  //    scale matrix.
  const m = (w.app as Record<string, unknown> | undefined)?.transform as
    | Record<string, unknown>
    | undefined;
  const mat = m?.matrix;
  if (
    Array.isArray(mat) &&
    mat.length >= 6 &&
    mat.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    const a = mat[0] as number;
    const e = mat[4] as number;
    const f = mat[5] as number;
    return {
      ok: true,
      transform: { scale: a, panX: 0, panY: 0, originX: e, originY: f },
      adapterHint: "generic",
    };
  }

  return { ok: false };
};

/** Thin adapter interface — server.ts owns the page-side evaluate call. */
export interface CanvasDiscoverPage {
  evaluate<T, Arg>(fn: (arg: Arg) => T | Promise<T>, args?: Arg): Promise<T>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
}

export async function canvasWorldToScreen(
  page: CanvasDiscoverPage,
  args: CanvasWorldToScreenArgs,
): Promise<CanvasWorldToScreenResult> {
  if (args.transform) {
    const p = applyWorldToScreen({ x: args.worldX, y: args.worldY }, args.transform);
    return { ok: true, screenX: p.x, screenY: p.y };
  }
  const discovered = await page.evaluate(PAGE_DISCOVER_TRANSFORM_FN);
  if (!discovered.ok || !discovered.transform) {
    return {
      ok: false,
      error:
        "no transform discoverable — pass `transform` explicitly OR use a canvas-app adapter plugin",
      code: "no-transform",
    };
  }
  const p = applyWorldToScreen({ x: args.worldX, y: args.worldY }, discovered.transform);
  return {
    ok: true,
    screenX: p.x,
    screenY: p.y,
    transformDiscovered: discovered.transform,
    ...(discovered.adapterHint ? { adapterHint: discovered.adapterHint } : {}),
    warnings: [DISCOVERY_HEURISTIC_WARNING],
  };
}

export async function canvasScreenToWorld(
  page: CanvasDiscoverPage,
  args: CanvasScreenToWorldArgs,
): Promise<CanvasScreenToWorldResult> {
  if (args.transform) {
    const p = applyScreenToWorld({ x: args.screenX, y: args.screenY }, args.transform);
    return { ok: true, worldX: p.x, worldY: p.y };
  }
  const discovered = await page.evaluate(PAGE_DISCOVER_TRANSFORM_FN);
  if (!discovered.ok || !discovered.transform) {
    return {
      ok: false,
      error:
        "no transform discoverable — pass `transform` explicitly OR use a canvas-app adapter plugin",
      code: "no-transform",
    };
  }
  const p = applyScreenToWorld({ x: args.screenX, y: args.screenY }, discovered.transform);
  return {
    ok: true,
    worldX: p.x,
    worldY: p.y,
    transformDiscovered: discovered.transform,
    ...(discovered.adapterHint ? { adapterHint: discovered.adapterHint } : {}),
    warnings: [DISCOVERY_HEURISTIC_WARNING],
  };
}

// ---------- canvas_query ----------

export interface CanvasQueryArgs {
  adapter: string;
  op: string;
  args?: Record<string, unknown>;
}

export interface CanvasQueryNoAdapterError {
  ok: false;
  error: string;
  code: "no-adapter";
  requestedAdapter: string;
  requestedOp: string;
}

/** Build the structured `no-adapter` error returned when `canvas_query`
 *  cannot find a plugin registered under the requested namespace. The
 *  shape is kept stable so adopters can match on `code:"no-adapter"`. */
export function noAdapterError(adapter: string, op: string): CanvasQueryNoAdapterError {
  return {
    ok: false,
    error: `no canvas adapter registered for ${adapter}; install @browxai/plugin-${adapter} or pass a registered adapter namespace`,
    code: "no-adapter",
    requestedAdapter: adapter,
    requestedOp: op,
  };
}
