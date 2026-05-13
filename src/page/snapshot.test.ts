import { describe, it, expect } from "vitest";
import { serialise } from "./snapshot.js";
import type { A11yNode } from "./a11y.js";

function node(role: string, name: string | undefined, ref: string, children: A11yNode[] = [], extra: Partial<A11yNode> = {}): A11yNode {
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
    expect(out).toContain('main [ref=e2]');
    expect(out).toContain('button "Save" [ref=e3] [focused]');
    expect(out).toContain('button "Cancel" [ref=e4] [disabled]');
  });

  it("includes testid hints with the configured attr name (default data-testid)", () => {
    const tree: A11yNode = node("button", "Play", "e1", [], { testId: "play-recap" });
    expect(serialise(tree)).toContain('[data-testid="play-recap"]');
  });

  it("emits the actual matched attribute (e.g. data-type) when known", () => {
    const tree: A11yNode = node("generic", undefined, "e2", [], { testId: "stats-pane", testIdAttr: "data-type" });
    expect(serialise(tree)).toContain('[data-type="stats-pane"]');
  });

  it("marks DOM-walk-only nodes with [from-dom]", () => {
    const tree: A11yNode = node("button", "Save", "e1", [], { source: "dom" });
    expect(serialise(tree)).toContain('[from-dom]');
  });

  it('marks combined-source nodes with [from-both]', () => {
    const tree: A11yNode = node("button", "Cancel", "e1", [], { source: "both" });
    expect(serialise(tree)).toContain('[from-both]');
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
