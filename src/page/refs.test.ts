import { describe, it, expect } from "vitest";
import { RefRegistry, elementKey } from "./refs.js";

describe("elementKey", () => {
  it("differs on role, name, path, or testId", () => {
    const a = elementKey({ role: "button", name: "Save", path: "main/form/button[0]" });
    const b = elementKey({ role: "button", name: "Save", path: "main/form/button[1]" });
    const c = elementKey({ role: "button", name: "Cancel", path: "main/form/button[0]" });
    const d = elementKey({ role: "link", name: "Save", path: "main/form/button[0]" });
    const e = elementKey({ role: "button", name: "Save", path: "main/form/button[0]", testId: "save-btn" });
    expect(new Set([a, b, c, d, e]).size).toBe(5);
  });

  it("is deterministic", () => {
    const k1 = elementKey({ role: "textbox", name: "Email", path: "main/form/input[0]" });
    const k2 = elementKey({ role: "textbox", name: "Email", path: "main/form/input[0]" });
    expect(k1).toBe(k2);
  });
});

describe("RefRegistry", () => {
  it("mints incrementing refs", () => {
    const r = new RefRegistry();
    expect(r.forKey("k1")).toBe("e1");
    expect(r.forKey("k2")).toBe("e2");
    expect(r.forKey("k3")).toBe("e3");
  });

  it("returns the same ref for the same key (persistence across snapshots)", () => {
    const r = new RefRegistry();
    const ref = r.forKey("hash-abc");
    expect(r.forKey("hash-abc")).toBe(ref);
  });

  it("tracks has/keyOf", () => {
    const r = new RefRegistry();
    const ref = r.forKey("xyz");
    expect(r.has(ref)).toBe(true);
    expect(r.keyOf(ref)).toBe("xyz");
    expect(r.has("e999")).toBe(false);
  });
});
