import { describe, it, expect, vi } from "vitest";
import { inspectElement, DEFAULT_STYLE_KEYS } from "./inspect.js";

describe("inspectElement", () => {
  it("returns { found:false } when the locator matches nothing", async () => {
    const loc = { count: async () => 0, evaluate: vi.fn() } as never;
    expect(await inspectElement(loc)).toEqual({ found: false });
  });

  it("evaluates with the default style keys plus caller extras", async () => {
    const evaluate = vi.fn(async (_fn: unknown, keys: string[]) => ({
      found: true,
      box: { x: 0, y: 0, width: 10, height: 10 },
      styles: Object.fromEntries(keys.map((k) => [k, "x"])),
      overflowing: { x: false, y: false },
      visible: true,
      childCount: 3,
    }));
    const loc = { count: async () => 1, evaluate } as never;
    const r = await inspectElement(loc, ["borderBottomWidth"]);
    const passedKeys = evaluate.mock.calls[0]![1] as string[];
    expect(passedKeys).toEqual([...DEFAULT_STYLE_KEYS, "borderBottomWidth"]);
    expect(r.found).toBe(true);
    expect(r.childCount).toBe(3);
  });

  it("degrades to { found:false } if the page evaluate throws", async () => {
    const loc = {
      count: async () => 1,
      evaluate: async () => {
        throw new Error("detached");
      },
    } as never;
    expect(await inspectElement(loc)).toEqual({ found: false });
  });

  it("default style whitelist covers the control-state / layout keys", () => {
    for (const k of [
      "cursor",
      "display",
      "visibility",
      "overflow",
      "overflowX",
      "overflowY",
      "position",
      "pointerEvents",
    ]) {
      expect(DEFAULT_STYLE_KEYS).toContain(k);
    }
  });
});
