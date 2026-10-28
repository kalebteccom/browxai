// Unit-test the excalidraw plugin handlers against a mocked `api.callTool`.

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
    namespace: "excalidraw",
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
    if (expr.includes("typeof window.excalidrawAPI")) return evalEnvelope(true);
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

const element = { id: "el1", type: "rectangle", x: 0, y: 0, width: 100, height: 50 };
const appState = { viewBackgroundColor: "#fff", viewModeEnabled: false, zoom: { value: 1 } };

describe("@browxai/plugin-excalidraw handlers", () => {
  it.each<HappyRow>([
    {
      label: "get_scene_state returns the parsed scene state",
      tool: "get_scene_state",
      args: {},
      page: { elements: [element], appState },
      expected: { ok: true, elements: [element], appState },
    },
    {
      label: "get_viewport returns scroll and zoom",
      tool: "get_viewport",
      args: {},
      page: { scrollX: 100, scrollY: 200, zoom: 2 },
      expected: { ok: true, scrollX: 100, scrollY: 200, zoom: 2 },
    },
    {
      label: "add_element returns elementId",
      tool: "add_element",
      args: { type: "rectangle", x: 0, y: 0, width: 100, height: 50 },
      page: { elementId: "abc-123" },
      expected: { ok: true, elementId: "abc-123" },
    },
    {
      label: "delete_element returns ok and elementId",
      tool: "delete_element",
      args: { elementId: "el1" },
      page: { removed: 1 },
      expected: { ok: true, elementId: "el1" },
    },
    {
      label: "set_scroll returns the new scroll position",
      tool: "set_scroll",
      args: { scrollX: 50, scrollY: 75 },
      page: { scrollX: 50, scrollY: 75 },
      expected: { ok: true, scrollX: 50, scrollY: 75 },
    },
  ])("$label", async (row) => {
    const res = await handlers[row.tool](loadedApi(row.page), row.args);
    expect(parseFirst(res)).toEqual(row.expected);
  });

  it.each<ErrorRow>([
    {
      label: "get_scene_state returns excalidraw-not-loaded when excalidrawAPI is undefined",
      tool: "get_scene_state",
      args: {},
      loaded: false,
      code: "excalidraw-not-loaded",
    },
    {
      label: "add_element returns bad-arg when type is missing",
      tool: "add_element",
      args: { x: 0, y: 0, width: 100, height: 50 },
      loaded: true,
      code: "bad-arg",
    },
    {
      label: "delete_element returns element-not-found when the element is absent",
      tool: "delete_element",
      args: { elementId: "missing" },
      loaded: true,
      page: { removed: 0 },
      code: "element-not-found",
    },
    {
      label: "delete_element returns bad-arg when elementId is missing",
      tool: "delete_element",
      args: {},
      loaded: true,
      code: "bad-arg",
    },
    {
      label: "set_scroll returns bad-arg when scrollY is missing",
      tool: "set_scroll",
      args: { scrollX: 50 },
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

describe("@browxai/plugin-excalidraw register()", () => {
  it("registers exactly 5 namespaced tools", () => {
    const registered: string[] = [];
    const fakeApi = {
      namespace: "excalidraw",
      declaredCapabilities: ["eval", "canvas"],
      registerTool: (name: string) => {
        registered.push(name);
      },
      callTool: async () => ({ content: [] }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    register(fakeApi);
    expect(registered.sort()).toEqual([
      "excalidraw.add_element",
      "excalidraw.delete_element",
      "excalidraw.get_scene_state",
      "excalidraw.get_viewport",
      "excalidraw.set_scroll",
    ]);
  });
});
