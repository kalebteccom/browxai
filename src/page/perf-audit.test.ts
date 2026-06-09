import { describe, it, expect } from "vitest";
import {
  ALL_AUDIT_CATEGORIES,
  resolveCategories,
  composeReport,
  enforceSummaryBudget,
  analyseRenderBlocking,
  analyseUnusedCode,
  analyseOversizeImages,
  analyseLayoutThrashing,
  analyseLongTasks,
  analyseLeakSuspects,
  analyseCacheOpportunities,
  analyseFontLoading,
  type AuditContext,
  type AuditReport,
  type AuditIssue,
} from "./perf-audit.js";
import { estimateTokens } from "../util/tokens.js";

describe("resolveCategories", () => {
  it("defaults to all 8 categories when empty/undefined", () => {
    expect(resolveCategories()).toEqual(ALL_AUDIT_CATEGORIES);
    expect(resolveCategories([])).toEqual(ALL_AUDIT_CATEGORIES);
  });

  it("filters to known categories", () => {
    expect(resolveCategories(["long-tasks", "unused-code", "fake"])).toEqual([
      "long-tasks",
      "unused-code",
    ]);
  });

  it("falls back to all when no valid categories survive the filter", () => {
    expect(resolveCategories(["unknown1", "unknown2"])).toEqual(ALL_AUDIT_CATEGORIES);
  });
});

describe("category analysers — fixture traces", () => {
  it("render-blocking flags VeryHigh-priority blocking resources before firstPaint", () => {
    const trace = [
      {
        name: "ResourceSendRequest",
        ts: 100,
        args: {
          data: { url: "https://x/a.css", priority: "VeryHigh", renderBlocking: "blocking" },
        },
      },
      { name: "firstPaint", ts: 500 },
      {
        name: "ResourceSendRequest",
        ts: 1000,
        args: { data: { url: "https://x/late.js", priority: "VeryHigh" } },
      },
    ];
    const r = analyseRenderBlocking({ trace });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.title).toContain("a.css");
    expect(r.issues[0]!.severity).toBe("high");
    expect(r.remediations[0]!.action).toContain("CSS");
  });

  it("unused-code flags <30% usage entries above 5KB waste", () => {
    const r = analyseUnusedCode({
      trace: [],
      jsCoverage: [
        { url: "big.js", totalBytes: 100_000, usedBytes: 10_000, usagePercent: 10 },
        { url: "tiny.js", totalBytes: 2000, usedBytes: 100, usagePercent: 5 }, // dropped — under 5KB waste
        { url: "ok.js", totalBytes: 50_000, usedBytes: 40_000, usagePercent: 80 }, // skipped — >=30%
      ],
      cssCoverage: [
        {
          url: "main.css",
          totalBytes: 60_000,
          usedBytes: 5000,
          usagePercent: 8,
          usedRules: 5,
          totalRules: 50,
        },
      ],
    });
    const titles = r.issues.map((i) => i.title);
    expect(titles.some((t) => t.includes("big.js"))).toBe(true);
    expect(titles.some((t) => t.includes("main.css"))).toBe(true);
    expect(titles.some((t) => t.includes("tiny.js"))).toBe(false);
    expect(titles.some((t) => t.includes("ok.js"))).toBe(false);
  });

  it("oversize-images flags >500KB image responses", () => {
    const r = analyseOversizeImages({
      trace: [],
      responses: [
        {
          url: "https://x/hero.png",
          status: 200,
          mimeType: "image/png",
          encodedDataLength: 3_000_000,
        },
        {
          url: "https://x/small.png",
          status: 200,
          mimeType: "image/png",
          encodedDataLength: 50_000,
        },
      ],
    });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.title).toContain("hero.png");
    expect(r.issues[0]!.severity).toBe("high");
  });

  it("layout-thrashing requires >5 forced layouts", () => {
    const trace = Array.from({ length: 6 }, () => ({ name: "ForcedSyncLayout", ts: 0 }));
    const r = analyseLayoutThrashing({ trace });
    expect(r.issues).toHaveLength(1);
    const noRows = analyseLayoutThrashing({
      trace: [{ name: "ForcedSyncLayout" }, { name: "ForcedSyncLayout" }],
    });
    expect(noRows.issues).toHaveLength(0);
  });

  it("long-tasks flags RunTask >50ms", () => {
    const trace = [
      { name: "RunTask", ts: 0, dur: 250_000 }, // 250ms — high
      { name: "RunTask", ts: 0, dur: 60_000 }, // 60ms — low
      { name: "RunTask", ts: 0, dur: 30_000 }, // dropped — <50ms
    ];
    const r = analyseLongTasks({ trace });
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]!.severity).toBe("high");
  });

  it("leak-suspects reads memoryDiff with >10% growth + positive delta", () => {
    const r = analyseLeakSuspects({
      trace: [],
      memoryDiff: {
        retainerGrowth: [
          {
            node: "object:Cache",
            type: "object",
            sizeBefore: 1000,
            sizeAfter: 5000,
            deltaBytes: 4000,
            deltaPercent: 400,
          },
          {
            node: "object:Quiet",
            type: "object",
            sizeBefore: 10000,
            sizeAfter: 10500,
            deltaBytes: 500,
            deltaPercent: 5,
          },
          {
            node: "object:Shrunk",
            type: "object",
            sizeBefore: 5000,
            sizeAfter: 1000,
            deltaBytes: -4000,
            deltaPercent: -80,
          },
        ],
        summary: { totalGrowth: 4000, top3Growers: [] },
      },
    });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.title).toContain("object:Cache");
  });

  it("cache-opportunities flags static assets without Cache-Control max-age", () => {
    const r = analyseCacheOpportunities({
      trace: [],
      responses: [
        { url: "https://x/a.js", status: 200 },
        { url: "https://x/b.css", status: 200, cacheControl: "no-store" },
        { url: "https://x/cached.js", status: 200, cacheControl: "public, max-age=31536000" },
      ],
    });
    expect(r.issues).toHaveLength(2);
    expect(r.issues.every((i) => i.title.includes("Missing/short"))).toBe(true);
  });

  it("font-loading flags fonts loaded >200ms after navigationStart", () => {
    const trace = [
      { name: "navigationStart", ts: 0 },
      // ts in microseconds → 300ms
      { name: "ResourceFinish", ts: 300_000, args: { data: { url: "https://x/font.woff2" } } },
      { name: "ResourceFinish", ts: 100_000, args: { data: { url: "https://x/early.woff2" } } },
    ];
    const r = analyseFontLoading({ trace });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.title).toContain("font.woff2");
  });
});

describe("composeReport", () => {
  it("composes a summary report with score + topIssues + perCategory caps", () => {
    const ctx: AuditContext = {
      trace: Array.from({ length: 10 }, () => ({ name: "RunTask", ts: 0, dur: 100_000 })),
    };
    const r = composeReport(ctx, ["long-tasks"], "summary");
    expect(r.summary.score).toBeLessThan(100);
    expect(r.summary.topIssues.length).toBeGreaterThan(0);
    // summary mode caps per-category to 3.
    expect(r.byCategory["long-tasks"]!.issues.length).toBeLessThanOrEqual(3);
  });

  it("score floors at 0 when many high-severity issues fire", () => {
    const trace = Array.from({ length: 100 }, () => ({ name: "RunTask", ts: 0, dur: 500_000 }));
    const r = composeReport({ trace }, ["long-tasks"], "full");
    expect(r.summary.score).toBe(0);
  });
});

describe("enforceSummaryBudget — token-cap truncation", () => {
  it("drops low-severity issues to stay under 2000 tokens + surfaces warnings", () => {
    // Synthesise a wildly oversized report — 200 low-severity issues with
    // verbose details that would blow past 2000 tokens.
    const veryLongTitle = "Long Long Long Long Long ".repeat(20);
    const lowIssues: AuditIssue[] = Array.from({ length: 200 }, (_, i) => ({
      category: "long-tasks" as const,
      severity: "low" as const,
      title: `${veryLongTitle} #${i}`,
      details: { padding: "x".repeat(50) },
    }));
    const report: AuditReport = {
      summary: {
        score: 50,
        topIssues: lowIssues
          .slice(0, 50)
          .map((i) => ({ category: i.category, severity: i.severity, title: i.title })),
      },
      byCategory: { "long-tasks": { issues: lowIssues, remediations: [] } },
      warnings: [],
    };
    const tokensBefore = estimateTokens(JSON.stringify(report));
    expect(tokensBefore).toBeGreaterThan(2000);
    const out = enforceSummaryBudget(report);
    const tokensAfter = estimateTokens(JSON.stringify(out));
    expect(tokensAfter).toBeLessThanOrEqual(2000);
    expect(out.warnings.some((w) => w.includes("summary token budget enforced"))).toBe(true);
  });

  it("leaves a small report untouched", () => {
    const report: AuditReport = {
      summary: { score: 100, topIssues: [] },
      byCategory: { "long-tasks": { issues: [], remediations: [] } },
      warnings: [],
    };
    const out = enforceSummaryBudget(report);
    expect(out.warnings).toHaveLength(0);
    expect(out.summary.score).toBe(100);
  });
});
