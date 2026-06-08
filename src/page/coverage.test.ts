import { describe, it, expect } from "vitest";
import { parseJsCoverage, parseCssCoverage } from "./coverage.js";

describe("parseJsCoverage", () => {
  it("treats a count:1 function's nested 0-count blocks as dead", () => {
    // V8 shape: a function ran (count:1 root), with a sub-block that didn't
    // (count:0). Block-coverage semantics — the dead block is dead bytes.
    const r = parseJsCoverage([
      {
        url: "https://example/a.js",
        functions: [
          { isBlockCoverage: true, ranges: [
            { startOffset: 0, endOffset: 100, count: 1 },
            { startOffset: 50, endOffset: 80, count: 0 },
          ] },
        ],
      },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.url).toBe("https://example/a.js");
    expect(r[0]!.totalBytes).toBe(100);
    expect(r[0]!.usedBytes).toBe(70);
    expect(r[0]!.usagePercent).toBe(70);
    expect(r[0]!.deadRanges).toEqual([{ start: 50, end: 80 }]);
  });

  it("treats a count:0 function root as fully dead", () => {
    // V8 shape: wrapper script ran (count:1 over the whole file), and one
    // declared but never-called function. The dead function is dead bytes.
    const r = parseJsCoverage([
      {
        url: "https://example/b.js",
        functions: [
          // Outer anonymous wrapper — V8's synthetic top-level script
          // execution context. Tells us nothing about which bytes ran.
          { functionName: "", ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
          // Declared-but-uncalled function.
          { functionName: "dead", ranges: [{ startOffset: 40, endOffset: 80, count: 0 }] },
        ],
      },
    ]);
    expect(r[0]!.totalBytes).toBe(100);
    expect(r[0]!.usedBytes).toBe(60);
    expect(r[0]!.usagePercent).toBe(60);
    expect(r[0]!.deadRanges).toEqual([{ start: 40, end: 80 }]);
  });

  it("treats totalBytes:0 as usagePercent:100", () => {
    const r = parseJsCoverage([
      { url: "https://example/empty.js", functions: [] },
    ]);
    expect(r[0]!.usagePercent).toBe(100);
  });

  it("skips entries without a url", () => {
    const r = parseJsCoverage([
      { url: "", functions: [{ ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }] },
    ]);
    expect(r).toHaveLength(0);
  });
});

describe("parseCssCoverage", () => {
  it("aggregates rule usage per stylesheet + emits deadRules", () => {
    const headers = new Map([
      ["s1", { styleSheetId: "s1", sourceURL: "https://example/a.css", length: 200 }],
    ]);
    const r = parseCssCoverage([
      { styleSheetId: "s1", startOffset: 0, endOffset: 50, used: true },
      { styleSheetId: "s1", startOffset: 50, endOffset: 100, used: false },
      { styleSheetId: "s1", startOffset: 100, endOffset: 150, used: true },
      { styleSheetId: "s1", startOffset: 150, endOffset: 200, used: false },
    ], headers);
    expect(r).toHaveLength(1);
    const e = r[0]!;
    expect(e.url).toBe("https://example/a.css");
    expect(e.totalBytes).toBe(200);
    expect(e.usedBytes).toBe(100);
    expect(e.usagePercent).toBe(50);
    expect(e.usedRules).toBe(2);
    expect(e.totalRules).toBe(4);
    expect(e.deadRules).toEqual([
      { start: 50, end: 100 },
      { start: 150, end: 200 },
    ]);
  });

  it("falls back to inline:<id> when no header URL", () => {
    const r = parseCssCoverage([
      { styleSheetId: "s2", startOffset: 0, endOffset: 30, used: true },
    ], new Map());
    expect(r[0]!.url).toBe("inline:s2");
    expect(r[0]!.totalBytes).toBe(30);
  });
});
