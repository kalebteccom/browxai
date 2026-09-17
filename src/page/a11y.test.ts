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
 *  nothing else. `DOM.getDocument` returns a document with no elements, so the
 *  test-attribute sweep attaches nothing and the refs under test come purely
 *  from role/name/path. */
function cdpServing(nodes: FixtureNode[]): CDPSession {
  return {
    send: vi.fn(async (method: string) => {
      switch (method) {
        case "Accessibility.enable":
          return {};
        case "Accessibility.getFullAXTree":
          return { nodes };
        case "DOM.getDocument":
          return { root: { backendNodeId: 1, children: [] } };
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
    const allRoles: string[] = [];
    const stack = [tree!];
    while (stack.length) {
      const n = stack.pop()!;
      allRoles.push(n.role);
      stack.push(...n.children);
    }
    // The children are through…
    expect(allRoles.filter((r) => r === "button")).toHaveLength(2);
    // …and "none", the role CDP reports for an ignored wrapper, is not.
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

  it("drops an aria-hidden subtree, whose descendants are ignored too", async () => {
    // CDP marks every node under `aria-hidden` ignored, so splicing surfaces
    // nothing. The root stays as the anchor `mergeDomWalkIntoTree` hangs
    // DOM-walk entries off — a null tree would drop those too.
    const nodes: FixtureNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2", "4"] },
      { nodeId: "2", parentId: "1", ignored: true, role: { value: "none" }, childIds: ["3"] },
      { nodeId: "3", parentId: "2", ignored: true, role: { value: "none" } },
      // Exposed sibling: the hidden subtree goes, the rest of the page stays.
      { nodeId: "4", parentId: "1", role: { value: "button" }, name: { value: "Visible" } },
    ];
    const tree = await getA11yTree(cdpServing(nodes), new RefRegistry());
    expect(tree!.role).toBe("RootWebArea");
    expect(names(tree!)).toEqual(["Visible"]);
  });

  it("keeps an all-ignored document's root as the DOM-walk anchor", async () => {
    const nodes: FixtureNode[] = [
      { nodeId: "1", ignored: true, role: { value: "none" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", ignored: true, role: { value: "none" } },
    ];
    const tree = await getA11yTree(cdpServing(nodes), new RefRegistry());
    expect(tree).not.toBeNull();
    expect(tree!.children).toEqual([]);
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

describe("getA11yTree — layout-internal text boxes", () => {
  it("drops InlineTextBox and keeps its StaticText parent", async () => {
    const nodes: FixtureNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "button" },
        name: { value: "Go" },
        childIds: ["3"],
      },
      {
        nodeId: "3",
        parentId: "2",
        role: { value: "StaticText" },
        name: { value: "Go" },
        childIds: ["4"],
      },
      { nodeId: "4", parentId: "3", role: { value: "InlineTextBox" }, name: { value: "Go" } },
    ];
    const tree = await getA11yTree(cdpServing(nodes), new RefRegistry());
    const button = tree!.children[0]!;
    expect(roles(button)).toEqual(["StaticText"]);
    expect(button.children[0]!.children).toEqual([]);
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
    // One registry, two snapshots — the second with the wrapper marked ignored
    // and its AX role value unchanged. This is the cross-snapshot coherence
    // constraint refs exist for, and the exact shape Chromium produces when its
    // `uninteresting` verdict moves on an otherwise-unchanged wrapper.
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

  it("a wrapper whose ROLE changes re-keys its descendants — the limit of the guarantee", async () => {
    // The role value is part of the path segment, so a wrapper that changes
    // role rotates every ref beneath it. Verified against real Chromium:
    // `generic` → `group` on a plain `<div>` moved the button from e3 to e6,
    // and `role="presentation"` moved it again because Chromium drops the node
    // from the tree entirely instead of marking it ignored. The CHANGELOG and
    // the comment in `a11y.ts` claim ref stability only for the flip that keeps
    // the role.
    const asGeneric: FixtureNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", role: { value: "generic" }, childIds: ["3"] },
      { nodeId: "3", parentId: "2", role: { value: "button" }, name: { value: "Save" } },
    ];
    const asGroup = asGeneric.map((n) =>
      n.nodeId === "2" ? { ...n, role: { value: "group" } } : n,
    );
    const refs = new RefRegistry();
    const before = await getA11yTree(cdpServing(asGeneric), refs);
    const after = await getA11yTree(cdpServing(asGroup), refs);
    expect(before!.children[0]!.children[0]!.ref).not.toBe(after!.children[0]!.children[0]!.ref);
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

describe("getA11yTree — the test-attribute sweep", () => {
  /** `Accessibility.getFullAXTree` reports a BACKEND node id; the sweep keys on
   *  the same id, which is what the per-node `DOM.getAttributes` loop got wrong
   *  (it passed a `BackendNodeId` where a `DOM.NodeId` was wanted, and no
   *  `DOM.getDocument` had ever run, so every call failed). */
  function cdpWithDom(nodes: FixtureNode[], root: unknown): CDPSession {
    return {
      send: vi.fn(async (method: string) => {
        switch (method) {
          case "Accessibility.enable":
            return {};
          case "Accessibility.getFullAXTree":
            return { nodes };
          case "DOM.getDocument":
            return { root };
          default:
            throw new Error(`unexpected CDP method ${method}`);
        }
      }),
    } as unknown as CDPSession;
  }

  const axNodes: FixtureNode[] = [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
    {
      nodeId: "2",
      parentId: "1",
      role: { value: "button" },
      name: { value: "Save" },
      backendDOMNodeId: 40,
    },
  ];

  it("attaches the attribute value, keyed by backend node id", async () => {
    const refs = new RefRegistry();
    const tree = await getA11yTree(
      cdpWithDom(axNodes, {
        backendNodeId: 1,
        children: [{ backendNodeId: 40, attributes: ["id", "save", "data-testid", "save-btn"] }],
      }),
      refs,
      ["data-testid"],
    );
    const button = tree!.children[0]!;
    expect(button.testId).toBe("save-btn");
    expect(button.testIdAttr).toBe("data-testid");
    // And the registry can rebuild a tier-1 locator from it.
    expect(refs.locatorOf(button.ref)?.testId).toBe("save-btn");
  });

  it("honours the caller's attribute preference order, not the DOM's", async () => {
    const tree = await getA11yTree(
      cdpWithDom(axNodes, {
        backendNodeId: 1,
        children: [{ backendNodeId: 40, attributes: ["data-cy", "cy-val", "data-test", "t-val"] }],
      }),
      new RefRegistry(),
      ["data-test", "data-cy"],
    );
    expect(tree!.children[0]!.testIdAttr).toBe("data-test");
  });

  it("reaches an element nested anywhere under the document", async () => {
    const tree = await getA11yTree(
      cdpWithDom(axNodes, {
        backendNodeId: 1,
        children: [
          {
            backendNodeId: 2,
            children: [
              { backendNodeId: 3, children: [{ backendNodeId: 40, attributes: ["data-qa", "q"] }] },
            ],
          },
        ],
      }),
      new RefRegistry(),
      ["data-qa"],
    );
    expect(tree!.children[0]!.testId).toBe("q");
  });

  it("survives a DOM agent that refuses", async () => {
    const cdp = {
      send: vi.fn(async (method: string) => {
        if (method === "Accessibility.enable") return {};
        if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
        throw new Error("DOM agent not enabled");
      }),
    } as unknown as CDPSession;
    const tree = await getA11yTree(cdp, new RefRegistry(), ["data-testid"]);
    expect(tree!.children[0]!.testId).toBeUndefined();
  });
});
