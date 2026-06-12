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

describe("@browxai/plugin-tldraw handlers", () => {
  describe("get_selected_shapes", () => {
    it("returns parsed shapes on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.editor")) return evalEnvelope(true);
        return evalEnvelope({
          shapes: [{ id: "shape:1", type: "geo", x: 10, y: 20, props: { w: 100, h: 50 } }],
        });
      });
      const res = await handlers.get_selected_shapes(api, {});
      expect(parseFirst(res)).toEqual({
        ok: true,
        shapes: [{ id: "shape:1", type: "geo", x: 10, y: 20, props: { w: 100, h: 50 } }],
      });
    });

    it("returns tldraw-not-loaded when editor is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.get_selected_shapes(api, {});
      expect(parseFirst(res).code).toBe("tldraw-not-loaded");
    });
  });

  describe("get_viewport", () => {
    it("returns viewport bounds + zoom on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.editor")) return evalEnvelope(true);
        return evalEnvelope({ x: 0, y: 0, w: 1024, h: 768, zoom: 1.25 });
      });
      const res = await handlers.get_viewport(api, {});
      expect(parseFirst(res)).toEqual({ ok: true, x: 0, y: 0, w: 1024, h: 768, zoom: 1.25 });
    });

    it("returns tldraw-not-loaded when editor is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.get_viewport(api, {});
      expect(parseFirst(res).code).toBe("tldraw-not-loaded");
    });
  });

  describe("create_shape", () => {
    it("returns shapeId on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.editor")) return evalEnvelope(true);
        return evalEnvelope({ shapeId: "shape:99" });
      });
      const res = await handlers.create_shape(api, { type: "geo", x: 0, y: 0, props: { w: 10 } });
      expect(parseFirst(res)).toEqual({ ok: true, shapeId: "shape:99" });
    });

    it("returns bad-arg when type missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.create_shape(api, { x: 0, y: 0 });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns create-failed when no new shape id detected", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.editor")) return evalEnvelope(true);
        return evalEnvelope({ shapeId: null });
      });
      const res = await handlers.create_shape(api, { type: "geo", x: 0, y: 0 });
      expect(parseFirst(res).code).toBe("create-failed");
    });

    it("returns tldraw-not-loaded when editor is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.create_shape(api, { type: "geo", x: 0, y: 0 });
      expect(parseFirst(res).code).toBe("tldraw-not-loaded");
    });
  });

  describe("delete_shape", () => {
    it("returns ok + shapeId on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.editor")) return evalEnvelope(true);
        return evalEnvelope({ deleted: "shape:1" });
      });
      const res = await handlers.delete_shape(api, { shapeId: "shape:1" });
      expect(parseFirst(res)).toEqual({ ok: true, shapeId: "shape:1" });
    });

    it("returns bad-arg when shapeId missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.delete_shape(api, {});
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns tldraw-not-loaded when editor is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.delete_shape(api, { shapeId: "shape:1" });
      expect(parseFirst(res).code).toBe("tldraw-not-loaded");
    });
  });

  describe("select_shapes", () => {
    it("returns ok + shapeIds on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.editor")) return evalEnvelope(true);
        return evalEnvelope({ selected: ["shape:1", "shape:2"] });
      });
      const res = await handlers.select_shapes(api, { shapeIds: ["shape:1", "shape:2"] });
      expect(parseFirst(res)).toEqual({ ok: true, shapeIds: ["shape:1", "shape:2"] });
    });

    it("returns bad-arg when shapeIds not an array", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.select_shapes(api, { shapeIds: "shape:1" });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns bad-arg when shapeIds contains non-string", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.select_shapes(api, { shapeIds: ["shape:1", 99] });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns tldraw-not-loaded when editor is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.select_shapes(api, { shapeIds: ["shape:1"] });
      expect(parseFirst(res).code).toBe("tldraw-not-loaded");
    });
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
