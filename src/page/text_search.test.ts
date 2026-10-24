import { describe, it, expect } from "vitest";
import type { A11yNode } from "./a11y.js";
import { searchTreeForText } from "./text_search.js";

let seq = 0;
function n(role: string, name?: string, children: A11yNode[] = []): A11yNode {
  return { ref: `e${++seq}`, role, name, children };
}

describe("searchTreeForText — pure-tree match", () => {
  it.each([
    {
      name: "finds substring matches (case-insensitive) by default",
      build: () =>
        n("WebArea", undefined, [
          n("button", "Save changes"),
          n("button", "Saved successfully"),
          n("button", "Discard"),
        ]),
      query: "save",
      exact: false,
      max: undefined,
      names: ["Save changes", "Saved successfully"],
    },
    {
      name: "respects exact mode (case-sensitive equality on trimmed name)",
      build: () =>
        n("WebArea", undefined, [
          n("text", "Engineering"),
          n("text", "engineering"),
          n("text", "Engineering and design"),
        ]),
      query: "Engineering",
      exact: true,
      max: undefined,
      names: ["Engineering"],
    },
    {
      name: "ignores nodes with empty / whitespace-only names",
      build: () =>
        n("WebArea", undefined, [n("generic", undefined), n("generic", "   "), n("text", "hit")]),
      query: "hit",
      exact: false,
      max: undefined,
      names: ["hit"],
    },
    {
      name: "walks the whole subtree, not just immediate children",
      build: () =>
        n("WebArea", undefined, [
          n("section", undefined, [n("section", undefined, [n("text", "deep target")])]),
        ]),
      query: "deep target",
      exact: true,
      max: undefined,
      names: ["deep target"],
    },
    {
      name: "respects the max cap",
      build: () =>
        n(
          "WebArea",
          undefined,
          Array.from({ length: 10 }, () => n("text", "needle")),
        ),
      query: "needle",
      exact: false,
      max: 3,
      names: ["needle", "needle", "needle"],
    },
  ])("$name", ({ build, query, exact, max, names }) => {
    seq = 0;
    const hits = searchTreeForText(build(), query, exact, max);
    expect(hits.map((h) => h.name)).toEqual(names);
  });
});
