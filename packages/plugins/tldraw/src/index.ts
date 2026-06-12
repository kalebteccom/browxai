// @browxai/plugin-tldraw — Tldraw canvas-app adapter.
//
// Surfaces five small, useful tools over the `window.editor` global that
// Tldraw (v2+) exposes when an Editor component is mounted on the page.
// Each tool routes through `eval_js` — the plugin builds the
// `editor.*` expression, dispatches it, and parses the value back.
//
// Targeted API surface (Tldraw v2.x, current as of 2026-06):
//   - editor.getSelectedShapes()    → Shape[]
//   - editor.getViewportPageBounds() → {x,y,w,h}
//   - editor.getZoomLevel()         → number
//   - editor.createShapes([...])    → void (assigns shape ids)
//   - editor.deleteShapes([ids])    → void
//   - editor.setSelectedShapes(ids) → void
//
// When `window.editor` is undefined (Tldraw not mounted / not on the
// page), every tool returns `code:"tldraw-not-loaded"`.

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ToolResponse {
  readonly content: ReadonlyArray<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
}

interface PluginApi {
  readonly namespace: string;
  readonly declaredCapabilities: ReadonlyArray<string>;
  registerTool(
    name: string,
    def: { description: string; inputSchema?: Record<string, any> | undefined },
    handler: (args: unknown) => Promise<ToolResponse>,
  ): void;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResponse>;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

const json = (obj: unknown): ToolResponse => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});

const NOT_LOADED = {
  ok: false as const,
  error:
    "Tldraw not loaded — open the app first OR the surface is not exposed on this version of the app",
  code: "tldraw-not-loaded" as const,
};

const badArg = (which: string) => ({
  ok: false as const,
  error: `bad-arg: missing or invalid \`${which}\``,
  code: "bad-arg" as const,
});

function parseEvalEnvelope(res: ToolResponse): { ok: boolean; value?: unknown; error?: string } {
  const first = res.content[0];
  if (!first || first.type !== "text") {
    return { ok: false, error: "eval_js returned no text content" };
  }
  try {
    return JSON.parse(first.text) as { ok: boolean; value?: unknown; error?: string };
  } catch (e) {
    return { ok: false, error: `eval_js envelope parse failure: ${(e as Error).message}` };
  }
}

async function runEval(
  api: PluginApi,
  expr: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const res = await api.callTool("eval_js", { expr });
  const env = parseEvalEnvelope(res);
  if (!env.ok) return { ok: false, error: env.error ?? "eval_js failed" };
  return { ok: true, value: env.value };
}

async function tldrawLoaded(api: PluginApi): Promise<boolean> {
  const r = await runEval(
    api,
    `(typeof window !== "undefined" && typeof window.editor !== "undefined" && window.editor !== null)`,
  );
  return r.ok && r.value === true;
}

export const handlers = {
  /** `tldraw.get_selected_shapes()` → `{ok, shapes:[{id,type,x,y,props}]}`. */
  async get_selected_shapes(api: PluginApi, _args: unknown): Promise<ToolResponse> {
    if (!(await tldrawLoaded(api))) return json(NOT_LOADED);
    const expr = `(() => {
      const e = window.editor;
      const shapes = (e.getSelectedShapes ? e.getSelectedShapes() : []) || [];
      return {
        shapes: shapes.map(s => ({
          id: s.id,
          type: s.type,
          x: s.x,
          y: s.y,
          props: s.props || {},
        })),
      };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, ...(r.value as Record<string, unknown>) });
  },

  /** `tldraw.get_viewport()` → `{ok, x, y, w, h, zoom}`. */
  async get_viewport(api: PluginApi, _args: unknown): Promise<ToolResponse> {
    if (!(await tldrawLoaded(api))) return json(NOT_LOADED);
    const expr = `(() => {
      const e = window.editor;
      const b = e.getViewportPageBounds ? e.getViewportPageBounds() : { x: 0, y: 0, w: 0, h: 0 };
      const z = e.getZoomLevel ? e.getZoomLevel() : 1;
      return { x: b.x, y: b.y, w: b.w, h: b.h, zoom: z };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, ...(r.value as Record<string, unknown>) });
  },

  /** `tldraw.create_shape({type, x, y, props?})` → `{ok, shapeId}`. */
  async create_shape(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { type?: unknown; x?: unknown; y?: unknown; props?: unknown };
    if (typeof a.type !== "string" || a.type.length === 0) return json(badArg("type"));
    if (typeof a.x !== "number") return json(badArg("x"));
    if (typeof a.y !== "number") return json(badArg("y"));
    if (a.props !== undefined && (typeof a.props !== "object" || a.props === null)) {
      return json(badArg("props"));
    }
    if (!(await tldrawLoaded(api))) return json(NOT_LOADED);
    const shape = {
      type: a.type,
      x: a.x,
      y: a.y,
      props: a.props ?? {},
    };
    const shapeJson = JSON.stringify(shape);
    const expr = `(() => {
      const e = window.editor;
      const shape = ${shapeJson};
      const before = new Set((e.getCurrentPageShapes ? e.getCurrentPageShapes() : []).map(s => s.id));
      e.createShapes([shape]);
      const after = (e.getCurrentPageShapes ? e.getCurrentPageShapes() : []);
      const created = after.find(s => !before.has(s.id));
      return { shapeId: created ? created.id : null };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    const v = r.value as { shapeId: string | null };
    if (!v.shapeId)
      return json({
        ok: false,
        error: "tldraw create_shape did not produce a new shape id",
        code: "create-failed",
      });
    return json({ ok: true, shapeId: v.shapeId });
  },

  /** `tldraw.delete_shape({shapeId})` — `editor.deleteShapes([shapeId])`. */
  async delete_shape(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { shapeId?: unknown };
    if (typeof a.shapeId !== "string" || a.shapeId.length === 0) return json(badArg("shapeId"));
    if (!(await tldrawLoaded(api))) return json(NOT_LOADED);
    const id = JSON.stringify(a.shapeId);
    const expr = `(() => {
      const e = window.editor;
      e.deleteShapes([${id}]);
      return { deleted: ${id} };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, shapeId: a.shapeId });
  },

  /** `tldraw.select_shapes({shapeIds})` — `editor.setSelectedShapes(shapeIds)`. */
  async select_shapes(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { shapeIds?: unknown };
    if (!Array.isArray(a.shapeIds) || a.shapeIds.some((id) => typeof id !== "string")) {
      return json(badArg("shapeIds"));
    }
    if (!(await tldrawLoaded(api))) return json(NOT_LOADED);
    const ids = JSON.stringify(a.shapeIds);
    const expr = `(() => {
      const e = window.editor;
      e.setSelectedShapes(${ids});
      return { selected: ${ids} };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, shapeIds: a.shapeIds });
  },
};

export function register(api: PluginApi): void {
  api.log.info("tldraw plugin: registering tools", { namespace: api.namespace });

  api.registerTool(
    `${api.namespace}.get_selected_shapes`,
    {
      description:
        "Read `editor.getSelectedShapes()` — returns `{ok, shapes:[{id,type,x,y,props}]}`. App-not-loaded surfaces `code:'tldraw-not-loaded'`.",
      inputSchema: {},
    },
    (args) => handlers.get_selected_shapes(api, args),
  );

  api.registerTool(
    `${api.namespace}.get_viewport`,
    {
      description:
        "Read `editor.getViewportPageBounds()` + `editor.getZoomLevel()` — returns `{ok, x, y, w, h, zoom}`. App-not-loaded surfaces `code:'tldraw-not-loaded'`.",
      inputSchema: {},
    },
    (args) => handlers.get_viewport(api, args),
  );

  api.registerTool(
    `${api.namespace}.create_shape`,
    {
      description:
        "Create a shape via `editor.createShapes([{type, x, y, props}])`. Returns `{ok, shapeId}` (resolved by diffing the page shape list before/after). Bad-arg / app-not-loaded / create-failed surface structured errors.",
      inputSchema: {},
    },
    (args) => handlers.create_shape(api, args),
  );

  api.registerTool(
    `${api.namespace}.delete_shape`,
    {
      description:
        "Delete one shape via `editor.deleteShapes([shapeId])`. Returns `{ok, shapeId}` on success.",
      inputSchema: {},
    },
    (args) => handlers.delete_shape(api, args),
  );

  api.registerTool(
    `${api.namespace}.select_shapes`,
    {
      description:
        "Set the active selection via `editor.setSelectedShapes(shapeIds)`. Returns `{ok, shapeIds}`.",
      inputSchema: {},
    },
    (args) => handlers.select_shapes(api, args),
  );
}

export default register;
