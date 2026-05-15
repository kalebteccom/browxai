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

describe("augmentLocator — provenance merge", () => {
  it("installs partial when ref has no prior locator inputs", () => {
    const r = new RefRegistry();
    const ref = r.forKey("k1");
    r.augmentLocator(ref, { role: "button", name: "Save", source: "a11y" });
    expect(r.locatorOf(ref)).toEqual({ role: "button", name: "Save", source: "a11y" });
  });

  it("existing richness wins on merge, missing fields fill in", () => {
    const r = new RefRegistry();
    const ref = r.forKey("k1", { role: "button", name: "Save", source: "a11y" });
    // DOM walk later discovers the same node and adds cssPath / source dom.
    r.augmentLocator(ref, { role: "button", cssPath: "body > button:nth-child(1)", source: "dom" });
    const got = r.locatorOf(ref);
    expect(got?.name).toBe("Save");                                  // a11y richness preserved
    expect(got?.cssPath).toBe("body > button:nth-child(1)");         // dom-side gap filled
    expect(got?.source).toBe("both");                                // sources combine
  });

  it("a11y testId discovered later fills in without clobbering cssPath", () => {
    const r = new RefRegistry();
    const ref = r.forKey("k1", { role: "td", cssPath: "table > tbody > tr:nth-child(3) > td:nth-child(2)", source: "dom" });
    r.augmentLocator(ref, { testId: "row-3-status", testIdAttr: "data-testid" });
    const got = r.locatorOf(ref);
    expect(got?.testId).toBe("row-3-status");
    expect(got?.testIdAttr).toBe("data-testid");
    expect(got?.cssPath).toBe("table > tbody > tr:nth-child(3) > td:nth-child(2)");
  });

  it("combines two distinct sources into 'both'", () => {
    const r = new RefRegistry();
    const ref = r.forKey("k1", { role: "button", source: "a11y" });
    r.augmentLocator(ref, { source: "dom" });
    expect(r.locatorOf(ref)?.source).toBe("both");
  });

  it("does nothing when called for an unknown ref", () => {
    const r = new RefRegistry();
    r.augmentLocator("e999", { role: "button", source: "a11y" });
    expect(r.locatorOf("e999")).toBeUndefined();
  });
});

describe("named refs (wishlist W-C1)", () => {
  it("binds a mnemonic to an existing ref and resolves it back", () => {
    const r = new RefRegistry();
    const ref = r.forKey("hash-abc");
    r.nameRef("main_panel", ref);
    expect(r.refByNameLookup("main_panel")).toBe(ref);
  });

  it("throws when binding to a ref that doesn't exist", () => {
    const r = new RefRegistry();
    expect(() => r.nameRef("ghost", "e999")).toThrow(/not in registry/);
  });

  it("rebinds when the same name is set twice", () => {
    const r = new RefRegistry();
    const a = r.forKey("k1");
    const b = r.forKey("k2");
    r.nameRef("anchor", a);
    r.nameRef("anchor", b);
    expect(r.refByNameLookup("anchor")).toBe(b);
  });

  it("listNames enumerates current bindings", () => {
    const r = new RefRegistry();
    r.forKey("k1");
    r.forKey("k2");
    r.nameRef("a", "e1");
    r.nameRef("b", "e2");
    expect(r.listNames().sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "a", ref: "e1" },
      { name: "b", ref: "e2" },
    ]);
  });
});
