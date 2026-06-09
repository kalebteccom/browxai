import { describe, it, expect } from "vitest";
import { RegionRegistry } from "./regions.js";

describe("RegionRegistry", () => {
  it("set returns the region with a computed centre", () => {
    const reg = new RegionRegistry();
    const r = reg.set("audio_clip", { x: 100, y: 200, width: 80, height: 40 });
    expect(r).toEqual({
      name: "audio_clip",
      box: { x: 100, y: 200, width: 80, height: 40 },
      center: { x: 140, y: 220 },
    });
  });

  it("get resolves a bound name; undefined for an unknown one", () => {
    const reg = new RegionRegistry();
    reg.set("a", { x: 0, y: 0, width: 10, height: 10 });
    expect(reg.get("a")?.center).toEqual({ x: 5, y: 5 });
    expect(reg.get("missing")).toBeUndefined();
  });

  it("re-binding a name overwrites the box", () => {
    const reg = new RegionRegistry();
    reg.set("x", { x: 0, y: 0, width: 2, height: 2 });
    reg.set("x", { x: 50, y: 50, width: 10, height: 10 });
    expect(reg.get("x")?.box).toEqual({ x: 50, y: 50, width: 10, height: 10 });
    expect(reg.list()).toHaveLength(1);
  });

  it("list returns every bound region", () => {
    const reg = new RegionRegistry();
    reg.set("a", { x: 0, y: 0, width: 1, height: 1 });
    reg.set("b", { x: 1, y: 1, width: 1, height: 1 });
    expect(
      reg
        .list()
        .map((r) => r.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
