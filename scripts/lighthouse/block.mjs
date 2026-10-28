// Pure helpers for the docs-site Lighthouse run: failed-audit extraction, median and spread, the compact output block, chunking.
// No I/O here; run.mjs collects the runs, report.mjs prints them, test/scripts/lighthouse-block.test.ts covers these functions.
//
// THRESHOLDS (the exit status of report.mjs). The MEDIAN of the 3 runs of each page+preset must reach these, else exit 1:
//   performance    >= 0.9
//   accessibility  >= 1
//   best-practices >= 1
//   seo            >= 1
// Exit 2 is a tool error (a run that threw, a page that did not answer 200 without a redirect, no runs at all).
// The same numbers are repeated in .woodpecker/lighthouse.yml; change both together.

export const THRESHOLDS = {
  performance: 0.9,
  accessibility: 1,
  "best-practices": 1,
  seo: 1,
};
export const CATEGORIES = Object.keys(THRESHOLDS);
// Short names for the score line.
const SHORT = { performance: "perf", accessibility: "a11y", "best-practices": "bp", seo: "seo" };

/** Total size of the plain text block, below the 40 KB cap that covers the text and its chunked copy. */
export const TEXT_BUDGET = 19000;
export const CHUNK_BYTES = 1500;
const MAX_LINE = 1400;
const NODE_CLIP = 100;
const NODES_PER_AUDIT = 3;

const ascii = (s) => String(s ?? "").replace(/[^\x20-\x7e]/g, "?");
export const clip = (text, n) => {
  const flat = ascii(
    String(text ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return flat.length > n ? `${flat.slice(0, n - 3)}...` : flat;
};
const bytes = (s) => Buffer.byteLength(s, "utf8");

/** Median of a non-empty number list (the middle value of an odd list, the mean of the middle two otherwise). */
export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
/** Run-to-run spread: largest minus smallest. */
export const spread = (values) => Math.max(...values) - Math.min(...values);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Selector or snippet of the first NODES_PER_AUDIT offending items of an audit, each trimmed to 100 characters. */
function offenders(audit) {
  const out = [];
  for (const item of audit.details?.items ?? []) {
    const n = item?.node ?? item?.subItems?.items?.find((s) => s?.node)?.node;
    const label = n ? [n.selector, n.snippet].filter(Boolean).join(" | ") : (item?.url ?? "");
    if (label) out.push(clip(label, NODE_CLIP));
    if (out.length === NODES_PER_AUDIT) break;
  }
  return out;
}

/** Audits of the four categories that did not pass: binary under 1, numeric and metricSavings under 0.9 (the scale Lighthouse calls "needs improvement"). */
export function failedAudits(lhr) {
  const seen = new Map();
  for (const cat of CATEGORIES) {
    for (const ref of lhr.categories?.[cat]?.auditRefs ?? []) {
      const a = lhr.audits?.[ref.id];
      if (!a || a.score === null || a.score === undefined) continue;
      const limit = a.scoreDisplayMode === "binary" ? 1 : 0.9;
      if (!["binary", "numeric", "metricSavings"].includes(a.scoreDisplayMode)) continue;
      if (a.score >= limit) continue;
      if (seen.has(a.id)) seen.get(a.id).cats.push(SHORT[cat]);
      else {
        seen.set(a.id, {
          id: a.id,
          cats: [SHORT[cat]],
          title: clip(a.title, 100),
          score: a.score,
          value: clip(a.displayValue ?? "", 100),
          nodes: offenders(a),
        });
      }
    }
  }
  return [...seen.values()];
}

/** Scores of one run: { performance: 0.93, ... } (null for a category Lighthouse could not score). */
export function scoresOf(lhr) {
  return Object.fromEntries(CATEGORIES.map((c) => [c, lhr.categories?.[c]?.score ?? null]));
}

/**
 * Fold the runs of one page+preset into medians, spreads and the failures of the median-performance run.
 * A run is { scores, failures, load, error? }; runs with an error are counted, not scored.
 */
export function summarize(runs) {
  const ok = runs.filter(
    (r) => !r.error && CATEGORIES.every((c) => typeof r.scores?.[c] === "number"),
  );
  if (!ok.length)
    return { runs: runs.length, ok: 0, errors: runs.filter((r) => r.error).map((r) => r.error) };
  const medians = {};
  const spreads = {};
  for (const c of CATEGORIES) {
    const vals = ok.map((r) => r.scores[c]);
    medians[c] = median(vals);
    spreads[c] = spread(vals);
  }
  // The run whose performance score is the middle one (the lower middle for an even count) supplies the failed audits.
  const byPerf = [...ok].sort((a, b) => a.scores.performance - b.scores.performance);
  const rep = byPerf[(byPerf.length - 1) >> 1];
  const below = CATEGORIES.filter((c) => medians[c] < THRESHOLDS[c]);
  return {
    runs: runs.length,
    ok: ok.length,
    errors: runs.filter((r) => r.error).map((r) => r.error),
    medians,
    spreads,
    below,
    failures: rep.failures,
    loads: runs.map((r) => r.load),
  };
}

/** Header lines with the box load, from the uptime and nproc captured at the start and end of the run. */
export function boxLines(meta) {
  return [
    `lighthouse ${meta.lighthouseVersion} | ${meta.chrome} | ${meta.runsPerPage} runs per page+preset, median reported`,
    `box start: ${clip(meta.start?.uptime, 120)} | nproc ${meta.start?.nproc}`,
    `box end: ${clip(meta.end?.uptime, 120)} | nproc ${meta.end?.nproc}`,
    `benchmarkIndex per run (CPU speed seen by Lighthouse, mobile slowdown is scaled by it): ${clip(meta.benchmarks?.join(" "), 400)}`,
    `thresholds: ${CATEGORIES.map((c) => `${SHORT[c]}>=${THRESHOLDS[c]}`).join(" ")} (median of the runs)`,
  ];
}

/** One score line plus the failed audits of a page+preset. */
export function pageLines(label, s) {
  if (!s.ok) {
    return [
      `${label} TOOL ERROR: no usable run (${s.runs} tried): ${clip(s.errors.join("; "), 300)}`,
    ];
  }
  const scores = CATEGORIES.map(
    (c) => `${SHORT[c]} ${fmt(s.medians[c])} (spread ${fmt(s.spreads[c])})`,
  ).join(" | ");
  const flag = s.below.length ? ` BELOW: ${s.below.map((c) => SHORT[c]).join(",")}` : "";
  const errs = s.errors.length
    ? ` | ${s.errors.length} of ${s.runs} runs failed: ${clip(s.errors[0], 120)}`
    : "";
  const lines = [
    `${label} ${scores} | ok ${s.ok}/${s.runs} | load1 ${s.loads.map((l) => fmt(Number(l))).join("/")}${flag}${errs}`,
  ];
  for (const f of s.failures) {
    lines.push(
      `  FAIL ${f.id} [${f.cats.join(",")}] ${fmt(f.score)} "${f.title}"${f.value ? ` -- ${f.value}` : ""}`,
    );
    for (const n of f.nodes) lines.push(`    node: ${n}`);
  }
  return lines;
}

/** Fit lines into a byte budget: node lines go first, then trailing lines; a marker says what was cut. */
export function fit(lines, budget = TEXT_BUDGET) {
  const size = (ls) => bytes(ls.join("\n")) + 1;
  if (size(lines) <= budget) return lines;
  let out = lines.filter((l) => !l.startsWith("    node: "));
  let cut = lines.length - out.length;
  const note = () => `... truncated: ${cut} lines dropped to stay under ${budget} bytes`;
  while (out.length > 1 && size([...out, note()]) > budget) {
    out.pop();
    cut += 1;
  }
  out = [...out, note()];
  return out;
}

/** Split text into chunks of at most CHUNK_BYTES of content; every printed line is `LH|n|<text>` and at most 1.5 KB. */
export function chunk(text) {
  const out = [];
  let n = 1;
  let used = 0;
  for (const raw of text.split("\n")) {
    for (let i = 0; i === 0 || i < raw.length; i += MAX_LINE) {
      const piece = raw.slice(i, i + MAX_LINE);
      if (used > 0 && used + bytes(piece) + 1 > CHUNK_BYTES) {
        n += 1;
        used = 0;
      }
      out.push(`LH|${n}|${piece}`);
      used += bytes(piece) + 1;
    }
  }
  return out;
}

/** The whole block: BEGIN, plain text, chunked copy, END. */
export function renderBlock(headers, pages) {
  const lines = fit([...headers, ...pages.flat()]);
  const text = lines.join("\n");
  return ["===== LIGHTHOUSE BEGIN =====", text, ...chunk(text), "===== LIGHTHOUSE END ====="].join(
    "\n",
  );
}
