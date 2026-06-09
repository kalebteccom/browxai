// @kalebtec/browxai-plugin-excalidraw — Excalidraw canvas-app adapter.
//
// Surfaces five small, useful tools over the `window.excalidrawAPI`
// global that the host page sets when embedding the Excalidraw
// component (the Excalidraw React component takes an `excalidrawAPI`
// ref callback; community deployments typically forward it to
// `window.excalidrawAPI`). Each tool routes through `eval_js`.
//
// Targeted API surface (Excalidraw 0.17+, current as of 2026-06):
//   - excalidrawAPI.getSceneElements()  → Element[]
//   - excalidrawAPI.getAppState()       → { viewBackgroundColor, viewModeEnabled, zoom, scrollX, scrollY, ... }
//   - excalidrawAPI.updateScene({elements?, appState?})
//
// When `window.excalidrawAPI` is undefined (Excalidraw not mounted, or
// the host page didn't expose the ref), every tool returns the
// structured `code:"excalidraw-not-loaded"` envelope.

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
    "Excalidraw not loaded — open the app first OR the surface is not exposed on this version of the app",
  code: "excalidraw-not-loaded" as const,
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

async function excalidrawLoaded(api: PluginApi): Promise<boolean> {
  const r = await runEval(
    api,
    `(typeof window !== "undefined" && typeof window.excalidrawAPI !== "undefined" && window.excalidrawAPI !== null)`,
  );
  return r.ok && r.value === true;
}

export const handlers = {
  /** `excalidraw.get_scene_state()` → `{ok, elements:[...], appState:{...}}`. */
  async get_scene_state(api: PluginApi, _args: unknown): Promise<ToolResponse> {
    if (!(await excalidrawLoaded(api))) return json(NOT_LOADED);
    const expr = `(() => {
      const a = window.excalidrawAPI;
      const els = (a.getSceneElements ? a.getSceneElements() : []) || [];
      const st = (a.getAppState ? a.getAppState() : {}) || {};
      return {
        elements: els.map(e => ({
          id: e.id,
          type: e.type,
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
        })),
        appState: {
          viewBackgroundColor: st.viewBackgroundColor,
          viewModeEnabled: !!st.viewModeEnabled,
          zoom: st.zoom,
        },
      };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, ...(r.value as Record<string, unknown>) });
  },

  /** `excalidraw.get_viewport()` → `{ok, scrollX, scrollY, zoom}`. */
  async get_viewport(api: PluginApi, _args: unknown): Promise<ToolResponse> {
    if (!(await excalidrawLoaded(api))) return json(NOT_LOADED);
    const expr = `(() => {
      const a = window.excalidrawAPI;
      const st = (a.getAppState ? a.getAppState() : {}) || {};
      const zoomVal = st.zoom && typeof st.zoom === "object" ? st.zoom.value : st.zoom;
      return { scrollX: st.scrollX || 0, scrollY: st.scrollY || 0, zoom: zoomVal || 1 };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, ...(r.value as Record<string, unknown>) });
  },

  /** `excalidraw.add_element({type, x, y, width, height, ...})` — append via updateScene. */
  async add_element(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as Record<string, unknown>;
    if (typeof a.type !== "string" || a.type.length === 0) return json(badArg("type"));
    if (typeof a.x !== "number") return json(badArg("x"));
    if (typeof a.y !== "number") return json(badArg("y"));
    if (typeof a.width !== "number") return json(badArg("width"));
    if (typeof a.height !== "number") return json(badArg("height"));
    if (!(await excalidrawLoaded(api))) return json(NOT_LOADED);
    const elementJson = JSON.stringify(a);
    const expr = `(() => {
      const apiRef = window.excalidrawAPI;
      const before = (apiRef.getSceneElements ? apiRef.getSceneElements() : []) || [];
      const seed = ${elementJson};
      // Excalidraw needs every element to carry a stable id; mint one
      // if the caller didn't supply it. The crypto.randomUUID() path
      // matches what Excalidraw itself does on internal creation.
      const id = seed.id || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "el-" + Date.now() + "-" + Math.random().toString(36).slice(2));
      const newEl = Object.assign({}, seed, { id });
      apiRef.updateScene({ elements: before.concat([newEl]) });
      return { elementId: id };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    const v = r.value as { elementId: string };
    return json({ ok: true, elementId: v.elementId });
  },

  /** `excalidraw.delete_element({elementId})` — updateScene without that element. */
  async delete_element(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { elementId?: unknown };
    if (typeof a.elementId !== "string" || a.elementId.length === 0)
      return json(badArg("elementId"));
    if (!(await excalidrawLoaded(api))) return json(NOT_LOADED);
    const id = JSON.stringify(a.elementId);
    const expr = `(() => {
      const apiRef = window.excalidrawAPI;
      const before = (apiRef.getSceneElements ? apiRef.getSceneElements() : []) || [];
      const after = before.filter(e => e.id !== ${id});
      apiRef.updateScene({ elements: after });
      return { removed: before.length - after.length };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    const v = r.value as { removed: number };
    if (v.removed === 0)
      return json({
        ok: false,
        error: `element not found: ${a.elementId}`,
        code: "element-not-found",
      });
    return json({ ok: true, elementId: a.elementId });
  },

  /** `excalidraw.set_scroll({scrollX, scrollY})` — updateScene with appState. */
  async set_scroll(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { scrollX?: unknown; scrollY?: unknown };
    if (typeof a.scrollX !== "number") return json(badArg("scrollX"));
    if (typeof a.scrollY !== "number") return json(badArg("scrollY"));
    if (!(await excalidrawLoaded(api))) return json(NOT_LOADED);
    const expr = `(() => {
      const apiRef = window.excalidrawAPI;
      const cur = (apiRef.getAppState ? apiRef.getAppState() : {}) || {};
      apiRef.updateScene({ appState: Object.assign({}, cur, { scrollX: ${a.scrollX}, scrollY: ${a.scrollY} }) });
      return { scrollX: ${a.scrollX}, scrollY: ${a.scrollY} };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, scrollX: a.scrollX, scrollY: a.scrollY });
  },
};

export function register(api: PluginApi): void {
  api.log.info("excalidraw plugin: registering tools", { namespace: api.namespace });

  api.registerTool(
    `${api.namespace}.get_scene_state`,
    {
      description:
        "Read `excalidrawAPI.getSceneElements()` + `excalidrawAPI.getAppState()` — returns `{ok, elements:[{id,type,x,y,width,height}], appState:{viewBackgroundColor, viewModeEnabled, zoom}}`. App-not-loaded surfaces `code:'excalidraw-not-loaded'`.",
      inputSchema: {},
    },
    (args) => handlers.get_scene_state(api, args),
  );

  api.registerTool(
    `${api.namespace}.get_viewport`,
    {
      description:
        "Derive viewport from `appState.scrollX/scrollY/zoom` — returns `{ok, scrollX, scrollY, zoom}`. App-not-loaded surfaces `code:'excalidraw-not-loaded'`.",
      inputSchema: {},
    },
    (args) => handlers.get_viewport(api, args),
  );

  api.registerTool(
    `${api.namespace}.add_element`,
    {
      description:
        "Append a scene element via `excalidrawAPI.updateScene({elements: [...existing, new]})`. Required: `type, x, y, width, height`; any extra fields are passed through to Excalidraw. Returns `{ok, elementId}` — id minted via `crypto.randomUUID()` if not supplied. App-not-loaded / bad-arg surface structured errors.",
      inputSchema: {},
    },
    (args) => handlers.add_element(api, args),
  );

  api.registerTool(
    `${api.namespace}.delete_element`,
    {
      description:
        "Remove the element with `elementId` from the scene via `excalidrawAPI.updateScene`. Returns `{ok, elementId}` on success, `{code:'element-not-found'}` if the id isn't present.",
      inputSchema: {},
    },
    (args) => handlers.delete_element(api, args),
  );

  api.registerTool(
    `${api.namespace}.set_scroll`,
    {
      description:
        "Set `appState.scrollX/scrollY` via `excalidrawAPI.updateScene`. Returns `{ok, scrollX, scrollY}`.",
      inputSchema: {},
    },
    (args) => handlers.set_scroll(api, args),
  );
}

export default register;
