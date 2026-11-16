// Unit cover for the pure helpers behind the manual first-run workflow (scripts/first-run/block.mjs and doc-facts.mjs):
// the token estimate, the byte budget, the FRX| chunking and the Playwright download-size parser. The run itself needs the
// npm registry and a browser and only happens in the manual Woodpecker workflow.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./_guard-tree.js";

const block = (await import(join(REPO, "scripts/first-run/block.mjs"))) as {
  BEGIN: string;
  END: string;
  bytes: (s: string) => number;
  estTokens: (chars: number) => number;
  clip: (s: string, n?: number) => string;
  excerpt: (output: string, lines: number, width?: number) => string[];
  layout: (
    headers: string[],
    entries: Array<{ head: string; output?: string }>,
    extras: string[],
    budget: number,
    maxLines?: number,
  ) => string;
  chunk: (tag: string, text: string) => string[];
  render: (tag: string, text: string) => string;
  worst: (codes: number[]) => number;
};
const facts = (await import(join(REPO, "scripts/first-run/doc-facts.mjs"))) as {
  docFacts: (root: string) => {
    pin?: string;
    installCmd?: string;
    sizeMb?: number;
    nodeMin?: number;
    tellsBrowser: boolean;
    quotedSmoke?: string;
    smokeRe?: RegExp;
  };
  downloadedBytes: (output: string) => number | undefined;
};

describe("first-run block helpers", () => {
  it("estimates tokens as characters over 4, rounded up", () => {
    expect(block.estTokens(0)).toBe(0);
    expect(block.estTokens(4)).toBe(1);
    expect(block.estTokens(401)).toBe(101);
  });

  it("clips to one ASCII line and writes the doctor glyphs as words", () => {
    expect(block.clip("✓ browser\n  ready")).toBe("OK browser ready");
    expect(block.clip("x".repeat(300), 20)).toHaveLength(20);
    expect(block.clip("café")).toBe("caf?");
  });

  it("keeps the first lines of an output and says how many it cut", () => {
    const out = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const shown = block.excerpt(out, 25);
    expect(shown).toHaveLength(26);
    expect(shown[0]).toBe("  > line 1");
    expect(shown.at(-1)).toBe("  > (+5 more lines)");
  });

  it("fits entries in the budget and never cuts the DIFF lines", () => {
    const entries = Array.from({ length: 18 }, (_, i) => ({
      head: `[${i + 1}] command | exit 0 | 1.00s`,
      output: Array.from({ length: 40 }, (_, j) => `output line ${j} ${"x".repeat(100)}`).join(
        "\n",
      ),
    }));
    const extras = [
      "DIFF: the page says X, the package printed Y",
      "result: 1 difference(s), exit 1",
    ];
    const text = block.layout(["section: demo"], entries, extras, 8000);
    expect(block.bytes(text)).toBeLessThanOrEqual(8000);
    expect(text).toContain(extras[0]);
    expect(text).toContain(extras[1]);
    expect(text.startsWith("section: demo")).toBe(true);
  });

  it("cuts entries, not extras, when even the heads do not fit", () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({ head: `[${i}] ${"c".repeat(150)}` }));
    const text = block.layout(["h"], entries, ["DIFF: kept"], 3000);
    expect(block.bytes(text)).toBeLessThanOrEqual(3000);
    expect(text).toContain("DIFF: kept");
  });

  it("chunks the text into numbered lines of at most 1.5 KB per chunk", () => {
    const text = Array.from({ length: 100 }, (_, i) => `row ${i} ${"y".repeat(60)}`).join("\n");
    const lines = block.chunk("FRX", text);
    expect(lines).toHaveLength(100);
    expect(lines[0]).toMatch(/^FRX\|1\|row 0/);
    const perChunk = new Map<string, number>();
    for (const l of lines) {
      const n = l.split("|")[1] ?? "";
      perChunk.set(n, (perChunk.get(n) ?? 0) + block.bytes(l.split("|").slice(2).join("|")) + 1);
    }
    expect(perChunk.size).toBeGreaterThan(1);
    for (const size of perChunk.values()) expect(size).toBeLessThan(1500 + 100);
  });

  it("wraps the block between BEGIN and END with the text first and the chunked copy after", () => {
    const out = block.render("FRX", "a\nb").split("\n");
    expect(out).toEqual([block.BEGIN, "a", "b", "FRX|1|a", "FRX|1|b", block.END]);
    expect(block.BEGIN).toBe("===== FIRST-RUN BEGIN =====");
    expect(block.END).toBe("===== FIRST-RUN END =====");
  });

  it("takes the worst exit status, a tool error over a difference over a pass", () => {
    expect(block.worst([0, 0, 0])).toBe(0);
    expect(block.worst([0, 1, 0])).toBe(1);
    expect(block.worst([1, 2, 0])).toBe(2);
  });
});

describe("first-run doc facts", () => {
  it("reads what the getting-started page quotes", () => {
    const f = facts.docFacts(REPO);
    expect(f.pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(f.installCmd).toBe(`npx playwright-core@${f.pin} install chromium`);
    expect(f.tellsBrowser).toBe(true);
    expect(f.nodeMin).toBeGreaterThanOrEqual(20);
    expect(f.quotedSmoke).toBe("✓ first snapshot in N ms");
    expect(f.smokeRe?.test("  ✓ first snapshot in 412 ms")).toBe(true);
    expect(f.smokeRe?.test("✓ first snapshot in N ms")).toBe(false);
  });

  it("sums the archive sizes Playwright prints while it downloads", () => {
    const out = [
      "Downloading Chromium 141.0 (playwright build v1194) from https://cdn.example/a.zip",
      "|■■■■■■■■| 10% of 100.0 MiB",
      "|■■■■■■■■| 100% of 100.0 MiB",
      "Chromium 141.0 (playwright build v1194) downloaded to /x/chromium-1194",
      "Downloading Chromium Headless Shell 141.0 from https://cdn.example/b.zip",
      "|■■■■■■■■| 100% of 50.0 MiB",
      "Chromium Headless Shell 141.0 downloaded to /x/headless-1194",
    ].join("\n");
    expect(facts.downloadedBytes(out)).toBe(150 * 1024 ** 2);
    expect(facts.downloadedBytes("nothing printed")).toBeUndefined();
  });
});
