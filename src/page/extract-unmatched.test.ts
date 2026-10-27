import { describe, it, expect } from "vitest";
import { resolveAgainstTree } from "./extract-resolve.js";
import type { Page } from "playwright-core";
import type { A11yNode } from "./a11y.js";

const tree: A11yNode = { ref: "e1", role: "RootWebArea", name: "Page", children: [] };

/** A page whose every selector matches zero elements. */
function emptyPage(): Page {
  const locator = {
    count: async () => 0,
    all: async () => [],
    first: () => locator,
    nth: () => locator,
    locator: () => locator,
  };
  return { locator: () => locator } as unknown as Page;
}

describe("extract unmatched selector warnings", () => {
  it("names a leaf selector that matched no element and the field using it", async () => {
    const out = await resolveAgainstTree({
      schema: {
        type: "object",
        properties: { price: { type: "string", "x-browx-source": { selector: ".price" } } },
      },
      page: emptyPage(),
      scopeTree: tree,
    });
    expect(out.warnings).toEqual(['selector ".price" matched no element (field price)']);
  });

  it("reports no warning when the schema uses no selector", async () => {
    const out = await resolveAgainstTree({
      schema: { type: "object", properties: { a: { type: "string" } } },
      page: emptyPage(),
      scopeTree: tree,
    });
    expect(out.warnings).toEqual([]);
  });
});
