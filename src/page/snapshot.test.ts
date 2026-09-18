import { describe, it, expect } from "vitest";
import { findByRef, serialise } from "./snapshot.js";
import type { A11yNode } from "./a11y.js";

function node(
  role: string,
  name: string | undefined,
  ref: string,
  children: A11yNode[] = [],
  extra: Partial<A11yNode> = {},
): A11yNode {
  return { ref, role, name, children, ...extra };
}

describe("serialise", () => {
  it("renders role + name + ref + state for an interactive subtree", () => {
    const tree: A11yNode = node("WebArea", "Example", "e1", [
      node("main", undefined, "e2", [
        node("button", "Save", "e3", [], { focused: true }),
        node("button", "Cancel", "e4", [], { disabled: true }),
      ]),
    ]);
    const out = serialise(tree);
    expect(out).toContain('WebArea "Example" [ref=e1]');
    expect(out).toContain("main [ref=e2]");
    expect(out).toContain('button "Save" [ref=e3] [focused]');
    expect(out).toContain('button "Cancel" [ref=e4] [disabled]');
  });

  it("includes testid hints with the configured attr name (default data-testid)", () => {
    const tree: A11yNode = node("button", "Play", "e1", [], { testId: "play-recap" });
    expect(serialise(tree)).toContain('[data-testid="play-recap"]');
  });

  it("emits the actual matched attribute (e.g. data-type) when known", () => {
    const tree: A11yNode = node("generic", undefined, "e2", [], {
      testId: "stats-pane",
      testIdAttr: "data-type",
    });
    expect(serialise(tree)).toContain('[data-type="stats-pane"]');
  });

  it("marks DOM-walk-only nodes with [from-dom]", () => {
    const tree: A11yNode = node("button", "Save", "e1", [], { source: "dom" });
    expect(serialise(tree)).toContain("[from-dom]");
  });

  it("marks combined-source nodes with [from-both]", () => {
    const tree: A11yNode = node("button", "Cancel", "e1", [], { source: "both" });
    expect(serialise(tree)).toContain("[from-both]");
  });

  it("drops generic/presentation nodes with no name and no testid", () => {
    const tree: A11yNode = node("WebArea", "X", "e1", [
      node("generic", undefined, "e2", [node("button", "Go", "e3")]),
      node("presentation", undefined, "e4", [node("link", "Home", "e5")]),
    ]);
    const out = serialise(tree);
    expect(out).not.toContain("generic");
    expect(out).not.toContain("presentation");
    expect(out).toContain('button "Go" [ref=e3]');
    expect(out).toContain('link "Home" [ref=e5]');
  });

  it("keeps generic nodes that carry a testid (escape hatch)", () => {
    const tree: A11yNode = node("WebArea", "X", "e1", [
      node("generic", undefined, "e2", [], { testId: "stats-pane" }),
    ]);
    expect(serialise(tree)).toContain('generic [ref=e2] [data-testid="stats-pane"]');
  });

  it("truncates very long names", () => {
    const long = "x".repeat(200);
    const tree: A11yNode = node("button", long, "e1");
    const out = serialise(tree, { maxNameLen: 20 });
    expect(out).toMatch(/"x{19}…"/);
  });
});

describe("serialise — (scoped / maxNodes / omit)", () => {
  it("respects maxNodes with an elided-count marker", () => {
    const tree: A11yNode = node(
      "WebArea",
      undefined,
      "e1",
      Array.from({ length: 10 }, (_, i) => node("button", `b${i}`, `e${i + 10}`)),
    );
    const out = serialise(tree, { maxNodes: 3 });
    const lines = out.split("\n");
    expect(lines.length).toBeLessThanOrEqual(5); // 3 nodes + truncation marker (some leeway for pruning)
    expect(out).toMatch(/more nodes elided/);
  });

  it("omit drops matching subtrees and reports the count", () => {
    const tree: A11yNode = node("WebArea", undefined, "e1", [
      node("region", "Header", "e2"),
      node("region", "Timeline", "e3", [
        node("button", "Clip 1", "e4"),
        node("button", "Clip 2", "e5"),
        node("button", "Clip 3", "e6"),
      ]),
      node("region", "Footer", "e7"),
    ]);
    const out = serialise(tree, { omit: ["Timeline"] });
    expect(out).not.toContain("Clip 1");
    expect(out).not.toContain('"Timeline"');
    expect(out).toContain('"Header"');
    expect(out).toContain('"Footer"');
    expect(out).toMatch(/omit matched 1 subtree/);
  });

  it("omit is case-insensitive and matches against testId too", () => {
    const tree: A11yNode = node("WebArea", undefined, "e1", [
      node("button", "Edit", "e2", [], { testId: "library-asset-card-1" }),
      node("button", "Edit", "e3", [], { testId: "footer-card" }),
    ]);
    const out = serialise(tree, { omit: ["library-asset-card"] });
    expect(out).not.toContain("library-asset-card-1");
    expect(out).toContain("footer-card");
  });
});

describe("findByRef", () => {
  it("returns the matching subtree", () => {
    const target = node("region", "Panel", "e5", [node("button", "X", "e6")]);
    const tree: A11yNode = node("WebArea", undefined, "e1", [
      node("region", "Header", "e2"),
      target,
    ]);
    const sub = findByRef(tree, "e5");
    expect(sub).toBe(target);
    expect(serialise(sub!)).toContain('"X"');
  });

  it("returns null when the ref isn't present", () => {
    const tree: A11yNode = node("WebArea", undefined, "e1");
    expect(findByRef(tree, "e999")).toBe(null);
  });
});

describe("serialise — Chromium's text and layout leaves", () => {
  it("emits no line for a StaticText that repeats its parent's name", () => {
    const tree: A11yNode = node("WebArea", "X", "e1", [
      node("button", "Save", "e2", [node("StaticText", "Save", "e3")]),
    ]);
    const out = serialise(tree);
    expect(out).toContain('button "Save" [ref=e2]');
    expect(out).not.toContain("StaticText");
    // The button's own name is Chromium's, computed from the DOM, so
    // suppressing the text child never costs a control its label.
    expect(out).toContain('"Save"');
  });

  it("emits no line for the layout and typography wrappers", () => {
    const roles = [
      "LineBreak",
      "ListMarker",
      "LayoutTable",
      "LayoutTableRow",
      "LayoutTableCell",
      "Abbr",
      "EmphasizedText",
      "StrongText",
      "superscript",
      "subscript",
    ];
    const tree: A11yNode = node(
      "WebArea",
      "X",
      "e1",
      roles.map((r, i) => node(r, "text", `e${i + 2}`)),
    );
    const out = serialise(tree);
    for (const r of roles) expect(out, r).not.toContain(r);
  });

  it("keeps a text leaf the page author addressed by test attribute", () => {
    const tree: A11yNode = node("WebArea", "X", "e1", [
      node("StaticText", "42", "e2", [], { testId: "price-total" }),
    ]);
    expect(serialise(tree)).toContain('StaticText "42" [ref=e2] [data-testid="price-total"]');
  });

  it("keeps a suppressed node's children at its own depth, not one deeper", () => {
    // The suppressed node contributes no line, so it contributes no level:
    // indenting its children at `depth + 1` anyway made a spliced control read
    // as nested under whichever sibling emitted the line above it.
    const tree: A11yNode = node("WebArea", "X", "e1", [
      node("heading", "Section", "e2"),
      node("generic", undefined, "e3", [node("button", "Go", "e4")]),
    ]);
    const lines = serialise(tree).split("\n");
    expect(lines[1]).toBe('  heading "Section" [ref=e2]');
    expect(lines[2]).toBe('  button "Go" [ref=e4]');
  });

  it("collapses a chain of suppressed wrappers to a single level", () => {
    const tree: A11yNode = node("WebArea", "X", "e1", [
      node("generic", undefined, "e2", [
        node("none", undefined, "e3", [node("StaticText", "hi", "e4", [node("link", "Go", "e5")])]),
      ]),
    ]);
    expect(serialise(tree).split("\n")[1]).toBe('  link "Go" [ref=e5]');
  });
});
