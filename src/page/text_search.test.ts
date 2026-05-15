import { describe, it, expect } from "vitest";
import type { A11yNode } from "./a11y.js";
import { searchTreeForText } from "./text_search.js";

let seq = 0;
function n(role: string, name?: string, children: A11yNode[] = []): A11yNode {
  return { ref: `e${++seq}`, role, name, children };
}

describe("searchTreeForText — W-F4 pure-tree match", () => {
  it("finds substring matches (case-insensitive) by default", () => {
    seq = 0;
    const tree = n("WebArea", undefined, [
      n("button", "Save changes"),
      n("button", "Saved successfully"),
      n("button", "Discard"),
    ]);
    const hits = searchTreeForText(tree, "save", false);
    expect(hits.map((h) => h.name)).toEqual(["Save changes", "Saved successfully"]);
  });

  it("respects exact mode (case-sensitive equality on trimmed name)", () => {
    seq = 0;
    const tree = n("WebArea", undefined, [
      n("text", "Engineering"),
      n("text", "engineering"),
      n("text", "Engineering and design"),
    ]);
    const hits = searchTreeForText(tree, "Engineering", true);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe("Engineering");
  });

  it("returns an empty list when nothing matches — the absence-check primitive", () => {
    seq = 0;
    const tree = n("WebArea", undefined, [
      n("text", "Engineering"),
      n("text", "Design"),
    ]);
    const hits = searchTreeForText(tree, "Support", true);
    expect(hits).toEqual([]);
  });

  it("ignores nodes with empty / whitespace-only names", () => {
    seq = 0;
    const tree = n("WebArea", undefined, [
      n("generic", undefined),
      n("generic", "   "),
      n("text", "hit"),
    ]);
    const hits = searchTreeForText(tree, "hit", false);
    expect(hits.map((h) => h.name)).toEqual(["hit"]);
  });

  it("walks the whole subtree, not just immediate children", () => {
    seq = 0;
    const inner = n("text", "deep target");
    const tree = n("WebArea", undefined, [
      n("section", undefined, [n("section", undefined, [inner])]),
    ]);
    const hits = searchTreeForText(tree, "deep target", true);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ref).toBe(inner.ref);
  });

  it("respects the max cap", () => {
    seq = 0;
    const tree = n("WebArea", undefined, Array.from({ length: 10 }, () => n("text", "needle")));
    const hits = searchTreeForText(tree, "needle", false, 3);
    expect(hits).toHaveLength(3);
  });
});
