// Unit-test the tldraw plugin handlers against a mocked `api.callTool`.

import { describe, it, expect } from "vitest";
import { handlers, register } from "./index.js";

type CallToolFn = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{
  content: ReadonlyArray<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
}>;

function evalEnvelope(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, value }) }] };
}

function makeApi(callTool: CallToolFn) {
  return {
    namespace: "tldraw",
    declaredCapabilities: ["eval", "canvas"],
    registerTool: () => undefined,
    callTool,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as never;
}

function parseFirst(res: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text!) as Record<string, unknown>;
}

// A loaded page answers the typeof probe with true and everything else with `page`.
function loadedApi(page: unknown) {
  return makeApi(async (_name, args) => {
    const expr = (args as { expr: string }).expr;
    if (expr.includes("typeof window.editor")) return evalEnvelope(true);
    return evalEnvelope(page);
  });
}

interface HappyRow {
  label: string;
  tool: keyof typeof handlers;
  args: Record<string, unknown>;
  page: unknown;
  expected: Record<string, unknown>;
}

interface ErrorRow {
  label: string;
  tool: keyof typeof handlers;
  args: Record<string, unknown>;
  loaded: boolean;
  page?: unknown;
  code: string;
}

const shape = { id: "shape:1", type: "geo", x: 10, y: 20, props: { w: 100, h: 50 } };

describe("@browxai/plugin-tldraw handlers", () => {
  it.each<HappyRow>([
    {
      label: "get_selected_shapes returns the parsed shapes",
      tool: "get_selected_shapes",
      args: {},
      page: { shapes: [shape] },
      expected: { ok: true, shapes: [shape] },
    },
    {
      label: "get_viewport returns bounds and zoom",
      tool: "get_viewport",
      args: {},
      page: { x: 0, y: 0, w: 1024, h: 768, zoom: 1.25 },
      expected: { ok: true, x: 0, y: 0, w: 1024, h: 768, zoom: 1.25 },
    },
    {
      label: "create_shape returns shapeId",
      tool: "create_shape",
      args: { type: "geo", x: 0, y: 0, props: { w: 10 } },
      page: { shapeId: "shape:99" },
      expected: { ok: true, shapeId: "shape:99" },
    },
    {
      label: "delete_shape returns ok and shapeId",
      tool: "delete_shape",
      args: { shapeId: "shape:1" },
      page: { deleted: "shape:1" },
      expected: { ok: true, shapeId: "shape:1" },
    },
    {
      label: "select_shapes returns ok and shapeIds",
      tool: "select_shapes",
      args: { shapeIds: ["shape:1", "shape:2"] },
      page: { selected: ["shape:1", "shape:2"] },
      expected: { ok: true, shapeIds: ["shape:1", "shape:2"] },
    },
  ])("$label", async (row) => {
    const res = await handlers[row.tool](loadedApi(row.page), row.args);
    expect(parseFirst(res)).toEqual(row.expected);
  });

  it.each<ErrorRow>([
    {
      label: "get_selected_shapes returns tldraw-not-loaded when the editor is undefined",
      tool: "get_selected_shapes",
      args: {},
      loaded: false,
      code: "tldraw-not-loaded",
    },
    {
      label: "create_shape returns bad-arg when type is missing",
      tool: "create_shape",
      args: { x: 0, y: 0 },
      loaded: true,
      code: "bad-arg",
    },
    {
      label: "create_shape returns create-failed when no new shape id is detected",
      tool: "create_shape",
      args: { type: "geo", x: 0, y: 0 },
      loaded: true,
      page: { shapeId: null },
      code: "create-failed",
    },
    {
      label: "delete_shape returns bad-arg when shapeId is missing",
      tool: "delete_shape",
      args: {},
      loaded: true,
      code: "bad-arg",
    },
    {
      label: "select_shapes returns bad-arg when shapeIds contains a non-string",
      tool: "select_shapes",
      args: { shapeIds: ["shape:1", 99] },
      loaded: true,
      code: "bad-arg",
    },
  ])("$label", async (row) => {
    const api = row.loaded ? loadedApi(row.page ?? true) : makeApi(async () => evalEnvelope(false));
    const parsed = parseFirst(await handlers[row.tool](api, row.args));
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(row.code);
  });
});

describe("@browxai/plugin-tldraw register()", () => {
  it("registers exactly 5 namespaced tools", () => {
    const registered: string[] = [];
    const fakeApi = {
      namespace: "tldraw",
      declaredCapabilities: ["eval", "canvas"],
      registerTool: (name: string) => {
        registered.push(name);
      },
      callTool: async () => ({ content: [] }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    register(fakeApi);
    expect(registered.sort()).toEqual([
      "tldraw.create_shape",
      "tldraw.delete_shape",
      "tldraw.get_selected_shapes",
      "tldraw.get_viewport",
      "tldraw.select_shapes",
    ]);
  });
});
