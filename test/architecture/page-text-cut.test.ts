// A literal head cut in `src/page/**` (`.slice(0, 120)`, `.substring(0, 80)`)
// is how page text used to be capped before the registered-secret mask ran: the
// cut split a value that crossed it, and the later mask, which only matches
// whole values, left the head in the output. Page text that leaves the server
// goes through `clipPageText` / `clipMasked` / `capMasked` in
// `src/util/frame-cap.ts` instead, which mask first.
//
// This test fails on a new literal head cut. Each cut that stays is listed with
// the reason it is not page text bound for a tool result: an array, a hash, a
// detection-only read, or a name already masked before it is cut. Adding an
// entry needs that reason; a cut of page text needs the helpers.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PAGE = join(ROOT, "src/page");

/** A head cut with a numeric literal length, in code or in a page-script string. */
const HEAD_CUT = /\.(?:slice|substring)\(\s*0\s*,\s*[0-9][0-9_]*\s*\)/g;

/** Allowed cuts: the file, a fragment of the line that holds the cut, and why
 *  the cut is not page text bound for a tool result. */
const ALLOWED: ReadonlyArray<{ file: string; line: string; why: string }> = [
  {
    file: "src/page/capture-substrate-playwright.ts",
    line: 'innerText ?? "").slice(0, 200_000)',
    why: "detection only: the screenshot warning looks for secrets in it, nothing is emitted",
  },
  {
    file: "src/page/perf-audit-budget.ts",
    line: "report.warnings.slice(0, 1)",
    why: "an array of warnings",
  },
  { file: "src/page/perf-audit.ts", line: "sorted.slice(0, 10)", why: "an array of rows" },
  { file: "src/page/native-hierarchy.ts", line: 'digest("hex").slice(0, 16)', why: "a hash" },
  {
    file: "src/page/actions-probe.ts",
    line: '(a.textContent || "").trim().slice(0, 60)',
    why: "a focus signature that is compared, never emitted",
  },
  { file: "src/page/refs.ts", line: 'digest("hex").slice(0, 16)', why: "a hash" },
  {
    file: "src/page/overflow-detect-types.ts",
    line: "el.parentChain.slice(0, 5)",
    why: "an array of ancestors",
  },
  {
    file: "src/page/overflow-detect-types.ts",
    line: "el.classList.slice(0, 3)",
    why: "an array of class names",
  },
  { file: "src/page/plan.ts", line: "alternatives.slice(0, 4)", why: "an array of candidates" },
  { file: "src/page/frames.ts", line: 'digest("hex").slice(0, 12)', why: "a hash" },
  { file: "src/page/memory-diff.ts", line: "rows.slice(0, 3)", why: "an array of rows" },
  {
    file: "src/page/workers-sw.ts",
    line: "url.slice(0, 2048)",
    why: "bounds a service-worker script URL used as the key of its `sw-N` id",
  },
  {
    file: "src/page/downloads.ts",
    line: "name = name.slice(0, 200)",
    why: "the download name, masked before `sanitiseFilename` runs",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function headCuts(): Array<{ file: string; line: string }> {
  const found: Array<{ file: string; line: string }> = [];
  for (const abs of walk(PAGE)) {
    const file = relative(ROOT, abs).split(sep).join("/");
    for (const line of readFileSync(abs, "utf8").split("\n")) {
      for (const _ of line.matchAll(HEAD_CUT)) found.push({ file, line: line.trim() });
    }
  }
  return found;
}

describe("page-text-cut", () => {
  it("has no literal head cut in src/page outside the allowlist", () => {
    const unlisted = headCuts().filter(
      (c) => !ALLOWED.some((a) => a.file === c.file && c.line.includes(a.line)),
    );
    expect(
      unlisted,
      "cut page text with clipPageText / clipMasked / capMasked (src/util/frame-cap.ts), " +
        "which mask a registered value before the cut, or list the cut here with the reason " +
        "it is not page text bound for a tool result",
    ).toEqual([]);
  });

  it("lists no cut that is gone", () => {
    const cuts = headCuts();
    const stale = ALLOWED.filter(
      (a) => !cuts.some((c) => c.file === a.file && c.line.includes(a.line)),
    );
    expect(stale).toEqual([]);
  });

  it("finds a head cut in code and in a page-script string", () => {
    expect("x.slice(0, 120)".match(HEAD_CUT)).toHaveLength(1);
    expect("return t.slice(0, 79) + '…';".match(HEAD_CUT)).toHaveLength(1);
    expect("s.substring(0,40)".match(HEAD_CUT)).toHaveLength(1);
    expect("t.slice(0, nameRead)".match(HEAD_CUT)).toBeNull();
  });
});
