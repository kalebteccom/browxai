import { describe, it, expect } from "vitest";
import { patterniseUrl, extractTopLevelKeys } from "./network.js";

describe("patterniseUrl — url redaction", () => {
  it("strips query strings", () => {
    expect(patterniseUrl("https://api.example.com/v1/records?id=42&date=2026-05-15")).toBe(
      "https://api.example.com/v1/records",
    );
  });

  it("replaces numeric path segments with :id", () => {
    expect(patterniseUrl("https://api.example.com/users/12345/records")).toBe(
      "https://api.example.com/users/:id/records",
    );
  });

  it("replaces UUID path segments with :id", () => {
    expect(patterniseUrl("https://api.example.com/orders/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "https://api.example.com/orders/:id",
    );
  });

  it("replaces long hex path segments with :id (object id shapes)", () => {
    expect(patterniseUrl("https://api.example.com/items/507f1f77bcf86cd799439011")).toBe(
      "https://api.example.com/items/:id",
    );
  });

  it("preserves human-readable path segments", () => {
    expect(patterniseUrl("https://api.example.com/v2/users/profile/avatar")).toBe(
      "https://api.example.com/v2/users/profile/avatar",
    );
  });

  it("returns the raw url when URL parsing fails", () => {
    expect(patterniseUrl("not a url")).toBe("not a url");
  });
});

describe("extractTopLevelKeys — response shape redaction", () => {
  it("returns top-level keys of a plain JSON object", () => {
    expect(extractTopLevelKeys({ id: 1, name: "x", nested: { a: 1 } })).toEqual(["id", "name", "nested"]);
  });

  it("does not descend into nested objects", () => {
    const result = extractTopLevelKeys({ outer: { inner: { deep: 1 } } });
    expect(result).toEqual(["outer"]);
  });

  it("marks array shape via the [].key prefix when an array of objects", () => {
    const result = extractTopLevelKeys([{ id: 1, label: "a" }, { id: 2, label: "b" }]);
    expect(result).toEqual(["[].id", "[].label"]);
  });

  it("returns null for primitives", () => {
    expect(extractTopLevelKeys("just a string")).toBeNull();
    expect(extractTopLevelKeys(42)).toBeNull();
    expect(extractTopLevelKeys(null)).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(extractTopLevelKeys([])).toBeNull();
  });

  it("returns null for an array of non-objects", () => {
    expect(extractTopLevelKeys([1, 2, 3])).toBeNull();
  });

  it("caps keys at 20", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 30; i++) big[`k${i}`] = i;
    const result = extractTopLevelKeys(big);
    expect(result).toHaveLength(20);
  });
});
