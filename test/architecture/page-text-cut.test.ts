// A head cut in `src/page/**`, `src/session/**` or `src/util/**` (`.slice(0, 120)`, `.substring(0, 80)`, and the
// same with a named length: `.slice(0, NAME_READ)`, `.slice(0, ${PAGE_READ})`)
// is how text used to be capped before the registered-secret mask ran: the cut
// split a value that crossed it, and the later mask, which only matches whole
// values, left the head in the output. Page text, page-supplied values and
// agent-supplied args that leave the server go through `clipPageText` / `clipMasked` / `capMasked` in
// `src/util/frame-cap.ts` instead, which mask first.
//
// This test fails on a new head cut. Each cut that stays is listed with the
// reason it is not text bound for a tool result or a record: an array, a hash, an index
// cut of a value, a detection-only read, a name already masked before it is cut,
// or a page-side read of `pageReadLength(cap, slack)` characters that the server
// masks before it cuts to the cap. Adding an entry needs that reason; a cut of
// page text needs the helpers. A length that is an expression (`max - 1`) is not
// matched, and neither is a comment line.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNED = ["src/page", "src/session", "src/util"].map((d) => join(ROOT, d));

/** A head cut whose length is a numeric literal, an identifier or member path
 *  (`NAME_READ`, `this.max`), or an interpolated identifier in a page-script
 *  template (`${PAGE_READ}`), in code or in a page-script string. */
const HEAD_CUT =
  /\.(?:slice|substring)\(\s*0\s*,\s*(?:[0-9][0-9_]*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|\$\{\s*[A-Za-z_$][\w$]*\s*\})\s*\)/g;

/** A line that is only a comment. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

const SLACK_READ =
  "a page-side read of pageReadLength(cap, slack) characters; the server masks it, then cuts it to the cap";

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
  // Named lengths.
  { file: "src/page/actions-probe.ts", line: "t.slice(0, read)", why: SLACK_READ },
  { file: "src/page/actions-probe.ts", line: "txt.slice(0, TEXT_READ)", why: SLACK_READ },
  { file: "src/page/actions-probe.ts", line: "rowText.slice(0, TEXT_READ)", why: SLACK_READ },
  { file: "src/page/actions-probe.ts", line: "t.slice(0, KEY_READ)", why: SLACK_READ },
  { file: "src/page/point_probe.ts", line: "el.className.slice(0, CLASS_READ)", why: SLACK_READ },
  { file: "src/page/point_probe.ts", line: "trim().slice(0, NAME_READ)", why: SLACK_READ },
  { file: "src/page/dom-walk.ts", line: "aria.trim().slice(0, nameRead)", why: SLACK_READ },
  { file: "src/page/dom-walk.ts", line: "return s.slice(0, nameRead)", why: SLACK_READ },
  {
    file: "src/page/dom-walk.ts",
    line: "el.placeholder.trim().slice(0, nameRead)",
    why: SLACK_READ,
  },
  {
    file: "src/page/dom-walk.ts",
    line: "String(el.value).trim().slice(0, nameRead)",
    why: SLACK_READ,
  },
  { file: "src/page/dom-walk.ts", line: "title.trim().slice(0, nameRead)", why: SLACK_READ },
  { file: "src/page/shadow-trees.ts", line: "t.slice(0, textRead)", why: SLACK_READ },
  { file: "src/page/shortcut.ts", line: "trim().slice(0, ${nameRead})", why: SLACK_READ },
  { file: "src/page/workers-page.ts", line: "data.slice(0, ${PAGE_READ})", why: SLACK_READ },
  {
    file: "src/page/snapshot-text.ts",
    line: "return text.slice(0, end)",
    why: "`sliceUnits`, the surrogate-safe cut the mask-first helpers call",
  },
  {
    file: "src/page/overflow-detect-page.ts",
    line: "fullText.slice(0, cutoff)",
    why: "`visibleText`, which the server recuts from the masked `fullText` (overflow-detect.ts)",
  },
  {
    file: "src/page/challenge-page.ts",
    line: ".slice(0, bodyTextScanChars)",
    why: "detection only: the body text is matched against fixed phrases, nothing is emitted",
  },
  {
    file: "src/page/actionresult-shape.ts",
    line: "slice(0, ERROR_MAX_CHARS_PER)",
    why: "console errors, masked when the console buffer hands them out (console.ts)",
  },
  {
    file: "src/page/asset-export-naming.ts",
    line: "name.slice(0, FILENAME_MAX_CHARS)",
    why: "a file name from a URL, masked in `filenameFromUrl` before it is sanitised",
  },
  {
    file: "src/page/asset-export-naming.ts",
    line: "name.slice(0, dot)",
    why: "an index cut: the stem before the extension",
  },
  {
    file: "src/page/native-hierarchy.ts",
    line: "raw.slice(0, slash)",
    why: "an index cut: the resource-id package qualifier",
  },
  {
    file: "src/page/ios-hierarchy.ts",
    line: "entry.path.slice(0, cut)",
    why: "an index cut: the parent's tree path",
  },
  { file: "src/page/perf-audit.ts", line: "sortedIssues.slice(0, n)", why: "an array of issues" },
  { file: "src/page/find.ts", line: "scored.slice(0, max)", why: "an array of candidates" },
  {
    file: "src/page/layout-thrash.ts",
    line: "eventsByOrigin.slice(0, MAX_ORIGINS)",
    why: "an array of origins",
  },
  {
    file: "src/page/extract-resolve.ts",
    line: ".slice(0, MAX_UNMATCHED_WARNINGS)",
    why: "an array of warnings",
  },
  {
    file: "src/page/perf-insights.ts",
    line: "arr.slice(0, MAX_LIST_ENTRIES)",
    why: "an array of entries",
  },
  {
    file: "src/page/heap-parse.ts",
    line: "rows.slice(0, MAX_RETAINER_RESULTS)",
    why: "an array of rows",
  },
  {
    file: "src/page/overflow-detect-types.ts",
    line: "findings.slice(0, limit)",
    why: "an array of findings",
  },
  { file: "src/page/point_probe.ts", line: ": []).slice(0, MAX)", why: "an array of elements" },
  {
    file: "src/page/network-types.ts",
    line: "Object.keys(parsed).slice(0, MAX_RESPONSE_SHAPE_KEYS)",
    why: "an array of keys",
  },
  {
    file: "src/page/network-types.ts",
    line: ".slice(0, MAX_RESPONSE_SHAPE_KEYS)",
    why: "an array of keys",
  },
  {
    file: "src/page/coverage.ts",
    line: ".slice(0, MAX_DEAD_RANGES_PER_SCRIPT)",
    why: "an array of ranges",
  },
  {
    file: "src/page/memory-diff.ts",
    line: "rows.slice(0, MAX_GROWTH_ROWS)",
    why: "an array of rows",
  },
  {
    file: "src/page/actionresult-shape.ts",
    line: "errors.slice(0, ERROR_MAX_TOTAL_ENTRIES)",
    why: "an array of errors",
  },
  // src/session and src/util.
  {
    file: "src/session/device.ts",
    line: ".slice(0, 4);",
    why: "an array of device preset names",
  },
  {
    file: "src/session/device.ts",
    line: "Object.keys(devices).slice(0, 4)",
    why: "an array of device preset names",
  },
  {
    file: "src/session/device-emu-attach.ts",
    line: "devices.slice(0, 1)",
    why: "an array of catalog devices",
  },
  {
    file: "src/session/fs-picker-attach.ts",
    line: "files.slice(0, 1)",
    why: "an array of files",
  },
  {
    file: "src/session/fs-picker-attach.ts",
    line: "payload.slice(0, 200)",
    why: "detection only: the handle id is read to find the handle, nothing is emitted",
  },
  {
    file: "src/session/chromium-sandbox-launch.ts",
    line: "hit.slice(0, 197)",
    why: "a Chromium launch error line, written before the browser loads any page",
  },
  {
    file: "src/util/url-sanitizer.ts",
    line: "raw.slice(0, cut)",
    why: "an index cut: the URL before its path",
  },
  {
    file: "src/util/url-sanitizer.ts",
    line: "head.slice(0, slash)",
    why: "an index cut: the authority",
  },
  {
    file: "src/util/secret-forms.ts",
    line: "[...forms].slice(0, MAX_FORMS_PER_SECRET)",
    why: "an array of mask forms",
  },
  {
    file: "src/util/credentials-contract.ts",
    line: "trimmed.slice(0, eq)",
    why: "an index cut: the key before `=` in an operator env value",
  },
  {
    file: "src/util/credentials-contract.ts",
    line: "account.slice(0, 64)",
    why: "a refused account name echoed to the caller; `accountError` has no session registry to mask with",
  },
  {
    file: "src/util/profile-name.ts",
    line: "name.slice(0, 64)",
    why: "a refused profile or session name echoed to the caller; `invalidNameRefusal` has no session registry to mask with",
  },
  {
    file: "src/util/tokens.ts",
    line: "lines.slice(0, kept)",
    why: "an array of whole lines from a tree its caller already masked (actionresult-shape.ts)",
  },
  {
    file: "src/util/body-cap.ts",
    line: "return text.slice(0, end)",
    why: "`dropLastUnits`, the mask-first body cap dropping the slack",
  },
  {
    file: "src/util/frame-cap.ts",
    line: "raw.slice(0, max), truncated: true",
    why: "`capMasked` with no mask: nothing is registered",
  },
  {
    file: "src/util/frame-cap.ts",
    line: "mask(raw.slice(0, end))",
    why: "`capMasked`, the window it masks before the cut",
  },
  {
    file: "src/util/frame-cap.ts",
    line: "masked.slice(0, max)",
    why: "`capMasked`, the cut of the masked window",
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
  for (const abs of SCANNED.flatMap((d) => walk(d))) {
    const file = relative(ROOT, abs).split(sep).join("/");
    for (const line of readFileSync(abs, "utf8").split("\n")) {
      if (COMMENT_LINE.test(line)) continue;
      for (const _ of line.matchAll(HEAD_CUT)) found.push({ file, line: line.trim() });
    }
  }
  return found;
}

describe("page-text-cut", () => {
  it("has no head cut in src/page, src/session or src/util outside the allowlist", () => {
    const unlisted = headCuts().filter(
      (c) => !ALLOWED.some((a) => a.file === c.file && c.line.includes(a.line)),
    );
    expect(
      unlisted,
      "cut page text with clipPageText / clipMasked / capMasked (src/util/frame-cap.ts), " +
        "which mask a registered value before the cut, or list the cut here with the reason " +
        "it is not text bound for a tool result or a record",
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
    expect("t.slice(0, nameRead)".match(HEAD_CUT)).toHaveLength(1);
    expect("t.slice(0, ERROR_MAX_CHARS_PER)".match(HEAD_CUT)).toHaveLength(1);
    expect("t.slice(0, this.max)".match(HEAD_CUT)).toHaveLength(1);
    expect("data.slice(0, ${PAGE_READ});".match(HEAD_CUT)).toHaveLength(1);
  });

  it("leaves a tail cut, an expression length and a comment alone", () => {
    expect("t.slice(1, 4)".match(HEAD_CUT)).toBeNull();
    expect("t.slice(-40)".match(HEAD_CUT)).toBeNull();
    expect("t.slice(0, max - 1)".match(HEAD_CUT)).toBeNull();
    expect("t.slice(0, s.indexOf(':'))".match(HEAD_CUT)).toBeNull();
    expect(COMMENT_LINE.test(" *  `const top = scored.slice(0, max)`")).toBe(true);
    expect(COMMENT_LINE.test("  // x.slice(0, 10)")).toBe(true);
    expect(COMMENT_LINE.test("  return x.slice(0, 10); // cut")).toBe(false);
  });
});
