// Unit-test the example plugin handlers in isolation — no runtime,
// no server, no MCP transport. The keystone covers the
// register-through-MCP-end-to-end path; this file just proves the
// handlers themselves do what they say.

import { describe, it, expect } from "vitest";
import { handlers, register } from "./index.js";

function parseFirst(res: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = res.content[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text!) as Record<string, unknown>;
}

describe("@browxai/plugin-example handlers", () => {
  it("echo round-trips msg", async () => {
    const res = await handlers.echo({ msg: "hi" });
    expect(parseFirst(res)).toEqual({ ok: true, result: "hi" });
  });

  it("echo defaults to empty string when msg is missing", async () => {
    const res = await handlers.echo({});
    expect(parseFirst(res)).toEqual({ ok: true, result: "" });
  });

  it("add sums two numbers", async () => {
    const res = await handlers.add({ a: 2, b: 3 });
    expect(parseFirst(res)).toEqual({ ok: true, sum: 5 });
  });

  it("add defaults missing args to 0", async () => {
    const res = await handlers.add({});
    expect(parseFirst(res)).toEqual({ ok: true, sum: 0 });
  });

  it("now returns ISO + epoch", async () => {
    const res = await handlers.now();
    const parsed = parseFirst(res);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.iso).toBe("string");
    expect(typeof parsed.epochMs).toBe("number");
  });
});

describe("@browxai/plugin-example register()", () => {
  it("registers exactly 3 tools, all namespaced", () => {
    const registered: string[] = [];
    const fakeApi = {
      namespace: "example",
      declaredCapabilities: [],
      registerTool: (name: string) => {
        registered.push(name);
      },
      callTool: async () => ({ content: [] }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    register(fakeApi);
    expect(registered.sort()).toEqual(["example.add", "example.echo", "example.now"]);
  });
});
