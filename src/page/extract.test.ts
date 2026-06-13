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
  applySchemaRelaxations,
  cloneSchema,
  extract,
  __resetLlmAssistedWarnedForTests,
  __resetExplicitNlQueryWarnedForTests,
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
const noPage = new Proxy(
  {},
  {
    get(_t, prop: string) {
      throw new Error(`pure-tree test must not touch page.${String(prop)}`);
    },
  },
) as unknown as Page;

/** Substrate stub returning an empty tree — mirrors the "the page couldn't be
 *  reached → null a11y tree" outcome the old `composeSnapshot`-throws path
 *  produced (it caught the error internally and returned `{tree:null}`). Used by
 *  the tests that exercise extract()'s post-validate, empty-snapshot branch
 *  (which surfaces as scope-not-found) without standing up a real engine. */
const emptySubstrate = {
  engine: "test",
  compose: async () => ({
    tree: null,
    stats: { a11yInteractive: 0, domWalkEntries: 0, domWalkNew: 0, domWalkCombined: 0 },
    warnings: [],
  }),
  a11yTree: async () => null,
} as unknown as Parameters<typeof extract>[1];

describe("validateSchema", () => {
  it("accepts a well-formed object schema", () => {
    expect(
      validateSchema({ type: "object", properties: { x: { type: "string" } } }, ""),
    ).toBeNull();
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
    const tree = n("WebArea", undefined, [n("text", "label", [], { testId: "price-input" })]);
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
    const real = n("WebArea", undefined, [n("label", "title", [n("text", "The Headline")])]);
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
    const tree = n("WebArea", undefined, [n("text", "title"), n("text", "subtitle")]);
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

  const cdp = emptySubstrate;
  const refs = noPage as unknown as Parameters<typeof extract>[2];

  it('retired `mode:"llm-assisted"` is tolerated — warn + fall through to deterministic (v0.3.2)', async () => {
    // Regression for R-1: wrightxai's bench agent saw `mode` in the SDK type,
    // tried `"llm-assisted"` as a fallback, and wasted LLM turns on the old
    // `kind:"llm-assisted-not-implemented"` rejection. As of v0.3.2 the arg
    // is RETIRED at the typed boundary and tolerated at runtime — passing
    // `mode:"llm-assisted"` must NOT throw, must warn once, and must produce
    // the SAME observable result as the deterministic path.
    //
    // We use the `ref + scope` early-return (an `invalid-schema` failure that
    // fires before any Page access) so the assertion runs without a real
    // CDP / Page. The point of the test is the mode-handling branch, not the
    // downstream extraction.
    const schema: ExtractSchema = {
      type: "object",
      properties: { x: { type: "string" } },
    };
    const commonOpts = {
      schema,
      ref: "e1",
      scope: ".x",
      testAttributes: ["data-testid"],
    };

    __resetLlmAssistedWarnedForTests();
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      // (a) Does NOT throw — the call resolves to a structured failure.
      const resLegacy = await extract(noPage, cdp, refs, { ...commonOpts, mode: "llm-assisted" });
      const resDeterministic = await extract(noPage, cdp, refs, { ...commonOpts });

      // (b) Warns exactly once for the legacy mode (one-shot guard), and
      //     never for the deterministic path.
      expect(warnCalls.length).toBe(1);
      const warnMsg = String(warnCalls[0]?.[0] ?? "");
      expect(warnMsg).toMatch(/RETIRED/);
      expect(warnMsg).toMatch(/llm-assisted/);
      expect(warnMsg).toMatch(/v0\.3\.2/);

      // (c) Result is whatever deterministic mode would have returned —
      //     same `ok`, same failure kind, same source.
      expect(resLegacy.ok).toBe(false);
      expect(resDeterministic.ok).toBe(false);
      if (!resLegacy.ok && !resDeterministic.ok) {
        expect(resLegacy.failure.kind).toBe(resDeterministic.failure.kind);
        expect(resLegacy.failure.kind).toBe("invalid-schema");
        expect(resLegacy.failure.source).toBe(resDeterministic.failure.source);
      }
      expect(resLegacy.tokensEstimate).toBeGreaterThan(0);

      // (d) The one-shot guard suppresses repeat warnings within a process.
      await extract(noPage, cdp, refs, { ...commonOpts, mode: "llm-assisted" });
      expect(warnCalls.length).toBe(1);
    } finally {
      console.warn = originalWarn;
      __resetLlmAssistedWarnedForTests();
    }
  });

  it("returns invalid-schema when type is genuinely unsupported (post-v0.2.3 `integer` is now auto-coerced; `null` is still rejected)", async () => {
    const res = await extract(noPage, cdp, refs, {
      schema: { type: "null" },
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

// ────────────────────────────────────────────────────────────────────────────
// v0.2.3 — Proposal A / B / D regression coverage
// ────────────────────────────────────────────────────────────────────────────

describe("applySchemaRelaxations — Proposal A: integer → number auto-coerce", () => {
  it("coerces a top-level `integer` to `number` and records an educational note", () => {
    // @ts-expect-error — caller-side `integer` is deliberately mis-typed
    const s: ExtractSchema = { type: "integer" };
    const notes: string[] = [];
    applySchemaRelaxations(s, "", notes);
    expect(s.type).toBe("number");
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("schema 'integer' coerced to 'number'");
    expect(notes[0]).toContain("forward-compat");
  });

  it("coerces `integer` inside nested object properties (one note per site)", () => {
    const s: ExtractSchema = {
      type: "object",
      properties: {
        // @ts-expect-error — deliberately invalid
        rank: { type: "integer" },
        // @ts-expect-error — deliberately invalid
        points: { type: "integer" },
        title: { type: "string" },
      },
    };
    const notes: string[] = [];
    applySchemaRelaxations(s, "", notes);
    expect(s.properties?.rank?.type).toBe("number");
    expect(s.properties?.points?.type).toBe("number");
    expect(s.properties?.title?.type).toBe("string");
    expect(notes.length).toBe(2);
    expect(notes.some((n) => n.startsWith("rank:"))).toBe(true);
    expect(notes.some((n) => n.startsWith("points:"))).toBe(true);
  });

  it("coerces `integer` inside an array's items.properties (wrightxai trial-1 turn-2 shape)", () => {
    // Pinned to the exact trial-1 turn-2 schema shape — `integer` on
    // rank/points/comments_count under a per-row items.properties.
    const s: ExtractSchema = {
      type: "array",
      "x-browx-source": { collection: "tr.athing.submission" },
      items: {
        type: "object",
        properties: {
          // @ts-expect-error — deliberately invalid
          rank: { type: "integer" },
          // @ts-expect-error — deliberately invalid
          points: { type: "integer" },
          // @ts-expect-error — deliberately invalid
          comments_count: { type: "integer" },
          title: { type: "string" },
        },
      },
    };
    const notes: string[] = [];
    applySchemaRelaxations(s, "", notes);
    expect(s.items?.properties?.rank?.type).toBe("number");
    expect(s.items?.properties?.points?.type).toBe("number");
    expect(s.items?.properties?.comments_count?.type).toBe("number");
    expect(notes.length).toBe(3);
    // Path prefix for items-of-array is `[].…` (matching collectUnknownHintKeys).
    expect(notes.every((n) => n.startsWith("[]."))).toBe(true);
  });

  it("extract() now returns ok:true on a top-level `integer` schema (flips v0.2.2's invalid-schema)", async () => {
    const cdp = emptySubstrate;
    const refs = noPage as unknown as Parameters<typeof extract>[2];
    // We can't run the full extract() against noPage (composeSnapshot would
    // throw), but the validate path is the contractual flip-point: before
    // v0.2.3 the schema was rejected with invalid-schema BEFORE composeSnapshot
    // even ran. After v0.2.3 the relaxation runs first, the validator sees
    // `number`, and the call proceeds past validate. The proxy then throws on
    // the first page.* touch — which lands as a scope-not-found (not the
    // invalid-schema we used to get). That state-shift IS the proof.
    const res = await extract(noPage, cdp, refs, {
      schema: { type: "integer" },
      testAttributes: ["data-testid"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure.kind).not.toBe("invalid-schema");
    }
  });
});

describe("applySchemaRelaxations — Proposal B: `selector` on array aliases `collection`", () => {
  it("promotes `selector` to `collection` when `collection` is absent (and drops the redundant `selector`)", () => {
    const s: ExtractSchema = {
      type: "array",
      "x-browx-source": { selector: "tr.athing" },
      items: { type: "object", properties: { title: { type: "string" } } },
    };
    const notes: string[] = [];
    applySchemaRelaxations(s, "", notes);
    expect(s["x-browx-source"]?.collection).toBe("tr.athing");
    expect(s["x-browx-source"]?.selector).toBeUndefined();
    // Pure-idiomatic alias — no partialMisses note for B by design.
    expect(notes).toEqual([]);
  });

  it("prefers `collection` when BOTH are present (collection wins, selector dropped)", () => {
    const s: ExtractSchema = {
      type: "array",
      "x-browx-source": { selector: "tr.fallback", collection: "tr.athing" },
      items: { type: "object", properties: { title: { type: "string" } } },
    };
    const notes: string[] = [];
    applySchemaRelaxations(s, "", notes);
    expect(s["x-browx-source"]?.collection).toBe("tr.athing");
    expect(s["x-browx-source"]?.selector).toBeUndefined();
  });

  it("leaves leaf-`selector` semantics untouched on non-array schemas", () => {
    const s: ExtractSchema = {
      type: "object",
      properties: {
        price: {
          type: "string",
          "x-browx-source": { selector: ".price" },
        },
      },
    };
    const notes: string[] = [];
    applySchemaRelaxations(s, "", notes);
    // Leaf selector preserved — only ARRAY selectors are aliased.
    expect(s.properties?.price?.["x-browx-source"]?.selector).toBe(".price");
    expect(s.properties?.price?.["x-browx-source"]?.collection).toBeUndefined();
  });

  it("integration: resolveAgainstTree treats array `selector` as `collection` end-to-end", async () => {
    // Take the already-passing tree-scan collection test and swap `collection`
    // for `selector` — same data should come out.
    seq = 0;
    const row1 = n("listitem", "row-1", [n("text", "Alpha")]);
    const row2 = n("listitem", "row-2", [n("text", "Beta")]);
    const tree = n("WebArea", undefined, [n("list", undefined, [row1, row2])]);
    // Pre-apply the relaxation pass (resolveAgainstTree itself doesn't, but
    // the extract() entry does — this test pins the resolver-level shape).
    const schema: ExtractSchema = {
      type: "array",
      "x-browx-source": { selector: "listitem" },
      items: { type: "object", properties: { title: { type: "string" } } },
    };
    applySchemaRelaxations(schema, "", []);
    expect(schema["x-browx-source"]?.collection).toBe("listitem");
    const out = await resolveAgainstTree({ schema, page: noPage, scopeTree: tree });
    expect(Array.isArray(out.data)).toBe(true);
    expect((out.data as unknown[]).length).toBe(2);
  });
});

describe("extract() — Proposal D: BROWX_EXTRACT_STRICT=1 hard-reject opt-in", () => {
  const cdp = emptySubstrate;
  const refs = noPage as unknown as Parameters<typeof extract>[2];

  it("env unset → unknown-hint-key keeps v0.2.2 partialMisses-only behavior (no rejection from this path)", async () => {
    const prev = process.env.BROWX_EXTRACT_STRICT;
    delete process.env.BROWX_EXTRACT_STRICT;
    try {
      const res = await extract(noPage, cdp, refs, {
        schema: {
          type: "string",
          "x-browx-source": { selector: "a", attribute: "href" },
        },
        testAttributes: ["data-testid"],
      });
      // Either we get past validate (and trip on noPage), or we fail later —
      // but NOT on an `invalid-schema` for the unknown-key.
      if (!res.ok) {
        if (res.failure.kind === "invalid-schema") {
          expect(String(res.failure.actual)).not.toContain("unknown `x-browx-source` key");
        }
      }
    } finally {
      if (prev !== undefined) process.env.BROWX_EXTRACT_STRICT = prev;
    }
  });

  it("env set → unknown-hint-key becomes a hard `invalid-schema` rejection", async () => {
    const prev = process.env.BROWX_EXTRACT_STRICT;
    process.env.BROWX_EXTRACT_STRICT = "1";
    try {
      const res = await extract(noPage, cdp, refs, {
        schema: {
          type: "string",
          "x-browx-source": { selector: "a", attribute: "href" },
        },
        testAttributes: ["data-testid"],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.failure.kind).toBe("invalid-schema");
        expect(String(res.failure.actual)).toContain("unknown `x-browx-source` key `attribute`");
        expect(res.failure.source).toBe("browxai");
      }
    } finally {
      if (prev !== undefined) process.env.BROWX_EXTRACT_STRICT = prev;
      else delete process.env.BROWX_EXTRACT_STRICT;
    }
  });

  it("call-arg `strictUnknownHintKeys:true` works without needing the env var", async () => {
    const prev = process.env.BROWX_EXTRACT_STRICT;
    delete process.env.BROWX_EXTRACT_STRICT;
    try {
      const res = await extract(noPage, cdp, refs, {
        schema: {
          type: "string",
          "x-browx-source": { selector: "a", attribute: "href" },
        },
        testAttributes: ["data-testid"],
        strictUnknownHintKeys: true,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.failure.kind).toBe("invalid-schema");
        expect(String(res.failure.actual)).toContain("`attribute`");
      }
    } finally {
      if (prev !== undefined) process.env.BROWX_EXTRACT_STRICT = prev;
    }
  });

  it("strict mode does NOT promote integer-coerce notes (educational, not typo-like)", async () => {
    const prev = process.env.BROWX_EXTRACT_STRICT;
    process.env.BROWX_EXTRACT_STRICT = "1";
    try {
      const res = await extract(noPage, cdp, refs, {
        schema: { type: "integer" },
        testAttributes: ["data-testid"],
      });
      // The coerce runs before validate; the unknown-key check finds nothing
      // to reject on (no x-browx-source). The call gets past the strict check
      // and trips on the noPage proxy later — NOT an invalid-schema.
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.failure.kind).not.toBe("invalid-schema");
      }
    } finally {
      if (prev !== undefined) process.env.BROWX_EXTRACT_STRICT = prev;
      else delete process.env.BROWX_EXTRACT_STRICT;
    }
  });

  it("strict mode does NOT promote selector-as-collection alias notes (idiomatic)", async () => {
    const prev = process.env.BROWX_EXTRACT_STRICT;
    process.env.BROWX_EXTRACT_STRICT = "1";
    try {
      const res = await extract(noPage, cdp, refs, {
        schema: {
          type: "array",
          // selector-on-array — aliased to collection, NOT a typo.
          "x-browx-source": { selector: "tr.athing" },
          items: { type: "object", properties: { title: { type: "string" } } },
        },
        testAttributes: ["data-testid"],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.failure.kind).not.toBe("invalid-schema");
      }
    } finally {
      if (prev !== undefined) process.env.BROWX_EXTRACT_STRICT = prev;
      else delete process.env.BROWX_EXTRACT_STRICT;
    }
  });
});

describe("resolveAgainstTree — RETIRED `x-browx-source.query` per-field hint (R-5, v0.3.3)", () => {
  it("tolerates an explicit per-field `query:` — warns once + records a partialMisses entry naming the field", async () => {
    // Regression for R-5: wrightxai's smoke trial saw the LLM author a
    // prose-style `x-browx-source.query` for a per-row numeric field on
    // Hacker News and the resolver returned null for every row with no
    // partialMiss surfaced (one stale ref re-used across 30 row scopes —
    // the agent burned 14 revisions before the judge rejected it).
    //
    // Post-R-5 contract: passing an explicit per-field `query:` must NOT
    // throw, must warn ONCE per process (one-shot guard), and MUST emit a
    // partialMisses entry for each field that uses it so the diagnostic
    // surfaces in `evidence` — the caller / authoring LLM now sees the
    // actionable signal on the FIRST turn instead of burning N revisions.
    //
    // The implicit "property-name = query" lowering path is unchanged
    // (a separate assertion below pins this).
    seq = 0;
    const tree = n("WebArea", undefined, [n("text", "Some Text", [], { name: "Some Text" })]);

    __resetExplicitNlQueryWarnedForTests();
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      // (a) Does NOT throw — the call resolves normally.
      const out = await resolveAgainstTree({
        schema: {
          type: "object",
          properties: {
            comments_count: {
              type: "number",
              "x-browx-source": { query: "the number of comments on this story" },
            },
          },
        },
        page: noPage,
        scopeTree: tree,
      });

      // (b) Warns exactly once — process-scoped one-shot guard.
      expect(warnCalls.length).toBe(1);
      const warnMsg = String(warnCalls[0]?.[0] ?? "");
      expect(warnMsg).toMatch(/RETIRED/);
      expect(warnMsg).toMatch(/v0\.3\.3/);
      expect(warnMsg).toMatch(/x-browx-source\.selector/);

      // (c) partialMisses carries an entry naming the field, with the
      //     RETIRED diagnostic and the migration hint — the actionable
      //     signal the bench agent needed on turn 1.
      const retired = out.evidence.partialMisses.filter((m) =>
        /`x-browx-source\.query` is RETIRED/.test(m),
      );
      expect(retired.length).toBe(1);
      expect(retired[0]).toMatch(/comments_count/);
      expect(retired[0]).toMatch(/selector/);

      // (d) One-shot guard suppresses repeat warnings on subsequent calls.
      await resolveAgainstTree({
        schema: {
          type: "object",
          properties: {
            other: {
              type: "string",
              "x-browx-source": { query: "another prose query" },
            },
          },
        },
        page: noPage,
        scopeTree: tree,
      });
      expect(warnCalls.length).toBe(1);
    } finally {
      console.warn = originalWarn;
      __resetExplicitNlQueryWarnedForTests();
    }
  });

  it("implicit property-name lowering is UNAFFECTED — no warn, no RETIRED partialMisses entry", async () => {
    // The implicit "property-name = query" path internally stamps
    // `{ query: <name> }` on the hint, but it carries a private marker
    // so the resolver knows it's the implicit lowering (not a
    // user-authored prose query). This test pins that the implicit path
    // still works on testid-rich pages without firing the R-5 warning.
    seq = 0;
    const tree = n("WebArea", undefined, [n("text", "title", [], { name: "title" })]);

    __resetExplicitNlQueryWarnedForTests();
    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args);
    };
    try {
      const out = await resolveAgainstTree({
        schema: {
          type: "object",
          properties: {
            // No x-browx-source — implicit lowering applies.
            title: { type: "string" },
          },
        },
        page: noPage,
        scopeTree: tree,
      });

      // (a) No RETIRED warn fires for the implicit path.
      const retiredWarns = warnCalls.filter((c) =>
        String(c[0] ?? "").includes("`x-browx-source.query` is RETIRED"),
      );
      expect(retiredWarns.length).toBe(0);

      // (b) No RETIRED partialMisses entry — only the implicit-name path
      //     fed the tree-scan, not an explicit user query.
      const retiredMisses = out.evidence.partialMisses.filter((m) =>
        /`x-browx-source\.query` is RETIRED/.test(m),
      );
      expect(retiredMisses.length).toBe(0);

      // (c) Implicit lowering still resolves the value.
      expect((out.data as { title: string }).title).toBe("title");
    } finally {
      console.warn = originalWarn;
      __resetExplicitNlQueryWarnedForTests();
    }
  });
});

describe("cloneSchema — caller-supplied schema must not be mutated", () => {
  it("deep-clones so applySchemaRelaxations on the clone leaves the original intact", () => {
    const orig: ExtractSchema = {
      type: "object",
      properties: {
        // @ts-expect-error — deliberately invalid
        rank: { type: "integer" },
      },
    };
    const clone = cloneSchema(orig);
    applySchemaRelaxations(clone, "", []);
    expect(clone.properties?.rank?.type).toBe("number");
    // Caller's reference unchanged.
    expect(orig.properties?.rank?.type).toBe("integer");
  });
});
