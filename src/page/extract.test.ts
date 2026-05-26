// Unit tests for the deterministic-extract primitive. The full
// `extract()` entry composes a snapshot + resolves scope, so it needs a
// live Page/CDP — those paths are exercised by `extract:keystone` against
// the real harness. These tests cover the schema validator, the tree-walk
// resolver, the coercion rules, and the failure shapes, all pure-tree so
// they run under vitest without Playwright.

import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import {
  validateSchema,
  resolveAgainstTree,
  scanTreeForBestMatch,
  coerceLeaf,
  extract,
  type ExtractSchema,
} from "./extract.js";
import type { A11yNode } from "./a11y.js";

let seq = 0;
function n(
  role: string,
  name?: string,
  children: A11yNode[] = [],
  extra: Partial<A11yNode> = {},
): A11yNode {
  return { ref: `e${++seq}`, role, name, children, ...extra };
}

/** Placeholder Page — never reached by the pure-tree tests; throws on use. */
const noPage = new Proxy({}, {
  get(_t, prop: string) {
    throw new Error(`pure-tree test must not touch page.${String(prop)}`);
  },
}) as unknown as Page;

describe("validateSchema", () => {
  it("accepts a well-formed object schema", () => {
    expect(validateSchema({ type: "object", properties: { x: { type: "string" } } }, "")).toBeNull();
  });

  it("rejects an object schema without properties", () => {
    const e = validateSchema({ type: "object" }, "");
    expect(e).toMatch(/requires `properties`/);
  });

  it("rejects an array schema without items", () => {
    const e = validateSchema({ type: "array" }, "");
    expect(e).toMatch(/requires `items`/);
  });

  it("rejects an unsupported type", () => {
    // @ts-expect-error — deliberately invalid
    const e = validateSchema({ type: "integer" }, "");
    expect(e).toMatch(/unsupported `type`/);
  });

  it("walks into nested properties", () => {
    const bad: ExtractSchema = {
      type: "object",
      properties: { inner: { type: "object" } },
    };
    expect(validateSchema(bad, "")).toMatch(/inner: object schema requires/);
  });
});

describe("scanTreeForBestMatch", () => {
  it("exact name match wins over substring", () => {
    seq = 0;
    const tree = n("WebArea", undefined, [
      n("text", "Engineering and design"),
      n("text", "Engineering"),
    ]);
    const hit = scanTreeForBestMatch(tree, "Engineering");
    expect(hit?.name).toBe("Engineering");
  });

  it("returns undefined when nothing matches", () => {
    seq = 0;
    const tree = n("WebArea", undefined, [n("text", "Design")]);
    expect(scanTreeForBestMatch(tree, "engineering")).toBeUndefined();
  });

  it("matches against testId", () => {
    seq = 0;
    const tree = n("WebArea", undefined, [
      n("text", "label", [], { testId: "price-input" }),
    ]);
    const hit = scanTreeForBestMatch(tree, "price-input");
    expect(hit?.testId).toBe("price-input");
  });
});

describe("coerceLeaf", () => {
  it("strips $ from a number string", () => {
    expect(coerceLeaf("$1,234.50", "number")).toBe(1234.5);
  });
  it("preserves an actual number", () => {
    expect(coerceLeaf(42, "number")).toBe(42);
  });
  it("returns null when a number cannot be parsed", () => {
    expect(coerceLeaf("not a number", "number")).toBeNull();
  });
  it("coerces boolean-ish strings", () => {
    expect(coerceLeaf("true", "boolean")).toBe(true);
    expect(coerceLeaf("0", "boolean")).toBe(false);
    expect(coerceLeaf("yes", "boolean")).toBe(true);
  });
  it("strings stringify non-strings", () => {
    expect(coerceLeaf(42, "string")).toBe("42");
  });
});

describe("resolveAgainstTree — implicit property-name = query rule", () => {
  it("extracts a simple object whose properties match visible names", async () => {
    seq = 0;
    // The implicit rule looks for a node whose name/testId matches the
    // property. Build a tree where each property's name is its node-name.
    const real = n("WebArea", undefined, [
      n("label", "title", [n("text", "The Headline")]),
    ]);
    // The leaf result is the matched node's own visible name. For richer
    // "title → child text" behaviour, adopters use the explicit selector hint.
    const out = await resolveAgainstTree({
      schema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
      page: noPage,
      scopeTree: real,
    });
    expect(out.data).toEqual({ title: "title" });
    expect(out.requiredMisses).toEqual([]);
    expect(out.evidence.refsUsed.length).toBeGreaterThan(0);
  });

  it("populates evidence.refsUsed with the matched node ref", async () => {
    seq = 0;
    const priceNode = n("text", "price");
    const tree = n("WebArea", undefined, [priceNode]);
    const out = await resolveAgainstTree({
      schema: { type: "object", properties: { price: { type: "string" } } },
      page: noPage,
      scopeTree: tree,
    });
    expect(out.evidence.refsUsed).toContain(priceNode.ref);
  });

  it("reports a partialMiss for an unmatched property and skips it in data", async () => {
    seq = 0;
    const tree = n("WebArea", undefined, [n("text", "price")]);
    const out = await resolveAgainstTree({
      schema: {
        type: "object",
        properties: {
          price: { type: "string" },
          phantom: { type: "string" },
        },
      },
      page: noPage,
      scopeTree: tree,
    });
    expect(out.data).toEqual({ price: "price" });
    expect(out.evidence.partialMisses).toEqual(["phantom"]);
    expect(out.requiredMisses).toEqual([]);
  });

  it("required: true raises a required-miss", async () => {
    seq = 0;
    const tree = n("WebArea", undefined, [n("text", "price")]);
    const out = await resolveAgainstTree({
      schema: {
        type: "object",
        properties: {
          phantom: { type: "string", required: true },
        },
      },
      page: noPage,
      scopeTree: tree,
    });
    expect(out.requiredMisses).toEqual(["phantom"]);
  });

  it("applies `default` when an optional miss occurs", async () => {
    seq = 0;
    const tree = n("WebArea", undefined, [n("text", "title")]);
    const out = await resolveAgainstTree({
      schema: {
        type: "object",
        properties: {
          missing: { type: "string", default: "fallback" },
        },
      },
      page: noPage,
      scopeTree: tree,
    });
    expect(out.data).toEqual({ missing: "fallback" });
  });
});

describe("resolveAgainstTree — nested schemas", () => {
  it("resolves a nested object whose inner properties' implicit queries match", async () => {
    seq = 0;
    const tree = n("WebArea", undefined, [
      n("text", "title"),
      n("text", "subtitle"),
    ]);
    const out = await resolveAgainstTree({
      schema: {
        type: "object",
        properties: {
          header: {
            type: "object",
            properties: {
              title: { type: "string" },
              subtitle: { type: "string" },
            },
          },
        },
      },
      page: noPage,
      scopeTree: tree,
    });
    expect(out.data).toEqual({ header: { title: "title", subtitle: "subtitle" } });
  });
});

describe("resolveAgainstTree — list extraction", () => {
  it("resolves an array via x-browx-source.collection (tree-scan fallback)", async () => {
    seq = 0;
    const row1 = n("listitem", "Row One", [n("text", "title", [], { name: "title" })]);
    const row2 = n("listitem", "Row Two", [n("text", "title", [], { name: "title" })]);
    const tree = n("WebArea", undefined, [n("list", undefined, [row1, row2])]);
    const out = await resolveAgainstTree({
      schema: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            "x-browx-source": { collection: "listitem" },
            items: {
              type: "object",
              properties: { title: { type: "string" } },
            },
          },
        },
      },
      page: noPage,
      scopeTree: tree,
    });
    const data = out.data as { rows: Array<{ title: string }> };
    expect(data.rows.length).toBeGreaterThanOrEqual(2);
    expect(data.rows[0]?.title).toBe("title");
  });

  it("rejects an array without a collection hint as a partial miss", async () => {
    seq = 0;
    const tree = n("WebArea", undefined, [n("listitem", "Row")]);
    const out = await resolveAgainstTree({
      schema: {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: { type: "object", properties: { title: { type: "string" } } },
          },
        },
      },
      page: noPage,
      scopeTree: tree,
    });
    expect(out.evidence.partialMisses[0]).toMatch(/array needs `x-browx-source.collection`/);
  });
});

describe("resolveAgainstTree — scoped extraction", () => {
  it("respects scopeTree (sub-tree) — siblings outside the scope are ignored", async () => {
    seq = 0;
    const insideTitle = n("text", "title");
    const outsideTitle = n("text", "title");
    const insideSub = n("section", "panel", [insideTitle]);
    // Build the full tree so refs are minted with the same numbering an
    // extract-from-snapshot path would see, then pass insideSub as the scope.
    n("WebArea", undefined, [insideSub, outsideTitle]);
    const out = await resolveAgainstTree({
      schema: { type: "object", properties: { title: { type: "string" } } },
      page: noPage,
      scopeTree: insideSub,
    });
    expect(out.data).toEqual({ title: "title" });
    expect(out.evidence.refsUsed).toContain(insideTitle.ref);
    expect(out.evidence.refsUsed).not.toContain(outsideTitle.ref);
  });
});

describe("extract() — top-level failure shapes", () => {
  // For these we don't need a real CDP — `extract` checks schema validity
  // and `mode` before touching the page, so we can pass an obviously-broken
  // `cdp`/`refs` and still exercise the early-return paths.

  const cdp = noPage as unknown as Parameters<typeof extract>[1];
  const refs = noPage as unknown as Parameters<typeof extract>[2];

  it("returns a structured failure when mode is llm-assisted (typed-but-unimplemented seam)", async () => {
    const res = await extract(noPage, cdp, refs, {
      mode: "llm-assisted",
      schema: { type: "object", properties: { x: { type: "string" } } },
      testAttributes: ["data-testid"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.kind).toBe("llm-assisted-not-implemented");
      expect(res.failure.source).toBe("browxai");
    }
    expect(res.tokensEstimate).toBeGreaterThan(0);
  });

  it("returns invalid-schema when type is unsupported", async () => {
    const res = await extract(noPage, cdp, refs, {
      // @ts-expect-error — deliberately invalid
      schema: { type: "integer" },
      testAttributes: ["data-testid"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe("invalid-schema");
  });

  it("returns invalid-schema when both ref and scope are provided", async () => {
    const res = await extract(noPage, cdp, refs, {
      schema: { type: "object", properties: { x: { type: "string" } } },
      ref: "e1",
      scope: ".x",
      testAttributes: ["data-testid"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.kind).toBe("invalid-schema");
  });
});
