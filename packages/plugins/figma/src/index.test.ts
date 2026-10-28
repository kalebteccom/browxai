// Unit-test the figma plugin handlers against a mocked `api.callTool`.
// No real Figma page is needed — the eval_js round-trip is mocked.

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
    namespace: "figma",
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
function loadedApi(page: unknown, seen: string[] = []) {
  return makeApi(async (name, args) => {
    expect(name).toBe("eval_js");
    const expr = (args as { expr: string }).expr;
    if (expr.includes("typeof figma")) return evalEnvelope(true);
    seen.push(expr);
    return evalEnvelope(page);
  });
}

const node = { id: "1:2", name: "Rect", type: "RECTANGLE", x: 10, y: 20, width: 100, height: 50 };

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

describe("@browxai/plugin-figma handlers", () => {
  it.each<HappyRow>([
    {
      label: "get_selection returns the parsed selection",
      tool: "get_selection",
      args: {},
      page: { nodes: [node] },
      expected: { ok: true, nodes: [node] },
    },
    {
      label: "get_viewport returns center and zoom",
      tool: "get_viewport",
      args: {},
      page: { center: { x: 100, y: 200 }, zoom: 1.5 },
      expected: { ok: true, center: { x: 100, y: 200 }, zoom: 1.5 },
    },
    {
      label: "select_node returns ok and nodeId",
      tool: "select_node",
      args: { nodeId: "1:2" },
      page: { found: true, nodeId: "1:2" },
      expected: { ok: true, nodeId: "1:2" },
    },
    {
      label: "move_node returns the post-move position",
      tool: "move_node",
      args: { nodeId: "1:2", dx: 10, dy: 20 },
      page: { found: true, nodeId: "1:2", x: 110, y: 220 },
      expected: { ok: true, nodeId: "1:2", x: 110, y: 220 },
    },
  ])("$label", async (row) => {
    const res = await handlers[row.tool](loadedApi(row.page), row.args);
    expect(parseFirst(res)).toEqual(row.expected);
  });

  it("create_rectangle returns nodeId and sends a fill for fillColor", async () => {
    const seen: string[] = [];
    const res = await handlers.create_rectangle(loadedApi({ nodeId: "1:99" }, seen), {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      fillColor: { r: 1, g: 0.5, b: 0 },
    });
    expect(parseFirst(res)).toEqual({ ok: true, nodeId: "1:99" });
    expect(seen.at(-1)).toContain("rect.fills");
    expect(seen.at(-1)).toContain("createRectangle");
  });

  it.each<ErrorRow>([
    {
      label: "get_selection returns figma-not-loaded when the global is undefined",
      tool: "get_selection",
      args: {},
      loaded: false,
      code: "figma-not-loaded",
    },
    {
      label: "select_node returns bad-arg when nodeId is missing",
      tool: "select_node",
      args: {},
      loaded: true,
      code: "bad-arg",
    },
    {
      label: "select_node returns node-not-found when getNodeById returns null",
      tool: "select_node",
      args: { nodeId: "missing" },
      loaded: true,
      page: { found: false },
      code: "node-not-found",
    },
    {
      label: "move_node returns bad-arg when dx is missing",
      tool: "move_node",
      args: { nodeId: "1:2", dy: 0 },
      loaded: true,
      code: "bad-arg",
    },
    {
      label: "create_rectangle returns bad-arg when width is zero",
      tool: "create_rectangle",
      args: { x: 0, y: 0, width: 0, height: 50 },
      loaded: true,
      code: "bad-arg",
    },
  ])("$label", async (row) => {
    const api = row.loaded ? loadedApi(row.page ?? true) : makeApi(async () => evalEnvelope(false));
    const res = await handlers[row.tool](api, row.args);
    const parsed = parseFirst(res);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe(row.code);
  });
});

describe("@browxai/plugin-figma register()", () => {
  it("registers exactly 5 namespaced tools", () => {
    const registered: string[] = [];
    const fakeApi = {
      namespace: "figma",
      declaredCapabilities: ["eval", "canvas"],
      registerTool: (name: string) => {
        registered.push(name);
      },
      callTool: async () => ({ content: [] }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    register(fakeApi);
    expect(registered.sort()).toEqual([
      "figma.create_rectangle",
      "figma.get_selection",
      "figma.get_viewport",
      "figma.move_node",
      "figma.select_node",
    ]);
  });
});
