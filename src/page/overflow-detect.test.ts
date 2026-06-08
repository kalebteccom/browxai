/// <reference lib="dom" />
import { describe, it, expect } from "vitest";
import {
  detectOverflow,
  synthesiseSelector,
  applyLimit,
  resolveTypes,
  overflows,
  OVERFLOW_EPSILON,
  type OverflowDetectPage,
  type MinimalElement,
  type OverflowFinding,
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

function fakePage(
  result: PageRawResult,
  capture?: { args?: unknown },
): OverflowDetectPage {
  return {
    async evaluate<T, Arg>(_fn: (arg: Arg) => T | Promise<T>, a?: Arg): Promise<T> {
      if (capture) capture.args = a;
      return result as unknown as T;
    },
  };
}

describe("synthesiseSelector — selector tiers", () => {
  it("tier 1: data-testid wins everything", () => {
    const el: MinimalElement = {
      tagName: "BUTTON",
      testId: "save-btn",
      role: "button",
      ariaLabel: "Save",
      classList: ["btn", "primary"],
    };
    const s = synthesiseSelector(el);
    expect(s.selector).toBe('[data-testid="save-btn"]');
    expect(s.truncated).toBe(false);
  });

  it("tier 2: role + accessible name when no testid", () => {
    const el: MinimalElement = {
      tagName: "DIV",
      testId: null,
      role: "navigation",
      ariaLabel: "Main",
      classList: ["nav"],
    };
    const s = synthesiseSelector(el);
    expect(s.selector).toBe('[role="navigation"][aria-label="Main"]');
  });

  it("tier 3: nth-of-type CSS path bounded at 5 levels", () => {
    const el: MinimalElement = {
      tagName: "SPAN",
      testId: null,
      role: null,
      ariaLabel: null,
      classList: [],
      nthOfType: 2,
      parentChain: [
        { tagName: "DIV", nthOfType: 1 },
        { tagName: "MAIN", nthOfType: 1 },
      ],
    };
    const s = synthesiseSelector(el);
    expect(s.selector).toBe(
      "main:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(2)",
    );
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

  it("tier 4: tag.classes when no testid/role+name/parentChain — up to 3 classes", () => {
    const el: MinimalElement = {
      tagName: "DIV",
      testId: null,
      role: null,
      ariaLabel: null,
      classList: ["a", "b", "c", "d", "e"],
    };
    const s = synthesiseSelector(el);
    expect(s.selector).toBe("div.a.b.c");
  });

  it("falls through to bare tag when nothing distinguishing", () => {
    const el: MinimalElement = {
      tagName: "DIV",
      testId: null,
      role: null,
      ariaLabel: null,
      classList: [],
    };
    const s = synthesiseSelector(el);
    expect(s.selector).toBe("div");
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

  it("escapes embedded double-quotes in testId values", () => {
    const el: MinimalElement = {
      tagName: "DIV",
      testId: 'evil"id',
      role: null,
      ariaLabel: null,
      classList: [],
    };
    const s = synthesiseSelector(el);
    expect(s.selector).toBe('[data-testid="evil\\"id"]');
  });
});

describe("EPSILON math — overflows()", () => {
  it("OVERFLOW_EPSILON is 1 px (sub-pixel-noise tolerance)", () => {
    expect(OVERFLOW_EPSILON).toBe(1);
  });

  it("equal dims do not trip", () => {
    expect(overflows(100, 100)).toBe(false);
  });

  it("sub-pixel difference does not trip (within epsilon)", () => {
    expect(overflows(100.5, 100)).toBe(false);
    expect(overflows(101, 100)).toBe(false);
  });

  it("> EPSILON difference trips", () => {
    expect(overflows(101.5, 100)).toBe(true);
    expect(overflows(200, 100)).toBe(true);
  });

  it("custom epsilon honoured", () => {
    expect(overflows(105, 100, 4)).toBe(true);
    expect(overflows(104, 100, 4)).toBe(false);
  });
});

describe("type filter — resolveTypes()", () => {
  it("undefined → all four", () => {
    const s = resolveTypes(undefined);
    expect(s.size).toBe(4);
    expect(s.has("layout")).toBe(true);
    expect(s.has("clipped")).toBe(true);
    expect(s.has("text-ellipsis")).toBe(true);
    expect(s.has("viewport-horizontal")).toBe(true);
  });

  it("empty array → all four (an empty filter is treated as default)", () => {
    const s = resolveTypes([]);
    expect(s.size).toBe(4);
  });

  it("subset preserved", () => {
    const s = resolveTypes(["clipped", "text-ellipsis"]);
    expect(s.size).toBe(2);
    expect(s.has("clipped")).toBe(true);
    expect(s.has("text-ellipsis")).toBe(true);
    expect(s.has("layout")).toBe(false);
  });

  it("unknown values dropped silently", () => {
    const s = resolveTypes(["clipped", "bogus" as unknown as "clipped"]);
    expect(s.size).toBe(1);
    expect(s.has("clipped")).toBe(true);
  });

  it("all-unknown falls back to all four (don't silently match nothing)", () => {
    const s = resolveTypes(["totally-bogus" as unknown as "clipped"]);
    expect(s.size).toBe(4);
  });
});

describe("limit handling — applyLimit()", () => {
  it("returns all when under cap, truncated:false", () => {
    const arr = [1, 2, 3];
    const r = applyLimit(arr, 50);
    expect(r.kept.length).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("equals cap → still not truncated", () => {
    const r = applyLimit([1, 2, 3], 3);
    expect(r.kept.length).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("over cap → slice + truncated:true", () => {
    const arr = Array.from({ length: 80 }, (_, i) => i);
    const r = applyLimit(arr, 50);
    expect(r.kept.length).toBe(50);
    expect(r.truncated).toBe(true);
    expect(r.kept[0]).toBe(0);
    expect(r.kept[49]).toBe(49);
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
      evidence: { scrollWidth: 100, clientWidth: 50, scrollHeight: 50, clientHeight: 50, overflowX: "auto", overflowY: "visible" },
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

  it("returns ok:true with empty findings when the page is clean", async () => {
    const page = fakePage({ findings: [], scanCapped: false });
    const r = await detectOverflow(page, {});
    expect(r.ok).toBe(true);
    expect(r.findings.length).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.warnings.length).toBe(0);
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

  it("preserves bbox + selector + type + evidence on a clean finding", async () => {
    const raw = {
      selector: '[data-testid="ok"]',
      selectorTruncated: false,
      selectorOriginalLength: 18,
      bbox: { x: 10, y: 20, w: 100, h: 50 },
      type: "layout" as const,
      evidence: {
        scrollWidth: 200,
        clientWidth: 100,
        scrollHeight: 50,
        clientHeight: 50,
        overflowX: "auto",
        overflowY: "visible",
      },
    };
    const page = fakePage({ findings: [raw], scanCapped: false });
    const r = await detectOverflow(page, {});
    const f = r.findings[0] as OverflowFinding;
    expect(f.selector).toBe('[data-testid="ok"]');
    expect(f.bbox).toEqual({ x: 10, y: 20, w: 100, h: 50 });
    expect(f.type).toBe("layout");
    expect(f.evidence).toEqual(raw.evidence);
  });
});
