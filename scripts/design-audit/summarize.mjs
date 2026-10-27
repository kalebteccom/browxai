// Print the design-audit findings as one delimited block and exit non-zero when there are any.
// Usage: node summarize.mjs <out-dir> <themes-file>
// Reads imp-<theme>-<width>-<page>.{json,rc,err} (impeccable) and hm-<theme>-<page>.{json,rc,err} (hallmark).
// Identical findings across themes and widths are merged into one line with the variants listed.
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
const lines = [];
lines.push("===== DESIGN-AUDIT FINDINGS BEGIN =====");
lines.push(
  `runs: ${runs}, themes: ${themes.join(", ") || "none"}, widths: impeccable 320/390/1440, hallmark fixed set`,
);
lines.push(`findings: ${groups.size} distinct, tool errors: ${errors.length}`);
const byTool = [...groups.values()].sort((a, b) =>
  `${a.tool}${a.page}${a.label}`.localeCompare(`${b.tool}${b.page}${b.label}`),
);
for (const g of byTool) {
  lines.push(`[${g.tool}] ${g.page} ${g.label} (${[...g.variants].sort().join(" ")})`);
  if (g.detail) lines.push(`    ${g.detail}`);
}
for (const k of kept) lines.push(k);
if (tallies.size)
  lines.push(
    `not failing, hallmark: ${[...tallies].map(([grade, n]) => `${grade} ${n}`).join(", ")}`,
  );
// Dumps print home, tool-reference and threat-model first so a truncated log still has them.
const first = ["dump-home", "dump-reference_tool-reference", "dump-security_threat-model"];
const rank = (f) => {
  const i = first.findIndex((p) => f.startsWith(p));
  return i < 0 ? first.length : i;
};
let dumpBytes = 0;
for (const file of readdirSync(outDir)
  .filter((f) => /^dump-.*\.txt$/.test(f))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
  const text = read(join(outDir, file)).trim();
  if (!text) continue;
  dumpBytes += text.length + 1;
  lines.push(text.slice(0, 1500));
}
lines.push(`[dump] total ${dumpBytes} bytes`);
for (const e of errors) lines.push(`[tool error] ${e}`);
for (const g of gaps) lines.push(`[gap] ${g}`);
lines.push("===== DESIGN-AUDIT FINDINGS END =====");
console.log(lines.join("\n"));
process.exit(errors.length > 0 || runs === 0 ? 2 : groups.size > 0 ? 1 : 0);
