// Unit cover for the pure helpers behind the manual docs Lighthouse run
// (scripts/lighthouse/block.mjs): median and spread, failed-audit extraction,
// the 40 KB cap and the LH| chunking. The run itself needs Chrome and only
// happens in the manual Woodpecker workflow.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./_guard-tree.js";

type Run = {
  scores?: Record<string, number>;
  failures?: unknown[];
  load?: number;
  error?: string;
};
const block = (await import(join(REPO, "scripts/lighthouse/block.mjs"))) as {
  THRESHOLDS: Record<string, number>;
  median: (v: number[]) => number;
  spread: (v: number[]) => number;
  failedAudits: (lhr: unknown) => Array<{
    id: string;
    cats: string[];
    title: string;
    value: string;
    nodes: string[];
  }>;
  summarize: (runs: Run[]) => {
    ok: number;
    medians: Record<string, number>;
    spreads: Record<string, number>;
    below: string[];
    failures: unknown[];
  };
  fit: (lines: string[], budget?: number) => string[];
  chunk: (text: string) => string[];
  renderBlock: (headers: string[], pages: string[][]) => string;
};

const scores = (perf: number, rest = 1) => ({
  performance: perf,
  accessibility: rest,
  "best-practices": rest,
  seo: rest,
});

describe("lighthouse block helpers", () => {
  it("takes the median and the spread", () => {
    expect(block.median([0.5, 0.9, 0.7])).toBe(0.7);
    expect(block.median([1, 3])).toBe(2);
    expect(block.spread([0.5, 0.9, 0.7])).toBeCloseTo(0.4);
  });

  it("scores the median of the runs, not the best or the last one", () => {
    const s = block.summarize([
      { scores: scores(0.99), failures: [], load: 1 },
      { scores: scores(0.6), failures: [], load: 9 },
      { scores: scores(0.95), failures: [], load: 2 },
    ]);
    expect(s.medians.performance).toBe(0.95);
    expect(s.spreads.performance).toBeCloseTo(0.39);
    expect(s.below).toEqual([]);
  });

  it("flags a category whose median is under its threshold", () => {
    const s = block.summarize([
      { scores: scores(0.9, 0.98), failures: [], load: 1 },
      { scores: scores(0.9, 1), failures: [], load: 1 },
      { scores: scores(0.85, 0.98), failures: [], load: 1 },
    ]);
    expect(s.below).toEqual(["accessibility", "best-practices", "seo"]);
  });

  it("counts a thrown run as an error and scores the rest; no usable run gives ok 0", () => {
    const some = block.summarize([
      { error: "boom" },
      { scores: scores(1), failures: [], load: 1 },
      { scores: scores(1), failures: [], load: 1 },
    ]);
    expect(some.ok).toBe(2);
    expect(block.summarize([{ error: "a" }, { error: "b" }]).ok).toBe(0);
  });

  it("extracts failed audits with at most 3 offending nodes, each trimmed to 100 chars", () => {
    const long = "x".repeat(300);
    const item = (n: number) => ({ node: { selector: `div.n${n}`, snippet: long } });
    const lhr = {
      categories: {
        performance: { auditRefs: [{ id: "tbt" }, { id: "fine" }, { id: "info" }] },
        accessibility: { auditRefs: [{ id: "color-contrast" }] },
        "best-practices": { auditRefs: [] },
        seo: { auditRefs: [{ id: "color-contrast" }] },
      },
      audits: {
        tbt: {
          id: "tbt",
          title: "TBT",
          score: 0.5,
          scoreDisplayMode: "numeric",
          displayValue: "800 ms",
        },
        fine: { id: "fine", title: "ok", score: 0.95, scoreDisplayMode: "numeric" },
        info: { id: "info", title: "n/a", score: null, scoreDisplayMode: "informative" },
        "color-contrast": {
          id: "color-contrast",
          title: "Contrast",
          score: 0,
          scoreDisplayMode: "binary",
          details: { items: [item(1), item(2), item(3), item(4)] },
        },
      },
    };
    const failed = block.failedAudits(lhr);
    expect(failed.map((f) => f.id)).toEqual(["tbt", "color-contrast"]);
    const contrast = failed[1]!;
    expect(contrast.cats).toEqual(["a11y", "seo"]);
    expect(contrast.nodes).toHaveLength(3);
    for (const n of contrast.nodes) expect(n.length).toBeLessThanOrEqual(100);
    expect(failed[0]!.value).toBe("800 ms");
  });

  it("keeps the block under the cap, dropping node lines before audit lines", () => {
    const lines = ["head"];
    for (let i = 0; i < 400; i += 1) {
      lines.push(`  FAIL audit-${i} [perf] 0 "title ${i}"`);
      lines.push(`    node: ${"s".repeat(90)}`);
    }
    const out = block.fit(lines, 19000);
    expect(Buffer.byteLength(out.join("\n"))).toBeLessThanOrEqual(19000);
    expect(out.at(-1)).toMatch(/^\.\.\. truncated: \d+ lines dropped/);
    expect(out.some((l) => l.startsWith("  FAIL audit-0 "))).toBe(true);
  });

  it("chunks into LH|n| lines of at most 1.5 KB, with nothing lost", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${"y".repeat(60)}`)
      .concat(["z".repeat(4000)])
      .join("\n");
    const lines = block.chunk(text);
    for (const l of lines) {
      expect(l).toMatch(/^LH\|\d+\|/);
      expect(Buffer.byteLength(l)).toBeLessThanOrEqual(1500);
    }
    const back = lines.map((l) => l.replace(/^LH\|\d+\|/, "")).join("\n");
    expect(back.replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
    expect(new Set(lines.map((l) => l.split("|")[1])).size).toBeGreaterThan(1);
  });

  it("renders the whole block under 40 KB between its markers", () => {
    const page: string[] = [];
    for (let i = 0; i < 400; i += 1)
      page.push(`  FAIL a${i} [perf] 0 "${"t".repeat(100)}" -- ${"v".repeat(100)}`);
    const out = block.renderBlock(["head"], [page]);
    expect(out.startsWith("===== LIGHTHOUSE BEGIN =====")).toBe(true);
    expect(out.endsWith("===== LIGHTHOUSE END =====")).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThan(40000);
  });

  it("holds the documented thresholds", () => {
    expect(block.THRESHOLDS).toEqual({
      performance: 0.9,
      accessibility: 1,
      "best-practices": 1,
      seo: 1,
    });
  });
});
