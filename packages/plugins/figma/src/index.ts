// @browxai/plugin-figma — Figma canvas-app adapter.
//
// Surfaces a small, useful first-party tool surface (selection, viewport,
// node mutate, rectangle create) over the page-side `figma.*` global that
// Figma exposes in its plugin-iframe context (and, for agent-driven
// sessions, reachable through `eval_js` when the file is open in the
// editor with the plugin context loaded).
//
// Design contract:
//   - All five tools route through `api.callTool("eval_js", {expr})`.
//   - The plugin declares the `eval` + `canvas` capabilities at the
//     manifest level — the host gates the whole plugin against those.
//   - Handlers are resilient to the app not being loaded: a guard
//     `typeof figma === "undefined"` returns the structured
//     `figma-not-loaded` error.
//   - The canonical canvas-app adapter pattern — keep `register(api)`
//     small, push the heavy lifting into the eval-expression strings,
//     parse the result back in the plugin.
//
// Targeted API surface (as of 2026-06): figma.viewport.{center,zoom},
// figma.currentPage.selection, figma.createRectangle(),
// figma.getNodeById(). These are the stable parts of Figma's plugin API
// and have been present for years; later versions may add fields but
// shouldn't break this set.

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
    "Figma not loaded — open the app first OR the surface is not exposed on this version of the app",
  code: "figma-not-loaded" as const,
};

const badArg = (which: string) => ({
  ok: false as const,
  error: `bad-arg: missing or invalid \`${which}\``,
  code: "bad-arg" as const,
});

/** Parse the first text item of an eval_js MCP envelope as JSON. */
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

/**
 * Run an eval_js expression and unwrap its envelope to the page-side value.
 *
 * Returns `{ok:true, value}` on a successful page-side eval, or a structured
 * error envelope (passed straight through to the caller) otherwise.
 */
async function runEval(
  api: PluginApi,
  expr: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; code?: string }> {
  const res = await api.callTool("eval_js", { expr });
  const env = parseEvalEnvelope(res);
  if (!env.ok) return { ok: false, error: env.error ?? "eval_js failed" };
  return { ok: true, value: env.value };
}

/**
 * Probe `typeof figma` in the page; if undefined, the editor isn't
 * loaded (or the surface isn't exposed for this build) and the caller
 * should return the canonical `figma-not-loaded` envelope.
 */
async function figmaLoaded(api: PluginApi): Promise<boolean> {
  const r = await runEval(api, `(typeof figma !== "undefined")`);
  return r.ok && r.value === true;
}

export const handlers = {
  /** `figma.get_selection()` → `{ok, nodes:[{id,name,type,x,y,width,height}]}`. */
  async get_selection(api: PluginApi, _args: unknown): Promise<ToolResponse> {
    if (!(await figmaLoaded(api))) return json(NOT_LOADED);
    const expr = `(() => {
      const sel = figma.currentPage.selection || [];
      return {
        nodes: sel.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          x: n.x,
          y: n.y,
          width: n.width,
          height: n.height,
        })),
      };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, ...(r.value as Record<string, unknown>) });
  },

  /** `figma.get_viewport()` → `{ok, center:{x,y}, zoom}`. */
  async get_viewport(api: PluginApi, _args: unknown): Promise<ToolResponse> {
    if (!(await figmaLoaded(api))) return json(NOT_LOADED);
    const expr = `(() => {
      const v = figma.viewport;
      return { center: { x: v.center.x, y: v.center.y }, zoom: v.zoom };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    return json({ ok: true, ...(r.value as Record<string, unknown>) });
  },

  /** `figma.select_node({nodeId})` — sets `figma.currentPage.selection`. */
  async select_node(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { nodeId?: unknown };
    if (typeof a.nodeId !== "string" || a.nodeId.length === 0) return json(badArg("nodeId"));
    if (!(await figmaLoaded(api))) return json(NOT_LOADED);
    const id = JSON.stringify(a.nodeId);
    const expr = `(() => {
      const n = figma.getNodeById(${id});
      if (!n) return { found: false };
      figma.currentPage.selection = [n];
      return { found: true, nodeId: n.id };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    const v = r.value as { found: boolean; nodeId?: string };
    if (!v.found)
      return json({ ok: false, error: `node not found: ${a.nodeId}`, code: "node-not-found" });
    return json({ ok: true, nodeId: v.nodeId });
  },

  /** `figma.move_node({nodeId, dx, dy})` — mutates `node.x`/`node.y` in place. */
  async move_node(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { nodeId?: unknown; dx?: unknown; dy?: unknown };
    if (typeof a.nodeId !== "string" || a.nodeId.length === 0) return json(badArg("nodeId"));
    if (typeof a.dx !== "number") return json(badArg("dx"));
    if (typeof a.dy !== "number") return json(badArg("dy"));
    if (!(await figmaLoaded(api))) return json(NOT_LOADED);
    const id = JSON.stringify(a.nodeId);
    const expr = `(() => {
      const n = figma.getNodeById(${id});
      if (!n) return { found: false };
      n.x = n.x + (${a.dx});
      n.y = n.y + (${a.dy});
      return { found: true, nodeId: n.id, x: n.x, y: n.y };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    const v = r.value as { found: boolean; nodeId?: string; x?: number; y?: number };
    if (!v.found)
      return json({ ok: false, error: `node not found: ${a.nodeId}`, code: "node-not-found" });
    return json({ ok: true, nodeId: v.nodeId, x: v.x, y: v.y });
  },

  /** `figma.create_rectangle({x,y,width,height, fillColor?})` → `{ok, nodeId}`. */
  async create_rectangle(api: PluginApi, args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as {
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
      fillColor?: unknown;
    };
    if (typeof a.x !== "number") return json(badArg("x"));
    if (typeof a.y !== "number") return json(badArg("y"));
    if (typeof a.width !== "number" || a.width <= 0) return json(badArg("width"));
    if (typeof a.height !== "number" || a.height <= 0) return json(badArg("height"));
    const fill =
      a.fillColor && typeof a.fillColor === "object"
        ? (a.fillColor as { r?: number; g?: number; b?: number })
        : undefined;
    if (
      fill &&
      (typeof fill.r !== "number" || typeof fill.g !== "number" || typeof fill.b !== "number")
    ) {
      return json(badArg("fillColor"));
    }
    if (!(await figmaLoaded(api))) return json(NOT_LOADED);
    const fillExpr = fill
      ? `rect.fills = [{ type: "SOLID", color: { r: ${fill.r}, g: ${fill.g}, b: ${fill.b} } }];`
      : "";
    const expr = `(() => {
      const rect = figma.createRectangle();
      rect.x = ${a.x};
      rect.y = ${a.y};
      rect.resize(${a.width}, ${a.height});
      ${fillExpr}
      return { nodeId: rect.id };
    })()`;
    const r = await runEval(api, expr);
    if (!r.ok) return json({ ok: false, error: r.error, code: "eval-failed" });
    const v = r.value as { nodeId: string };
    return json({ ok: true, nodeId: v.nodeId });
  },
};

export function register(api: PluginApi): void {
  api.log.info("figma plugin: registering tools", { namespace: api.namespace });

  api.registerTool(
    `${api.namespace}.get_selection`,
    {
      description:
        "Read the current `figma.currentPage.selection` — returns `{ok, nodes:[{id,name,type,x,y,width,height}]}`. App-not-loaded surfaces `code:'figma-not-loaded'`.",
      inputSchema: {},
    },
    (args) => handlers.get_selection(api, args),
  );

  api.registerTool(
    `${api.namespace}.get_viewport`,
    {
      description:
        "Read `figma.viewport.center` + `figma.viewport.zoom` — returns `{ok, center:{x,y}, zoom}`. App-not-loaded surfaces `code:'figma-not-loaded'`.",
      inputSchema: {},
    },
    (args) => handlers.get_viewport(api, args),
  );

  api.registerTool(
    `${api.namespace}.select_node`,
    {
      description:
        "Set `figma.currentPage.selection` to the node addressed by `nodeId`. Returns `{ok, nodeId}` on success, `{ok:false, code:'node-not-found'|'bad-arg'|'figma-not-loaded'}` otherwise.",
      inputSchema: {},
    },
    (args) => handlers.select_node(api, args),
  );

  api.registerTool(
    `${api.namespace}.move_node`,
    {
      description:
        "Translate a node by `(dx, dy)` — mutates `node.x` and `node.y` in place. Returns `{ok, nodeId, x, y}` with the post-move position. App-not-loaded / missing-arg / unknown-id surface structured errors.",
      inputSchema: {},
    },
    (args) => handlers.move_node(api, args),
  );

  api.registerTool(
    `${api.namespace}.create_rectangle`,
    {
      description:
        "Create a rectangle via `figma.createRectangle()` at `(x, y)` with `(width, height)`. Optional `fillColor:{r,g,b}` (0–1 floats — Figma's color convention) sets a solid fill. Returns `{ok, nodeId}`.",
      inputSchema: {},
    },
    (args) => handlers.create_rectangle(api, args),
  );
}

export default register;
