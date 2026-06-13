import { describe, it, expect } from "vitest";
import { RefRegistry } from "./refs.js";
import {
  SafariClassicSnapshotSubstrate,
  type SafariSnapshotIO,
} from "./snapshot-substrate-safari.js";

// The Safari substrate runs browxai's DOM-walk over an injected execute/sync
// bridge. These tests drive it with a mock IO returning the SAME DomWalkEntry
// JSON the spike observed on real Safari (docs/rfcs/references/07-…-plan.md §4),
// asserting it builds the WebArea-rooted tree with stable refs + the find-ranking
// signal — no safaridriver, no browser.

const SPIKE_ENTRIES = [
  {
    role: "button",
    name: "Go now",
    testId: "go",
    testIdAttr: "data-testid",
    tag: "button",
    id: "",
    structuralPath: "body[0]/button[1]",
    cssPath: "body:nth-child(2) > button:nth-child(2)",
  },
  {
    role: "input",
    name: "search",
    testId: "",
    testIdAttr: "",
    tag: "input",
    id: "q",
    structuralPath: "body[0]/input[2]",
    cssPath: "body:nth-child(2) > input:nth-child(3)",
  },
  {
    role: "tab",
    name: "Tab One",
    testId: "t1",
    testIdAttr: "data-test",
    tag: "div",
    id: "",
    structuralPath: "body[0]/div[3]",
    cssPath: "body:nth-child(2) > div:nth-child(5)",
  },
];

function mockIO(
  entries: unknown[] = SPIKE_ENTRIES,
  url = "https://example.com/",
): SafariSnapshotIO {
  return {
    exec: async () => entries,
    currentUrl: async () => url,
  };
}

/** Narrow the nullable composed tree — the substrate always returns a root. */
function nn<T>(v: T | null): T {
  if (v === null) throw new Error("expected a non-null snapshot tree");
  return v;
}

describe("SafariClassicSnapshotSubstrate", () => {
  it("declares the safari engine tag", () => {
    expect(new SafariClassicSnapshotSubstrate(mockIO()).engine).toBe("safari");
  });

  it("composes a WebArea-rooted tree from the DOM-walk entries", async () => {
    const sub = new SafariClassicSnapshotSubstrate(mockIO());
    const refs = new RefRegistry();
    const snap = await sub.compose(refs, ["data-testid", "data-test"]);
    const tree = nn(snap.tree);

    expect(tree.role).toBe("WebArea");
    expect(tree.name).toBe("https://example.com/");
    expect(tree.children).toHaveLength(3);
    expect(snap.stats.domWalkEntries).toBe(3);
    // every leaf got a ref minted through the shared registry
    expect(tree.children.every((c) => typeof c.ref === "string" && c.ref.length > 0)).toBe(true);
    // the find-ranking signal (testId) survives the transport
    const go = tree.children.find((c) => c.testId === "go");
    expect(go?.role).toBe("button");
    expect(go?.name).toBe("Go now");
    // a DOM-sourced warning is surfaced (no CDP a11y tree on Safari)
    expect(snap.warnings.join(" ")).toMatch(/DOM-walk-sourced/);
  });

  it("mints stable refs across two snapshots (same key → same ref)", async () => {
    const sub = new SafariClassicSnapshotSubstrate(mockIO());
    const refs = new RefRegistry();
    const first = await sub.compose(refs, ["data-testid", "data-test"]);
    const second = await sub.compose(refs, ["data-testid", "data-test"]);
    const firstGo = nn(first.tree).children.find((c) => c.testId === "go");
    const secondGo = nn(second.tree).children.find((c) => c.testId === "go");
    expect(secondGo?.ref).toBe(firstGo?.ref);
  });

  it("a11yTree returns the same WebArea root without find warnings", async () => {
    const sub = new SafariClassicSnapshotSubstrate(mockIO());
    const tree = await sub.a11yTree(new RefRegistry(), ["data-testid"]);
    expect(tree?.role).toBe("WebArea");
    expect(tree?.children).toHaveLength(3);
  });

  it("degrades pierce:'closed' to open with a warning (no protocol equivalent)", async () => {
    const sub = new SafariClassicSnapshotSubstrate(mockIO());
    const snap = await sub.compose(new RefRegistry(), ["data-testid"], { pierce: "closed" });
    expect(snap.warnings.join(" ")).toMatch(/closed-shadow piercing is chromium-only/);
  });

  it("yields an empty tree (no throw) when the page has no walkable elements", async () => {
    const sub = new SafariClassicSnapshotSubstrate(mockIO([], "about:blank"));
    const snap = await sub.compose(new RefRegistry(), ["data-testid"]);
    expect(nn(snap.tree).children).toHaveLength(0);
    expect(snap.stats.domWalkEntries).toBe(0);
  });
});
