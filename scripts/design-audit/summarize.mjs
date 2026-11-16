// Print the design-audit findings as one delimited block and exit non-zero when there are any.
// Usage: node summarize.mjs <out-dir> <themes-file>
// Reads imp-<theme>-<width>-<page>.{json,rc,err} (impeccable) and hm-<theme>-<page>.{json,rc,err} (hallmark).
// Identical findings across themes and widths are merged into one line with the variants listed.
// The block is grouped by page. A finding that repeats on SITEWIDE_PAGES or more pages (a template or vendor element) is printed once as sitewide.
// At most PER_TOOL_CAP findings are printed per tool (the rest are only counted), so the log stays inside LOG_BUDGET bytes.
// Exit status of this script: 2 on a tool error or no runs, 1 on findings that are not kept, 0 clean.
// Exit codes: impeccable 0 clean, 2 findings, anything else a tool error. hallmark 0 clean, 1 findings, anything else a tool error.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [outDir, themesFile] = process.argv.slice(2);
if (!outDir || !themesFile) {
  console.error("usage: summarize.mjs <out-dir> <themes-file>");
  process.exit(2);
}
const PER_TOOL_CAP = 25;
const SITEWIDE_PAGES = 4;
const MAX_ERRORS = 12;
const DUMP_BUDGET = 4500; // bytes of element dump lines, home, tool-reference and threat-model first
const LOG_BUDGET = 24000; // bytes for the whole block; the dumps and then the finding details give way first
const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
const clip = (text, n) => {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > n ? `${flat.slice(0, n - 3)}...` : flat;
};
const themes = read(themesFile)
  .split("\n")
  .map((line) => line.trim().split(/\s+/)[0])
  .filter(Boolean);

const groups = new Map(); // key -> { tool, page, label, detail, variants:Set }
const errors = [];
const tallies = new Map(); // non-failing hallmark grades
let runs = 0;
const add = (tool, page, label, detail, variant) => {
  const key = `${tool}|${page}|${label}|${detail}`;
  if (!groups.has(key)) groups.set(key, { tool, page, label, detail, variants: new Set() });
  groups.get(key).variants.add(variant);
};

// Element context of an impeccable finding: selector, snippet (80 chars) and measured width, plus any other scalar field.
const elementContext = (f) => {
  const pick = (...keys) =>
    keys.map((k) => f[k]).find((v) => v !== undefined && v !== null && v !== "");
  const parts = [];
  const sel = pick("selector", "element", "path", "target");
  const snip = pick("snippet", "text", "html", "excerpt");
  if (sel) parts.push(`selector ${clip(typeof sel === "object" ? JSON.stringify(sel) : sel, 160)}`);
  if (snip)
    parts.push(`snippet "${clip(typeof snip === "object" ? JSON.stringify(snip) : snip, 80)}"`);
  const known = new Set([
    "id",
    "rule",
    "antipattern",
    "name",
    "message",
    "description",
    "selector",
    "element",
    "path",
    "target",
    "snippet",
    "text",
    "html",
    "excerpt",
  ]);
  for (const [k, v] of Object.entries(f))
    if (!known.has(k) && (typeof v === "number" || (typeof v === "string" && v.length <= 60)))
      parts.push(`${k}=${v}`);
  return parts.length ? ` | ${parts.join("; ")}` : "";
};

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

for (const file of readdirSync(outDir)
  .filter((f) => f.endsWith(".rc"))
  .sort()) {
  const base = file.slice(0, -3);
  const rc = Number(read(join(outDir, file)).trim());
  const json = parse(read(join(outDir, `${base}.json`)));
  const err = read(join(outDir, `${base}.err`));
  const imp = /^imp-(light|dark)-(\d+)-(.+)$/.exec(base);
  const hm = /^hm-(light|dark)-(.+)$/.exec(base);
  runs += 1;
  if (imp) {
    const [, theme, width, page] = imp;
    if (rc !== 0 && rc !== 2) {
      errors.push(`impeccable ${theme} ${width} ${page}: exit ${rc}: ${clip(err, 300)}`);
      continue;
    }
    const list = Array.isArray(json) ? json : (json?.findings ?? []);
    if (rc === 2 && list.length === 0)
      errors.push(`impeccable ${theme} ${width} ${page}: exit 2 with no parsable findings`);
    for (const f of list) {
      const label = f.id ?? f.rule ?? f.antipattern ?? f.name ?? "finding";
      const detail = clip(
        f.message ?? f.description ?? f.evidence ?? f.snippet ?? JSON.stringify(f),
        200,
      );
      add("impeccable", page, label, detail + elementContext(f), `${theme}/${width}`);
    }
  } else if (hm) {
    const [, theme, page] = hm;
    if (rc !== 0 && rc !== 1) {
      errors.push(`hallmark ${theme} ${page}: exit ${rc}: ${clip(err, 300)}`);
      continue;
    }
    if (!json || json.summary?.render === "off" || /render tier not run/i.test(err)) {
      errors.push(`hallmark ${theme} ${page}: the render tier did not run: ${clip(err, 300)}`);
      continue;
    }
    for (const f of json.findings ?? []) {
      if (f.grade === "FAIL" || f.grade === "REFLEX") {
        const where = f.line ? ` :${f.line}` : "";
        add(
          "hallmark",
          page,
          `${f.grade} ${f.gate}${where}`,
          clip(`${f.evidence ?? ""} | fix: ${f.fix ?? ""}`, 240),
          theme,
        );
      } else {
        tallies.set(f.grade, (tallies.get(f.grade) ?? 0) + 1);
      }
    }
  }
}

const gaps = [
  "hallmark has no 390 width; its fixed 375 and 414 stand in for it (320 and 1440 are covered).",
  "hallmark runs its focus-ring and Tab checks at 1440 only.",
  "hallmark's floor rules grade pages built with hallmark; expect FAILs that only mean 'not built with hallmark' (token block, stamp).",
  "impeccable does not emulate a colour scheme itself; the theme comes from Chrome's preferredColorScheme flag.",
];
if (!themes.includes("dark"))
  gaps.unshift("dark theme NOT audited: the colour-scheme flag was not honoured, light only.");

// Accepted findings (website/design-audit-keep.md rows) are listed apart and do not fail the run.
const allow = parse(read(join(dirname(fileURLToPath(import.meta.url)), "allow.json"))) ?? [];
const kept = [];
for (const [key, g] of groups)
  if (allow.some((a) => a.tool === g.tool && a.page === g.page && g.label.startsWith(a.match))) {
    kept.push(
      `[kept, keep row ${allow.find((a) => a.page === g.page && g.label.startsWith(a.match)).keep}] ${g.page} ${g.label} ${clip(g.detail, 60)}`,
    );
    groups.delete(key);
  }
// pages.txt (written by run-audit.sh): "<slug> <path> <1 for a fixed page>" per page. skipped.txt: paths the soft deadline left out.
const pageRows = read(join(outDir, "pages.txt"))
  .split("\n")
  .map((l) => l.trim().split(/\s+/))
  .filter((r) => r.length >= 3);
const pagePath = new Map(pageRows.map(([slug, path]) => [slug, path]));
const fixedCount = pageRows.filter((r) => r[2] === "1").length;
const skipped = read(join(outDir, "skipped.txt"))
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);
if (skipped.length)
  errors.push(
    `the soft deadline passed: ${skipped.length} of ${pageRows.length} pages were not audited: ${skipped.join(" ")}`,
  );
const where = (page) => pagePath.get(page) ?? page;

// Sitewide: the same tool, label and detail on SITEWIDE_PAGES or more pages becomes one entry that lists its pages.
const bySame = new Map();
for (const g of groups.values()) {
  const k = `${g.tool}|${g.label}|${g.detail}`;
  if (!bySame.has(k)) bySame.set(k, []);
  bySame.get(k).push(g);
}
const entries = []; // { tool, pages:[page], label, detail, variants:Set, sitewide }
for (const list of bySame.values()) {
  if (list.length >= SITEWIDE_PAGES) {
    const variants = new Set(list.flatMap((g) => [...g.variants]));
    entries.push({
      tool: list[0].tool,
      pages: list.map((g) => g.page).sort(),
      label: list[0].label,
      detail: list[0].detail,
      variants,
      sitewide: true,
    });
  } else
    for (const g of list)
      entries.push({
        tool: g.tool,
        pages: [g.page],
        label: g.label,
        detail: g.detail,
        variants: g.variants,
        sitewide: false,
      });
}
const tools = ["impeccable", "hallmark"];
const perTool = (tool) => entries.filter((e) => e.tool === tool);
const countLine = (tool) => {
  const perPage = new Map();
  for (const e of perTool(tool)) for (const p of e.pages) perPage.set(p, (perPage.get(p) ?? 0) + 1);
  const rows = [...perPage].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return rows.length ? rows.map(([p, n]) => `${where(p)} ${n}`).join(", ") : "none";
};

const lines = [];
lines.push("===== DESIGN-AUDIT FINDINGS BEGIN =====");
const pageCount = pageRows.length || undefined;
lines.push(
  `runs: ${runs}, themes: ${themes.join(", ") || "none"}, pages: ${pageCount ?? "unknown"}, widths: impeccable 320/390/1440 on every page, hallmark fixed set (${fixedCount} pages)`,
);
lines.push(
  `findings: ${groups.size} distinct (${tools.map((t) => `${t} ${[...groups.values()].filter((g) => g.tool === t).length}`).join(", ")}), tool errors: ${errors.length}`,
);
lines.push(
  `sitewide (same finding on ${SITEWIDE_PAGES}+ pages, printed once): ${entries.filter((e) => e.sitewide).length}`,
);

// Details, capped per tool. Ranked by how many theme/width variants hit, then grouped by page below.
const detail = [];
for (const tool of tools) {
  const all = perTool(tool).sort(
    (a, b) =>
      Number(b.sitewide) - Number(a.sitewide) ||
      b.variants.size - a.variants.size ||
      `${a.pages[0]}${a.label}`.localeCompare(`${b.pages[0]}${b.label}`),
  );
  const shown = all.slice(0, PER_TOOL_CAP);
  detail.push(`-- ${tool}: ${all.length} findings, showing ${shown.length}`);
  detail.push(`   per page: ${countLine(tool)}`);
  const sitewide = shown.filter((e) => e.sitewide);
  for (const e of sitewide) {
    detail.push(
      `[${tool}] sitewide ${e.label} on ${e.pages.length} pages (${[...e.variants].sort().join(" ")})`,
    );
    detail.push(`    ${e.detail}`);
    detail.push(
      `    pages: ${e.pages.slice(0, 6).map(where).join(" ")}${e.pages.length > 6 ? " ..." : ""}`,
    );
  }
  const pages = [...new Set(shown.filter((e) => !e.sitewide).map((e) => e.pages[0]))].sort();
  for (const page of pages) {
    detail.push(`  page ${where(page)}`);
    for (const e of shown.filter((x) => !x.sitewide && x.pages[0] === page)) {
      detail.push(`    [${tool}] ${e.label} (${[...e.variants].sort().join(" ")})`);
      if (e.detail) detail.push(`        ${e.detail}`);
    }
  }
  if (all.length > shown.length)
    detail.push(`   ... ${all.length - shown.length} more ${tool} findings not printed`);
}
const kept2 = kept.slice(0, 10);
if (kept.length > kept2.length)
  kept2.push(`[kept] ${kept.length - kept2.length} more kept findings not printed`);

// Dumps print home, tool-reference and threat-model first so a truncated log still has them.
const first = ["dump-home", "dump-reference_tool-reference", "dump-security_threat-model"];
const rank = (f) => {
  const i = first.findIndex((p) => f.startsWith(p));
  return i < 0 ? first.length : i;
};
let dumpBytes = 0;
const dumps = [];
for (const file of readdirSync(outDir)
  .filter((f) => /^dump-.*\.txt$/.test(f))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
  const text = read(join(outDir, file)).trim();
  if (!text) continue;
  const part = text.slice(0, 1500);
  if (dumpBytes + part.length + 1 > DUMP_BUDGET) {
    dumps.push("[dump] more element dumps not printed (budget)");
    break;
  }
  dumpBytes += part.length + 1;
  dumps.push(part);
}

const tail = [];
if (tallies.size)
  tail.push(
    `not failing, hallmark: ${[...tallies].map(([grade, n]) => `${grade} ${n}`).join(", ")}`,
  );
tail.push(`[dump] total ${dumpBytes} bytes`);
for (const e of errors.slice(0, MAX_ERRORS)) tail.push(`[tool error] ${e}`);
if (errors.length > MAX_ERRORS)
  tail.push(`[tool error] ${errors.length - MAX_ERRORS} more tool errors not printed`);
for (const g of gaps) tail.push(`[gap] ${g}`);
tail.push("===== DESIGN-AUDIT FINDINGS END =====");

// Over LOG_BUDGET: drop the dumps first, then cut the finding details from the end. The counts above and the tail always stay.
const size = (arr) => arr.reduce((n, l) => n + l.length + 1, 0);
let body = [...detail, ...kept2, ...dumps];
if (size(lines) + size(body) + size(tail) > LOG_BUDGET) body = [...detail, ...kept2];
let room = LOG_BUDGET - size(lines) - size(tail) - 80;
if (size(body) > room) {
  const cut = [];
  let used = 0;
  for (const l of body) {
    if (used + l.length + 1 > room) break;
    cut.push(l);
    used += l.length + 1;
  }
  cut.push(
    `[cut] log budget of ${LOG_BUDGET} bytes reached, ${body.length - cut.length} lines not printed`,
  );
  body = cut;
}
lines.push(...body, ...tail);
console.log(lines.join("\n"));
process.exit(errors.length > 0 || runs === 0 ? 2 : groups.size > 0 ? 1 : 0);
