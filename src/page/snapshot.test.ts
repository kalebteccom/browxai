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
