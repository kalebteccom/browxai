/// <reference lib="dom" />
import { describe, it, expect } from "vitest";
import {
  detectOverflow,
  synthesiseSelector,
  applyLimit,
  resolveTypes,
  overflows,
  type OverflowDetectPage,
  type MinimalElement,
} from "./overflow-detect.js";

interface PageRawFinding {
  selector: string;
  selectorTruncated: boolean;
  selectorOriginalLength: number;
  bbox: { x: number; y: number; w: number; h: number } | null;
  type: "layout" | "clipped" | "text-ellipsis" | "viewport-horizontal";
  evidence: Record<string, unknown>;
}

interface PageRawResult {
  findings: PageRawFinding[];
  scanCapped: boolean;
}

function fakePage(result: PageRawResult, capture?: { args?: unknown }): OverflowDetectPage {
  return {
    async evaluate<T, Arg>(_fn: (arg: Arg) => T | Promise<T>, a?: Arg): Promise<T> {
      if (capture) capture.args = a;
      return result as unknown as T;
    },
  };
}

describe("synthesiseSelector — selector tiers", () => {
  const bare = {
    testId: null,
    role: null,
    ariaLabel: null,
    classList: [] as string[],
  };

  it.each([
    [
      "tier 1: data-testid wins everything",
      {
        tagName: "BUTTON",
        testId: "save-btn",
        role: "button",
        ariaLabel: "Save",
        classList: ["btn", "primary"],
      },
      '[data-testid="save-btn"]',
    ],
    [
      "tier 2: role + accessible name when no testid",
      {
        tagName: "DIV",
        testId: null,
        role: "navigation",
        ariaLabel: "Main",
        classList: ["nav"],
      },
      '[role="navigation"][aria-label="Main"]',
    ],
    [
      "tier 3: nth-of-type CSS path bounded at 5 levels",
      {
        tagName: "SPAN",
        ...bare,
        nthOfType: 2,
        parentChain: [
          { tagName: "DIV", nthOfType: 1 },
          { tagName: "MAIN", nthOfType: 1 },
        ],
      },
      "main:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(2)",
    ],
    [
      "tier 4: tag.classes when no testid/role+name/parentChain, up to 3 classes",
      { tagName: "DIV", ...bare, classList: ["a", "b", "c", "d", "e"] },
      "div.a.b.c",
    ],
    ["falls through to bare tag when nothing distinguishing", { tagName: "DIV", ...bare }, "div"],
    [
      "escapes embedded double-quotes in testId values",
      { tagName: "DIV", ...bare, testId: 'evil"id' },
      '[data-testid="evil\\"id"]',
    ],
  ] as Array<[string, MinimalElement, string]>)("synthesiseSelector %s", (_name, el, selector) => {
    const s = synthesiseSelector(el);
    expect(s.selector).toBe(selector);
    expect(s.truncated).toBe(false);
  });

  it("tier 3: caps at 5 levels of chain", () => {
    const chain = Array.from({ length: 10 }, (_, i) => ({
      tagName: "DIV",
      nthOfType: i + 1,
    }));
    const el: MinimalElement = {
      tagName: "P",
      testId: null,
      role: null,
      ariaLabel: null,
      classList: [],
      nthOfType: 3,
      parentChain: chain,
    };
    const s = synthesiseSelector(el);
    // 5 ancestor levels capped + self = 6 segments
    expect(s.selector.split(" > ").length).toBe(6);
    expect(s.selector.endsWith("p:nth-of-type(3)")).toBe(true);
  });

  it("caps at 200 chars — falls back to tag-only + flags truncation", () => {
    const big = "x".repeat(500);
    const el: MinimalElement = {
      tagName: "SECTION",
      testId: big,
      role: null,
      ariaLabel: null,
      classList: [],
    };
    const s = synthesiseSelector(el);
    expect(s.truncated).toBe(true);
    expect(s.selector).toBe("section");
    expect(s.originalLength).toBeGreaterThan(200);
  });
});

describe("EPSILON math — overflows()", () => {
  it.each([
    ["sub-pixel difference does not trip (100.5 vs 100)", 100.5, 100, undefined, false],
    ["a difference of exactly 1 does not trip", 101, 100, undefined, false],
    ["custom epsilon honoured above the bound", 105, 100, 4, true],
    ["custom epsilon honoured at the bound", 104, 100, 4, false],
  ])("overflows: %s", (_name, scroll, client, epsilon, expected) => {
    expect(
      epsilon === undefined ? overflows(scroll, client) : overflows(scroll, client, epsilon),
    ).toBe(expected);
  });
});

describe("type filter — resolveTypes()", () => {
  const all = ["layout", "clipped", "text-ellipsis", "viewport-horizontal"];
  it.each([
    ["undefined → all four", undefined, all],
    ["subset preserved", ["clipped", "text-ellipsis"], ["clipped", "text-ellipsis"]],
    ["all-unknown falls back to all four (don't silently match nothing)", ["totally-bogus"], all],
  ])("resolveTypes: %s", (_name, input, expected) => {
    const s = resolveTypes(input as unknown as Parameters<typeof resolveTypes>[0]);
    expect([...s].sort()).toEqual([...expected].sort());
  });
});

describe("limit handling — applyLimit()", () => {
  it("equals cap → still not truncated", () => {
    const r = applyLimit([1, 2, 3], 3);
    expect(r.kept.length).toBe(3);
    expect(r.truncated).toBe(false);
  });
});

describe("detectOverflow — runner integration with fake page", () => {
  it("threads scope/types/limit/epsilon into the page-side arg", async () => {
    const captured: { args?: unknown } = {};
    const page = fakePage({ findings: [], scanCapped: false }, captured);
    await detectOverflow(page, { scope: "viewport", types: ["clipped"], limit: 25 });
    const a = captured.args as {
      types: string[];
      scope: string;
      maxElements: number;
      epsilon: number;
      selectorMaxLen: number;
    };
    expect(a.scope).toBe("viewport");
    expect(a.types).toEqual(["clipped"]);
    expect(a.maxElements).toBe(10000);
    expect(a.epsilon).toBe(1);
    expect(a.selectorMaxLen).toBe(200);
  });

  it("defaults: scope=document, all types, limit=50", async () => {
    const captured: { args?: unknown } = {};
    const page = fakePage({ findings: [], scanCapped: false }, captured);
    const r = await detectOverflow(page, {});
    expect(r.scope).toBe("document");
    const a = captured.args as { types: string[]; scope: string };
    expect(a.scope).toBe("document");
    expect(a.types.length).toBe(4);
  });

  it("clamps limit > 500 to 500", async () => {
    const findings = Array.from({ length: 600 }, (_, i) => ({
      selector: `div.x${i}`,
      selectorTruncated: false,
      selectorOriginalLength: 5,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      type: "layout" as const,
      evidence: {
        scrollWidth: 100,
        clientWidth: 50,
        scrollHeight: 50,
        clientHeight: 50,
        overflowX: "auto",
        overflowY: "visible",
      },
    }));
    const page = fakePage({ findings, scanCapped: false });
    const r = await detectOverflow(page, { limit: 10_000 });
    expect(r.findings.length).toBe(500);
    expect(r.truncated).toBe(true);
  });

  it("rejects limit <= 0 with a usage error", async () => {
    const page = fakePage({ findings: [], scanCapped: false });
    await expect(detectOverflow(page, { limit: 0 })).rejects.toThrow(/limit must be > 0/);
  });

  it("surfaces the MAX_ELEMENTS_SCANNED warning when the walker capped", async () => {
    const page = fakePage({ findings: [], scanCapped: true });
    const r = await detectOverflow(page, {});
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain("MAX_ELEMENTS_SCANNED");
    expect(r.warnings[0]).toContain("10000");
    expect(r.warnings[0]).toContain("scope:viewport");
  });

  it("folds selectorTruncated into evidence", async () => {
    const page = fakePage({
      findings: [
        {
          selector: "div",
          selectorTruncated: true,
          selectorOriginalLength: 350,
          bbox: { x: 0, y: 0, w: 100, h: 100 },
          type: "clipped",
          evidence: {
            scrollWidth: 300,
            clientWidth: 100,
            scrollHeight: 100,
            clientHeight: 100,
            overflowX: "hidden",
            overflowY: "visible",
          },
        },
      ],
      scanCapped: false,
    });
    const r = await detectOverflow(page, {});
    expect(r.findings.length).toBe(1);
    const ev = r.findings[0]!.evidence as { selectorTruncated?: true; originalLength?: number };
    expect(ev.selectorTruncated).toBe(true);
    expect(ev.originalLength).toBe(350);
  });
});
