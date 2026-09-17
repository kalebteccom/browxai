// getA11yTree conversion tests — the `ignored` splice.
//
// CDP marks a node `ignored` when *that node* is not exposed to assistive tech
// (a presentational wrapper, an `aria-hidden` container, a layout div). Real
// Chromium marks `<html>` and `<body>` ignored on essentially every page
// (`ignoredReasons: [uninteresting]`), so dropping an ignored node's subtree
// drops the page. The fixtures below mirror the shapes a live `getFullAXTree`
// returns, verified against headless Chromium.
//
// All CDP work is faked — no Playwright/Chromium here.

import { describe, it, expect, vi } from "vitest";
import type { CDPSession } from "playwright-core";
import { getA11yTree } from "./a11y.js";
import { elementKey, RefRegistry } from "./refs.js";
import type { A11yNode } from "./a11y-types.js";

interface FixtureNode {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** A CDP session that serves `nodes` from `Accessibility.getFullAXTree` and
 *  nothing else. `DOM.getAttributes` returns empty so testId enrichment is a
 *  no-op and the refs under test come purely from role/name/path. */
function cdpServing(nodes: FixtureNode[]): CDPSession {
  return {
    send: vi.fn(async (method: string) => {
      switch (method) {
        case "Accessibility.enable":
          return {};
        case "Accessibility.getFullAXTree":
          return { nodes };
        case "DOM.getAttributes":
          return { attributes: [] };
        default:
          throw new Error(`unexpected CDP method ${method}`);
      }
    }),
  } as unknown as CDPSession;
}

const roles = (n: A11yNode): string[] => n.children.map((c) => c.role);
const names = (n: A11yNode): Array<string | undefined> => n.children.map((c) => c.name);

/** `<html>` / `<body>` ignored as `uninteresting`, exactly as headless Chromium
 *  reports them, with the page's real content underneath. */
const CHROMIUM_SHAPED: FixtureNode[] = [
  { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" }, childIds: ["2"] },
  { nodeId: "2", parentId: "1", ignored: true, role: { value: "none" }, childIds: ["3"] },
  { nodeId: "3", parentId: "2", ignored: true, role: { value: "none" }, childIds: ["4", "5"] },
  {
    nodeId: "4",
    parentId: "3",
    role: { value: "button" },
    name: { value: "Save" },
    backendDOMNodeId: 40,
  },
  {
    nodeId: "5",
    parentId: "3",
    role: { value: "button" },
    name: { value: "Cancel" },
    backendDOMNodeId: 50,
  },
];

describe("getA11yTree — ignored nodes splice, they do not prune", () => {
  it("keeps the interactive children of an ignored wrapper", async () => {
    const tree = await getA11yTree(cdpServing(CHROMIUM_SHAPED), new RefRegistry());
    expect(tree).not.toBeNull();
    expect(tree!.role).toBe("RootWebArea");
    expect(roles(tree!)).toEqual(["button", "button"]);
    expect(names(tree!)).toEqual(["Save", "Cancel"]);
  });

  it("contributes no entry for the ignored node itself", async () => {
    const tree = await getA11yTree(cdpServing(CHROMIUM_SHAPED), new RefRegistry());
    // "none" is the role CDP reports for an ignored wrapper; it must not appear.
    const allRoles: string[] = [];
    const stack = [tree!];
    while (stack.length) {
      const n = stack.pop()!;
      allRoles.push(n.role);
      stack.push(...n.children);
    }
    expect(allRoles).not.toContain("none");
  });

  it("yields a tree when the ROOT is ignored", async () => {
    // A detached-ish document whose root node is itself ignored. Pre-fix this
    // returned null and the whole a11y tier went dark.
    const nodes: FixtureNode[] = [
      { nodeId: "1", ignored: true, role: { value: "none" }, childIds: ["2", "3"] },
      { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "Alpha" } },
      { nodeId: "3", parentId: "1", role: { value: "link" }, name: { value: "Beta" } },
    ];
    const tree = await getA11yTree(cdpServing(nodes), new RefRegistry());
    expect(tree).not.toBeNull();
    expect(roles(tree!)).toEqual(["button", "link"]);
  });

  it("returns null only when nothing at all survives", async () => {
    // An `aria-hidden` subtree: the container AND its descendants are ignored,
    // so nothing is exposed and null is the correct answer.
    const nodes: FixtureNode[] = [
      { nodeId: "1", ignored: true, role: { value: "none" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", ignored: true, role: { value: "none" } },
    ];
    expect(await getA11yTree(cdpServing(nodes), new RefRegistry())).toBeNull();
  });

  it("splices in document order at the ignored node's position", async () => {
    const nodes: FixtureNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3", "6"] },
      { nodeId: "2", parentId: "1", role: { value: "button" }, name: { value: "A" } },
      { nodeId: "3", parentId: "1", ignored: true, role: { value: "none" }, childIds: ["4", "5"] },
      { nodeId: "4", parentId: "3", role: { value: "button" }, name: { value: "B" } },
      { nodeId: "5", parentId: "3", role: { value: "button" }, name: { value: "C" } },
      { nodeId: "6", parentId: "1", role: { value: "button" }, name: { value: "D" } },
    ];
    const tree = await getA11yTree(cdpServing(nodes), new RefRegistry());
    expect(names(tree!)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("getA11yTree — path and ref stability", () => {
  it("keeps the ignored node's path segment, so descendant keys are unchanged", async () => {
    const refs = new RefRegistry();
    const tree = await getA11yTree(cdpServing(CHROMIUM_SHAPED), refs);
    // Path grammar: `<rootRole>` then `/<childRole>[<index>]` per level. The
    // ignored `none` wrappers still contribute their segment.
    const key = elementKey({
      role: "button",
      name: "Save",
      path: "RootWebArea/none[0]/none[0]/button[0]",
    });
    expect(refs.hasKey(key)).toBe(true);
    expect(tree!.children[0]!.ref).toBe(refs.forKey(key));
  });

  it("a wrapper flipping to ignored does not move its descendants' refs", async () => {
    // One registry, two snapshots — the second with `aria-hidden` toggled onto
    // the wrapper. This is the cross-snapshot coherence constraint refs exist
    // for: the button is the same element, so it keeps its eN.
    const exposed: FixtureNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", role: { value: "none" }, childIds: ["3"] },
      { nodeId: "3", parentId: "2", role: { value: "button" }, name: { value: "Save" } },
    ];
    const hidden = exposed.map((n) => (n.nodeId === "2" ? { ...n, ignored: true } : n));
    const refs = new RefRegistry();
    const before = await getA11yTree(cdpServing(exposed), refs);
    const after = await getA11yTree(cdpServing(hidden), refs);
    const findButton = (n: A11yNode): A11yNode | null => {
      if (n.role === "button") return n;
      for (const c of n.children) {
        const hit = findButton(c);
        if (hit) return hit;
      }
      return null;
    };
    expect(findButton(after!)!.ref).toBe(findButton(before!)!.ref);
  });

  it("an ignored sibling does not shift its later siblings' path indices", async () => {
    const refs = new RefRegistry();
    const nodes: FixtureNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
      { nodeId: "2", parentId: "1", ignored: true, role: { value: "none" } },
      { nodeId: "3", parentId: "1", role: { value: "button" }, name: { value: "Tail" } },
    ];
    await getA11yTree(cdpServing(nodes), refs);
    // Index 1, not 0 — the ignored sibling still occupies its slot.
    const key = elementKey({ role: "button", name: "Tail", path: "RootWebArea/button[1]" });
    expect(refs.hasKey(key)).toBe(true);
  });
});

describe("getA11yTree — malformed graphs terminate", () => {
  it("does not loop when childIds point back at an ancestor", async () => {
    const nodes: FixtureNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", role: { value: "group" }, childIds: ["3"] },
      { nodeId: "3", parentId: "2", role: { value: "button" }, name: { value: "Loop" } },
      // "2" re-parents itself under "3" — a cycle a tree walk must survive.
      { nodeId: "3b", parentId: "3" },
    ];
    nodes[2]!.childIds = ["2"];
    const tree = await getA11yTree(cdpServing(nodes), new RefRegistry());
    expect(tree!.children[0]!.role).toBe("group");
    expect(tree!.children[0]!.children[0]!.role).toBe("button");
    // The cycle stops here rather than re-expanding "group".
    expect(tree!.children[0]!.children[0]!.children).toEqual([]);
  });

  it("emits a node once when two parents claim the same child", async () => {
    const nodes: FixtureNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "3"] },
      { nodeId: "2", parentId: "1", role: { value: "group" }, childIds: ["4"] },
      { nodeId: "3", parentId: "1", role: { value: "group" }, childIds: ["4"] },
      { nodeId: "4", parentId: "2", role: { value: "button" }, name: { value: "Shared" } },
    ];
    const tree = await getA11yTree(cdpServing(nodes), new RefRegistry());
    expect(tree!.children[0]!.children.map((c) => c.role)).toEqual(["button"]);
    expect(tree!.children[1]!.children).toEqual([]);
  });
});
