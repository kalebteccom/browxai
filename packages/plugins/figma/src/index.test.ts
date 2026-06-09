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

function evalError(error: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error }) }] };
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

describe("@kalebtec/browxai-plugin-figma handlers", () => {
  describe("get_selection", () => {
    it("returns parsed selection on happy path", async () => {
      const api = makeApi(async (name, args) => {
        expect(name).toBe("eval_js");
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof figma")) return evalEnvelope(true);
        return evalEnvelope({
          nodes: [
            { id: "1:2", name: "Rect", type: "RECTANGLE", x: 10, y: 20, width: 100, height: 50 },
          ],
        });
      });
      const res = await handlers.get_selection(api, {});
      expect(parseFirst(res)).toEqual({
        ok: true,
        nodes: [
          { id: "1:2", name: "Rect", type: "RECTANGLE", x: 10, y: 20, width: 100, height: 50 },
        ],
      });
    });

    it("returns figma-not-loaded when global is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.get_selection(api, {});
      const parsed = parseFirst(res);
      expect(parsed.ok).toBe(false);
      expect(parsed.code).toBe("figma-not-loaded");
    });
  });

  describe("get_viewport", () => {
    it("returns center + zoom on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof figma")) return evalEnvelope(true);
        return evalEnvelope({ center: { x: 100, y: 200 }, zoom: 1.5 });
      });
      const res = await handlers.get_viewport(api, {});
      expect(parseFirst(res)).toEqual({ ok: true, center: { x: 100, y: 200 }, zoom: 1.5 });
    });

    it("returns figma-not-loaded when global is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.get_viewport(api, {});
      expect(parseFirst(res).code).toBe("figma-not-loaded");
    });
  });

  describe("select_node", () => {
    it("returns ok + nodeId on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof figma")) return evalEnvelope(true);
        return evalEnvelope({ found: true, nodeId: "1:2" });
      });
      const res = await handlers.select_node(api, { nodeId: "1:2" });
      expect(parseFirst(res)).toEqual({ ok: true, nodeId: "1:2" });
    });

    it("returns bad-arg when nodeId missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.select_node(api, {});
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns node-not-found when page-side getNodeById returns null", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof figma")) return evalEnvelope(true);
        return evalEnvelope({ found: false });
      });
      const res = await handlers.select_node(api, { nodeId: "missing" });
      expect(parseFirst(res).code).toBe("node-not-found");
    });

    it("returns figma-not-loaded when global is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.select_node(api, { nodeId: "1:2" });
      expect(parseFirst(res).code).toBe("figma-not-loaded");
    });
  });

  describe("move_node", () => {
    it("returns post-move position on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof figma")) return evalEnvelope(true);
        return evalEnvelope({ found: true, nodeId: "1:2", x: 110, y: 220 });
      });
      const res = await handlers.move_node(api, { nodeId: "1:2", dx: 10, dy: 20 });
      expect(parseFirst(res)).toEqual({ ok: true, nodeId: "1:2", x: 110, y: 220 });
    });

    it("returns bad-arg when dx missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.move_node(api, { nodeId: "1:2", dy: 0 });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns bad-arg when nodeId missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.move_node(api, { dx: 1, dy: 1 });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns figma-not-loaded when global is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.move_node(api, { nodeId: "1:2", dx: 0, dy: 0 });
      expect(parseFirst(res).code).toBe("figma-not-loaded");
    });
  });

  describe("create_rectangle", () => {
    it("returns nodeId on happy path with fillColor", async () => {
      let lastExpr = "";
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof figma")) return evalEnvelope(true);
        lastExpr = expr;
        return evalEnvelope({ nodeId: "1:99" });
      });
      const res = await handlers.create_rectangle(api, {
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        fillColor: { r: 1, g: 0.5, b: 0 },
      });
      expect(parseFirst(res)).toEqual({ ok: true, nodeId: "1:99" });
      expect(lastExpr).toContain("rect.fills");
      expect(lastExpr).toContain("createRectangle");
    });

    it("returns bad-arg when width is zero", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.create_rectangle(api, { x: 0, y: 0, width: 0, height: 50 });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns figma-not-loaded when global is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.create_rectangle(api, { x: 0, y: 0, width: 10, height: 10 });
      expect(parseFirst(res).code).toBe("figma-not-loaded");
    });
  });
});

describe("@kalebtec/browxai-plugin-figma register()", () => {
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
    register(fakeApi as never);
    expect(registered.sort()).toEqual([
      "figma.create_rectangle",
      "figma.get_selection",
      "figma.get_viewport",
      "figma.move_node",
      "figma.select_node",
    ]);
  });
});
