// Unit-test the excalidraw plugin handlers against a mocked `api.callTool`.

import { describe, it, expect } from "vitest";
import { handlers, register } from "./index.js";

type CallToolFn = (name: string, args?: Record<string, unknown>) => Promise<{
  content: ReadonlyArray<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
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

function parseFirst(res: { content: ReadonlyArray<{ type: string; text?: string }> }): Record<string, unknown> {
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text!) as Record<string, unknown>;
}

describe("@kalebtec/browxai-plugin-excalidraw handlers", () => {
  describe("get_scene_state", () => {
    it("returns parsed scene state on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.excalidrawAPI")) return evalEnvelope(true);
        return evalEnvelope({
          elements: [{ id: "el1", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }],
          appState: { viewBackgroundColor: "#fff", viewModeEnabled: false, zoom: { value: 1 } },
        });
      });
      const res = await handlers.get_scene_state(api, {});
      const parsed = parseFirst(res);
      expect(parsed.ok).toBe(true);
      expect((parsed.elements as unknown[]).length).toBe(1);
    });

    it("returns excalidraw-not-loaded when excalidrawAPI is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.get_scene_state(api, {});
      expect(parseFirst(res).code).toBe("excalidraw-not-loaded");
    });
  });

  describe("get_viewport", () => {
    it("returns scroll + zoom on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.excalidrawAPI")) return evalEnvelope(true);
        return evalEnvelope({ scrollX: 100, scrollY: 200, zoom: 2 });
      });
      const res = await handlers.get_viewport(api, {});
      expect(parseFirst(res)).toEqual({ ok: true, scrollX: 100, scrollY: 200, zoom: 2 });
    });

    it("returns excalidraw-not-loaded when excalidrawAPI is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.get_viewport(api, {});
      expect(parseFirst(res).code).toBe("excalidraw-not-loaded");
    });
  });

  describe("add_element", () => {
    it("returns elementId on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.excalidrawAPI")) return evalEnvelope(true);
        return evalEnvelope({ elementId: "abc-123" });
      });
      const res = await handlers.add_element(api, {
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      });
      expect(parseFirst(res)).toEqual({ ok: true, elementId: "abc-123" });
    });

    it("returns bad-arg when type missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.add_element(api, { x: 0, y: 0, width: 100, height: 50 });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns bad-arg when width missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.add_element(api, { type: "rectangle", x: 0, y: 0, height: 50 });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns excalidraw-not-loaded when excalidrawAPI is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.add_element(api, {
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      });
      expect(parseFirst(res).code).toBe("excalidraw-not-loaded");
    });
  });

  describe("delete_element", () => {
    it("returns ok on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.excalidrawAPI")) return evalEnvelope(true);
        return evalEnvelope({ removed: 1 });
      });
      const res = await handlers.delete_element(api, { elementId: "el1" });
      expect(parseFirst(res)).toEqual({ ok: true, elementId: "el1" });
    });

    it("returns element-not-found when element absent", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.excalidrawAPI")) return evalEnvelope(true);
        return evalEnvelope({ removed: 0 });
      });
      const res = await handlers.delete_element(api, { elementId: "missing" });
      expect(parseFirst(res).code).toBe("element-not-found");
    });

    it("returns bad-arg when elementId missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.delete_element(api, {});
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns excalidraw-not-loaded when excalidrawAPI is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.delete_element(api, { elementId: "el1" });
      expect(parseFirst(res).code).toBe("excalidraw-not-loaded");
    });
  });

  describe("set_scroll", () => {
    it("returns ok on happy path", async () => {
      const api = makeApi(async (_name, args) => {
        const expr = (args as { expr: string }).expr;
        if (expr.includes("typeof window.excalidrawAPI")) return evalEnvelope(true);
        return evalEnvelope({ scrollX: 50, scrollY: 75 });
      });
      const res = await handlers.set_scroll(api, { scrollX: 50, scrollY: 75 });
      expect(parseFirst(res)).toEqual({ ok: true, scrollX: 50, scrollY: 75 });
    });

    it("returns bad-arg when scrollY missing", async () => {
      const api = makeApi(async () => evalEnvelope(true));
      const res = await handlers.set_scroll(api, { scrollX: 50 });
      expect(parseFirst(res).code).toBe("bad-arg");
    });

    it("returns excalidraw-not-loaded when excalidrawAPI is undefined", async () => {
      const api = makeApi(async () => evalEnvelope(false));
      const res = await handlers.set_scroll(api, { scrollX: 0, scrollY: 0 });
      expect(parseFirst(res).code).toBe("excalidraw-not-loaded");
    });
  });
});

describe("@kalebtec/browxai-plugin-excalidraw register()", () => {
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
    register(fakeApi as never);
    expect(registered.sort()).toEqual([
      "excalidraw.add_element",
      "excalidraw.delete_element",
      "excalidraw.get_scene_state",
      "excalidraw.get_viewport",
      "excalidraw.set_scroll",
    ]);
  });
});
