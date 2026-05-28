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
  collectUnknownHintKeys,
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

  it('rejects `integer` with a "did you mean number?" hint', () => {
    // Regression — wrightxai trial-1 turn 2 burned a full retry cycle here.
    // The validator still rejects (contract preserved); the message now
    // tells the agent the closest valid alias on the first hop.
    // @ts-expect-error — deliberately invalid
    const e = validateSchema({ type: "integer" }, "");
    expect(e).toContain('did you mean "number"?');
    expect(e).toMatch(/supported: object, array, string, number, boolean/);
  });

  it("suggests aliases for other common type typos", () => {
    // @ts-expect-error — deliberately invalid
    expect(validateSchema({ type: "bool" }, "")).toContain('did you mean "boolean"?');
    // @ts-expect-error — deliberately invalid
    expect(validateSchema({ type: "str" }, "")).toContain('did you mean "string"?');
    // @ts-expect-error — deliberately invalid
    expect(validateSchema({ type: "list" }, "")).toContain('did you mean "array"?');
    // @ts-expect-error — deliberately invalid
    expect(validateSchema({ type: "dict" }, "")).toContain('did you mean "object"?');
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

describe("collectUnknownHintKeys — wrightxai trial-1 silent-typo regression", () => {
  // Regression target: trial-1 turn 6 emitted `attribute:"href"` and
  // `transform:"int"` inside `x-browx-source`. The resolver only reads
  // `attr`, `prop`, `value`, etc., so both keys were silently dropped and
  // the `url` leaf came back as the title text (innerText default). The
  // diagnostic surfaces this on the agent's next observation so the
  // typo gets fixed without a third turn of guessing.
  it("flags `attribute` with a `attr` suggestion", () => {
    const out: string[] = [];
    collectUnknownHintKeys(
      {
        type: "string",
        "x-browx-source": { selector: "a", attribute: "href" } as never,
      },
      "url",
      out,
    );
    expect(out.length).toBe(1);
    expect(out[0]).toContain("unknown `x-browx-source` key `attribute`");
    expect(out[0]).toContain("did you mean `attr`?");
  });

  it("flags wholly-unsupported keys (transform, format) with the known-set", () => {
    const out: string[] = [];
    collectUnknownHintKeys(
      {
        type: "number",
        "x-browx-source": { selector: "span.rank", transform: "int" } as never,
      },
      "rank",
      out,
    );
    expect(out.length).toBe(1);
    expect(out[0]).toContain("unknown `x-browx-source` key `transform`");
    // No alias for `transform`; the message lists the known keys.
    expect(out[0]).toMatch(/known: query, selector, attr, prop, text, value, collection/);
  });

  it("recurses into nested properties and array items", () => {
    const out: string[] = [];
    collectUnknownHintKeys(
      {
        type: "array",
        "x-browx-source": { collection: "tr.athing.submission" },
        items: {
          type: "object",
          properties: {
            url: {
              type: "string",
              "x-browx-source": { selector: "a", attribute: "href" } as never,
            },
            rank: {
              type: "number",
              "x-browx-source": { selector: "span.rank", transform: "int" } as never,
            },
          },
        },
      },
      "",
      out,
    );
    // Two diagnostics — one per typo, both with their property path.
    expect(out.length).toBe(2);
    expect(out.some((d) => d.startsWith("[].url:"))).toBe(true);
    expect(out.some((d) => d.startsWith("[].rank:"))).toBe(true);
  });

  it("returns no diagnostics for a well-formed schema", () => {
    const out: string[] = [];
    collectUnknownHintKeys(
      {
        type: "object",
        properties: {
          price: {
            type: "string",
            "x-browx-source": { selector: ".price", attr: "data-amount" },
          },
        },
      },
      "",
      out,
    );
    expect(out).toEqual([]);
  });
});

describe("resolveAgainstTree — wrightxai trial-1 schema-discovery regressions", () => {
  // The exact schema the wrightxai agent emitted on turn 6 (trimmed to the
  // tree-side properties — `selector` paths need a real Page). Before this
  // patch, the schema would resolve, the leaf values would be partly
  // wrong (silently), and `evidence.partialMisses` would be empty — i.e.
  // no signal to the agent that anything was off. After: `partialMisses`
  // carries `attribute → attr` / `transform → ?` diagnostics on the same
  // observation that returns the data, in time for the agent to fix the
  // schema before deciding it's "good enough."
  it("emits unknown-hint-key diagnostics in partialMisses (silent-typo case)", async () => {
    seq = 0;
    const row1 = n("listitem", "row-1", [n("text", "Hello", [], { name: "Hello" })]);
    const row2 = n("listitem", "row-2", [n("text", "World", [], { name: "World" })]);
    const tree = n("WebArea", undefined, [n("list", undefined, [row1, row2])]);
    const out = await resolveAgainstTree({
      schema: {
        type: "array",
        "x-browx-source": { collection: "listitem" },
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              // Trial-1 typo: `attribute` instead of `attr`. Resolver
              // silently dropped it; we now surface a diagnostic.
              "x-browx-source": { query: "title", attribute: "href" } as never,
            },
            rank: {
              type: "number",
              // Trial-1 typo: `transform` is wholly unsupported.
              "x-browx-source": { query: "rank", transform: "int" } as never,
            },
          },
        },
      },
      page: noPage,
      scopeTree: tree,
    });
    const misses = out.evidence.partialMisses.join("\n");
    expect(misses).toContain("unknown `x-browx-source` key `attribute`");
    expect(misses).toContain("unknown `x-browx-source` key `transform`");
    expect(misses).toContain("did you mean `attr`?");
  });

  it("array-without-collection partial miss now spells out the fix", async () => {
    // Trial-1 turn 5 saw "array needs `x-browx-source.collection`" and
    // ate another turn experimenting. The message now describes what
    // `collection` is and how to provide it.
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
    const miss = out.evidence.partialMisses.find((m) => m.includes("array needs"));
    expect(miss).toBeDefined();
    expect(miss).toContain("CSS selector or NL query");
    expect(miss).toContain("per-row scope");
  });
});
