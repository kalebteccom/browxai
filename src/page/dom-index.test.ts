// DomIndex — the one `DOM.getDocument` sweep the two snapshot tiers join on.
//
// The join's whole value is that it is exact, so the tests that matter are the
// refusals: a path no element holds, and a path whose element disagrees with
// the walk about its own `id` or test attribute. Each must answer `undefined`,
// which leaves the caller to keep two separate nodes.
//
// The DOM is faked here. `test/keystone/snapshot-tier-dedup.keystone.test.ts`
// is the pass against real Chromium, where the `:nth-child` path is the live
// document's rather than this file's idea of one.

import { describe, it, expect, vi } from "vitest";
import type { CDPSession } from "playwright-core";
import { buildDomIndex, EMPTY_DOM_INDEX } from "./dom-index.js";

interface FakeNode {
  nodeType: number;
  localName?: string;
  nodeName?: string;
  backendNodeId?: number;
  attributes?: string[];
  children?: FakeNode[];
  shadowRoots?: FakeNode[];
}

function el(
  localName: string,
  backendNodeId: number,
  attributes: string[] = [],
  children: FakeNode[] = [],
): FakeNode {
  return {
    nodeType: 1,
    localName,
    nodeName: localName.toUpperCase(),
    backendNodeId,
    attributes,
    children,
  };
}

function text(): FakeNode {
  return { nodeType: 3, nodeName: "#text", backendNodeId: 900 };
}

function docWith(body: FakeNode[]): FakeNode {
  return {
    nodeType: 9,
    nodeName: "#document",
    backendNodeId: 1,
    children: [el("html", 2, [], [el("head", 3), { ...el("body", 4), children: body }])],
  };
}

function cdpReturning(root: FakeNode | Error): CDPSession {
  return {
    send: vi.fn(async (method: string) => {
      if (method !== "DOM.getDocument") throw new Error(`unexpected CDP method ${method}`);
      if (root instanceof Error) throw root;
      return { root };
    }),
  } as unknown as CDPSession;
}

const CLEAN = { id: "", testId: "", testIdAttr: "" };
const ATTRS = ["data-testid", "data-test"];

describe("buildDomIndex — the path the DOM walk speaks", () => {
  it("keys elements by the same `:nth-child` chain the page walk builds", async () => {
    const index = await buildDomIndex(
      cdpReturning(docWith([el("nav", 10, [], [el("a", 11, ["href", "#x"])])])),
      ATTRS,
    );
    // The page walk stops at `<html>`, so `<body>` is `body:nth-child(2)` —
    // second element child of `<html>`, after `<head>`.
    expect(index.backendIdFor("body:nth-child(2)", CLEAN)).toBe(4);
    expect(index.backendIdFor("body:nth-child(2) > nav:nth-child(1)", CLEAN)).toBe(10);
    expect(index.backendIdFor("body:nth-child(2) > nav:nth-child(1) > a:nth-child(1)", CLEAN)).toBe(
      11,
    );
  });

  it("counts element siblings only, as `Element.children` and CSS `:nth-child` do", async () => {
    // A text node between two elements must not shift the second one's index.
    const body = { ...el("body", 4), children: [el("p", 20), text(), el("button", 21)] };
    const root: FakeNode = {
      nodeType: 9,
      nodeName: "#document",
      backendNodeId: 1,
      children: [el("html", 2, [], [el("head", 3), body])],
    };
    const index = await buildDomIndex(cdpReturning(root), ATTRS);
    expect(index.backendIdFor("body:nth-child(2) > button:nth-child(2)", CLEAN)).toBe(21);
  });

  it("lowercases the tag, so a camel-cased SVG element still matches", async () => {
    // `el.tagName.toLowerCase()` on the page side; CDP preserves SVG casing.
    const svg = {
      nodeType: 1,
      localName: "linearGradient",
      nodeName: "linearGradient",
      backendNodeId: 30,
      children: [],
    };
    const index = await buildDomIndex(cdpReturning(docWith([svg])), ATTRS);
    expect(index.backendIdFor("body:nth-child(2) > lineargradient:nth-child(1)", CLEAN)).toBe(30);
  });

  it("answers undefined for a path no element holds", async () => {
    const index = await buildDomIndex(cdpReturning(docWith([el("div", 40)])), ATTRS);
    // Right index, wrong tag — the path pins the chain, not just the position.
    expect(index.backendIdFor("body:nth-child(2) > span:nth-child(1)", CLEAN)).toBeUndefined();
    // Past the end of the child list.
    expect(index.backendIdFor("body:nth-child(2) > div:nth-child(2)", CLEAN)).toBeUndefined();
    expect(index.backendIdFor("body:nth-child(2) > div:nth-child(1)", CLEAN)).toBe(40);
  });

  it("resolves nothing for anything that is not a `tag:nth-child(n)` chain", async () => {
    // Only the page walk's own path shape is an identity. A bare tag is what a
    // shadow-boundary path starts with; the rest is defence against a selector
    // arriving where a path is expected.
    const index = await buildDomIndex(cdpReturning(docWith([el("div", 40)])), ATTRS);
    for (const notAPath of ["", "div", "body > div", "*", "body:nth-child(2) > div", "#id"]) {
      expect(index.backendIdFor(notAPath, CLEAN), notAPath).toBeUndefined();
    }
  });

  it("refuses a path whose element reports a different id", async () => {
    const index = await buildDomIndex(
      cdpReturning(docWith([el("button", 50, ["id", "save"])])),
      ATTRS,
    );
    const path = "body:nth-child(2) > button:nth-child(1)";
    expect(index.backendIdFor(path, { ...CLEAN, id: "save" })).toBe(50);
    // The walk saw an element with no id at this path — a different element.
    expect(index.backendIdFor(path, CLEAN)).toBeUndefined();
    expect(index.backendIdFor(path, { ...CLEAN, id: "cancel" })).toBeUndefined();
  });

  it("refuses a path whose element reports a different test attribute", async () => {
    const index = await buildDomIndex(
      cdpReturning(docWith([el("button", 60, ["data-testid", "save"])])),
      ATTRS,
    );
    const path = "body:nth-child(2) > button:nth-child(1)";
    expect(index.backendIdFor(path, { id: "", testId: "save", testIdAttr: "data-testid" })).toBe(
      60,
    );
    expect(
      index.backendIdFor(path, { id: "", testId: "save", testIdAttr: "data-test" }),
    ).toBeUndefined();
    expect(index.backendIdFor(path, CLEAN)).toBeUndefined();
  });

  it("honours the caller's test-attribute preference order", async () => {
    const index = await buildDomIndex(
      cdpReturning(docWith([el("button", 70, ["data-test", "second", "data-testid", "first"])])),
      ATTRS,
    );
    const path = "body:nth-child(2) > button:nth-child(1)";
    expect(index.backendIdFor(path, { id: "", testId: "first", testIdAttr: "data-testid" })).toBe(
      70,
    );
  });

  it("gives sibling twins their own paths, so identical markup never collides", async () => {
    // The false-merge case the whole join has to survive: two elements with the
    // same tag, the same id-lessness and the same test attribute, differing
    // only in position.
    const index = await buildDomIndex(
      cdpReturning(
        docWith([
          el("section", 80, [], [el("button", 81, ["data-testid", "save"])]),
          el("section", 82, [], [el("button", 83, ["data-testid", "save"])]),
        ]),
      ),
      ATTRS,
    );
    const claim = { id: "", testId: "save", testIdAttr: "data-testid" };
    const first = "body:nth-child(2) > section:nth-child(1) > button:nth-child(1)";
    const second = "body:nth-child(2) > section:nth-child(2) > button:nth-child(1)";
    expect(index.backendIdFor(first, claim)).toBe(81);
    expect(index.backendIdFor(second, claim)).toBe(83);
  });

  it("reads test attributes anywhere in the swept tree, shadow roots included", async () => {
    const hosted = el("button", 91, ["data-testid", "inside-shadow"]);
    const host = { ...el("my-app", 90), shadowRoots: [{ nodeType: 11, children: [hosted] }] };
    const index = await buildDomIndex(cdpReturning(docWith([host])), ATTRS);
    expect(index.testAttrOf(91)).toEqual({ testId: "inside-shadow", testIdAttr: "data-testid" });
    // …but a shadow element is not path-addressable from this document.
    expect(index.backendIdFor("button:nth-child(1)", CLEAN)).toBeUndefined();
  });

  it("degrades to an empty index when the DOM agent refuses", async () => {
    const index = await buildDomIndex(cdpReturning(new Error("no DOM agent")), ATTRS);
    expect(index.testAttrCount).toBe(0);
    expect(index.backendIdFor("body:nth-child(2)", CLEAN)).toBeUndefined();
  });

  it("EMPTY_DOM_INDEX misses every lookup", () => {
    expect(EMPTY_DOM_INDEX.testAttrCount).toBe(0);
    expect(EMPTY_DOM_INDEX.testAttrOf(1)).toBeUndefined();
    expect(EMPTY_DOM_INDEX.backendIdFor("body:nth-child(2)", CLEAN)).toBeUndefined();
  });
});
