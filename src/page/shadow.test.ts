// Unit tests for the Phase-7 shadow-piercing primitives. The CDP path is
// fakeable through a stub `CDPSession` — we feed in a synthetic
// `DOM.getDocument` payload and assert the harvester produces the right
// `ShadowTreeEntry[]` / `ClosedShadowDomEntry[]` shapes.
//
// No real Playwright / Chromium here — that lives in the keystone test.

import { describe, it, expect, vi } from "vitest";
import type { CDPSession } from "playwright-core";
import {
  collectShadowTrees,
  fetchPiercedDocument,
  harvestClosedShadowElements,
  runOpenShadowWalk,
} from "./shadow.js";

// CDP-shaped DOM node literal. Helper so tests stay readable.
interface FakeNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  localName?: string;
  attributes?: string[];
  children?: FakeNode[];
  shadowRoots?: FakeNode[];
  shadowRootType?: "open" | "closed" | "user-agent";
  contentDocument?: FakeNode;
  nodeValue?: string;
}

function el(tag: string, fields: Partial<FakeNode> = {}): FakeNode {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    localName: tag,
    backendNodeId: fields.backendNodeId ?? 0,
    attributes: fields.attributes ?? [],
    children: fields.children ?? [],
    shadowRoots: fields.shadowRoots ?? [],
    ...fields,
  };
}
function text(value: string): FakeNode {
  return { nodeType: 3, nodeValue: value };
}
function shadowRoot(mode: "open" | "closed" | "user-agent", children: FakeNode[]): FakeNode {
  return {
    nodeType: 9, // DOCUMENT_FRAGMENT_NODE equivalent for CDP shadow roots
    nodeName: "#document-fragment",
    shadowRootType: mode,
    children,
  };
}

function fakeCdp(impl: { send?: (m: string, p?: unknown) => Promise<unknown> } = {}): CDPSession {
  return {
    send: vi.fn(impl.send ?? (async () => ({}))),
  } as unknown as CDPSession;
}

describe("collectShadowTrees", () => {
  it("surfaces every non-user-agent shadow host with mode + child summaries", () => {
    const tree: FakeNode = el("html", {
      backendNodeId: 1,
      children: [
        el("my-widget", {
          backendNodeId: 10,
          shadowRoots: [
            shadowRoot("open", [
              el("div", { backendNodeId: 11, children: [text("hello")] }),
              el("span", { backendNodeId: 12 }),
            ]),
          ],
        }),
        el("vid-player", {
          backendNodeId: 20,
          shadowRoots: [shadowRoot("user-agent", [el("button", { backendNodeId: 21 })])],
        }),
        el("closed-shell", {
          backendNodeId: 30,
          shadowRoots: [
            shadowRoot("closed", [el("button", { backendNodeId: 31, children: [text("Secret")] })]),
          ],
        }),
      ],
    });
    const { entries } = collectShadowTrees(tree, {});
    expect(entries).toHaveLength(2);
    const widget = entries.find((e) => e.hostTag === "my-widget");
    const closed = entries.find((e) => e.hostTag === "closed-shell");
    expect(widget?.mode).toBe("open");
    expect(widget?.children.map((c) => c.tag)).toEqual(["div", "span"]);
    expect(widget?.children[0]?.text).toBe("hello");
    expect(closed?.mode).toBe("closed");
    expect(closed?.children[0]?.text).toBe("Secret");
    // user-agent shadow root is skipped, never surfaced as a tree.
    expect(entries.some((e) => e.hostTag === "vid-player")).toBe(false);
  });

  it("scopes the walk to a single backend id when rootBackendNodeId is given", () => {
    const inner = el("inner-widget", {
      backendNodeId: 99,
      shadowRoots: [shadowRoot("open", [el("p", { backendNodeId: 100 })])],
    });
    const tree: FakeNode = el("html", {
      backendNodeId: 1,
      children: [
        el("other-widget", {
          backendNodeId: 50,
          shadowRoots: [shadowRoot("open", [el("p", { backendNodeId: 51 })])],
        }),
        el("section", { backendNodeId: 90, children: [inner] }),
      ],
    });
    const { entries } = collectShadowTrees(tree, { rootBackendNodeId: 99 });
    expect(entries.map((e) => e.hostTag)).toEqual(["inner-widget"]);
  });

  it("honours maxHosts with a cappedAt marker", () => {
    const hosts: FakeNode[] = Array.from({ length: 10 }, (_, i) =>
      el(`host-${i}`, {
        backendNodeId: 100 + i,
        shadowRoots: [shadowRoot("open", [el("span", { backendNodeId: 200 + i })])],
      }),
    );
    const tree: FakeNode = el("html", { backendNodeId: 1, children: hosts });
    const { entries, cappedAt } = collectShadowTrees(tree, { maxHosts: 3 });
    expect(entries.length).toBe(3);
    expect(cappedAt).toBe(3);
  });

  it("returns an empty list when the scope ref does not resolve", () => {
    const tree: FakeNode = el("html", {
      backendNodeId: 1,
      children: [el("my-widget", { backendNodeId: 10 })],
    });
    const { entries } = collectShadowTrees(tree, { rootBackendNodeId: 999 });
    expect(entries).toEqual([]);
  });
});

describe("fetchPiercedDocument", () => {
  it("returns the root + closedAvailable=true when a closed shadow is present", async () => {
    const root: FakeNode = el("html", {
      backendNodeId: 1,
      children: [
        el("closed-widget", {
          backendNodeId: 10,
          shadowRoots: [shadowRoot("closed", [el("button", { backendNodeId: 11 })])],
        }),
      ],
    });
    const cdp = fakeCdp({
      send: async (method, params) => {
        if (method !== "DOM.getDocument") throw new Error(`unexpected ${method}`);
        expect((params as { pierce: boolean }).pierce).toBe(true);
        return { root };
      },
    });
    const r = await fetchPiercedDocument(cdp);
    expect(r.root).toBe(root);
    expect(r.closedAvailable).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("returns null + warning when CDP refuses pierce", async () => {
    const cdp = fakeCdp({
      send: async () => {
        throw new Error("DOM.getDocument: pierce parameter unsupported");
      },
    });
    const r = await fetchPiercedDocument(cdp);
    expect(r.root).toBeNull();
    expect(r.closedAvailable).toBe(false);
    expect(r.warning).toContain("closed-shadow piercing unavailable");
  });

  it("returns root + closedAvailable=false when only open shadow is present", async () => {
    const root: FakeNode = el("html", {
      backendNodeId: 1,
      children: [
        el("open-widget", {
          backendNodeId: 10,
          shadowRoots: [shadowRoot("open", [el("p", { backendNodeId: 11 })])],
        }),
      ],
    });
    const cdp = fakeCdp({ send: async () => ({ root }) });
    const r = await fetchPiercedDocument(cdp);
    expect(r.closedAvailable).toBe(false);
  });
});

describe("harvestClosedShadowElements", () => {
  it("surfaces interactive + test-attr-bearing elements behind closed shadow only", async () => {
    const root: FakeNode = el("html", {
      backendNodeId: 1,
      children: [
        el("open-widget", {
          backendNodeId: 10,
          shadowRoots: [
            shadowRoot("open", [
              // Element inside OPEN shadow — must NOT appear in the
              // closed-shadow harvest (the page-side dom-walk covers it).
              el("button", {
                attributes: ["data-testid", "open-btn"],
                backendNodeId: 11,
              }),
            ]),
          ],
        }),
        el("closed-widget", {
          backendNodeId: 20,
          shadowRoots: [
            shadowRoot("closed", [
              el("button", {
                attributes: ["data-testid", "closed-btn", "aria-label", "Press me"],
                backendNodeId: 21,
              }),
              el("div", {
                attributes: ["role", "tab"],
                backendNodeId: 22,
              }),
              el("p", {
                // bare paragraph — no role / interactive tag / test attr →
                // must be skipped to keep the harvest signal-to-noise high.
                backendNodeId: 23,
              }),
            ]),
          ],
        }),
      ],
    });
    const cdp = fakeCdp({ send: async () => ({ root }) });
    const r = await harvestClosedShadowElements(cdp, ["data-testid", "data-test"], 100);
    expect(r.warning).toBeUndefined();
    expect(r.entries).toHaveLength(2);
    const btn = r.entries.find((e) => e.testId === "closed-btn");
    expect(btn?.closedShadow).toBe(true);
    expect(btn?.testIdAttr).toBe("data-testid");
    expect(btn?.name).toBe("Press me");
    expect(btn?.role).toBe("button");
    const tab = r.entries.find((e) => e.role === "tab");
    expect(tab).toBeTruthy();
    expect(tab?.closedShadow).toBe(true);
    // Open-shadow button must not leak into the closed-only harvest.
    expect(r.entries.some((e) => e.testId === "open-btn")).toBe(false);
  });

  it("returns an empty list + warning when CDP refuses pierce", async () => {
    const cdp = fakeCdp({
      send: async () => {
        throw new Error("nope");
      },
    });
    const r = await harvestClosedShadowElements(cdp, ["data-testid"], 100);
    expect(r.entries).toEqual([]);
    expect(r.warning).toContain("closed-shadow piercing unavailable");
  });
});

describe("runOpenShadowWalk", () => {
  it("evaluates the page-side walker and forwards its trees", async () => {
    let seenMethod = "";
    let seenExpr = "";
    const cdp = fakeCdp({
      send: async (method, params) => {
        seenMethod = method;
        seenExpr = (params as { expression: string }).expression;
        return {
          result: {
            value: {
              trees: [
                {
                  hostTag: "my-widget",
                  mode: "open",
                  children: [{ tag: "div", childCount: 0 }],
                  descendantCount: 1,
                },
              ],
            },
          },
        };
      },
    });
    const trees = await runOpenShadowWalk(cdp, undefined, 50);
    expect(seenMethod).toBe("Runtime.evaluate");
    // Signature marker — the page-side walker is a function literal that
    // accepts (rootSel, max) and walks `Element.shadowRoot` recursively.
    expect(seenExpr).toContain("shadowRoot");
    expect(trees).toHaveLength(1);
    expect(trees[0]?.hostTag).toBe("my-widget");
  });

  it("returns an empty list when CDP throws", async () => {
    const cdp = fakeCdp({
      send: async () => {
        throw new Error("evaluation failed");
      },
    });
    const trees = await runOpenShadowWalk(cdp, undefined, 50);
    expect(trees).toEqual([]);
  });
});
