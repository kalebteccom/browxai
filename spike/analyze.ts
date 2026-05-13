#!/usr/bin/env tsx
// Post-hoc analysis for spike runs. Reads spike/runs/*.jsonl and prints a per-(task, surface)
// summary: tool-calls total, failed-calls, total wall-clock, and a rough "retry indicator"
// (consecutive same-tool calls with the same arg shape — proxy for the agent grinding).
//
// Writes spike/runs/summary.json. Not pretty — throwaway alongside the spike.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

interface LogEntry {
  ts: string;
  surface: "raw" | "curated";
  task: string;
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
  result_summary?: string;
  error?: string;
}

// No-trace contract: read runs from BROWX_WORKSPACE (default ~/.browxai/), never the cwd.
const WORKSPACE = process.env.BROWX_WORKSPACE
  ? resolve(process.env.BROWX_WORKSPACE)
  : join(homedir(), ".browxai");
const RUNS = join(WORKSPACE, "spike-runs");
if (!existsSync(RUNS)) {
  console.error(`no spike-runs dir at ${RUNS}; set BROWX_WORKSPACE or run the spike first`);
  process.exit(1);
}
const files = readdirSync(RUNS).filter((f) => f.endsWith(".jsonl"));
if (!files.length) {
  console.error(`no runs in ${RUNS}`);
  process.exit(1);
}

interface Bucket {
  task: string; surface: string; file: string;
  total: number; failed: number; ms: number;
  byTool: Record<string, number>;
  retryIndicator: number;   // consecutive same-tool calls with identical-looking args
}

const buckets: Bucket[] = [];

for (const file of files) {
  const path = resolve(RUNS, file);
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (!lines.length) continue;
  const entries = lines.map((l) => JSON.parse(l) as LogEntry);
  const first = entries[0]!;
  const b: Bucket = { task: first.task, surface: first.surface, file: basename(file), total: 0, failed: 0, ms: 0, byTool: {}, retryIndicator: 0 };
  let prev: LogEntry | null = null;
  for (const e of entries) {
    b.total++;
    if (!e.ok) b.failed++;
    b.ms += e.ms;
    b.byTool[e.tool] = (b.byTool[e.tool] ?? 0) + 1;
    if (prev && prev.tool === e.tool && JSON.stringify(prev.args) === JSON.stringify(e.args)) b.retryIndicator++;
    prev = e;
  }
  buckets.push(b);
}

// Group by task → compare surfaces side-by-side.
const tasks = [...new Set(buckets.map((b) => b.task))].sort();
const lines: string[] = [];
lines.push("Phase-0 spike — run summary");
lines.push("");
for (const task of tasks) {
  lines.push(`## task: ${task}`);
  const rows = buckets.filter((b) => b.task === task).sort((a, b) => a.surface.localeCompare(b.surface));
  lines.push(`| surface | tool calls | failed | retry-indicator | wall (s) | top tools |`);
  lines.push(`|---|---:|---:|---:|---:|---|`);
  for (const r of rows) {
    const top = Object.entries(r.byTool).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(", ");
    lines.push(`| ${r.surface} | ${r.total} | ${r.failed} | ${r.retryIndicator} | ${(r.ms / 1000).toFixed(1)} | ${top} |`);
  }
  // Headline ratio.
  const raw = rows.find((r) => r.surface === "raw");
  const cur = rows.find((r) => r.surface === "curated");
  if (raw && cur) {
    const calls = ((raw.total - cur.total) / raw.total * 100).toFixed(1);
    const fails = raw.failed === 0 ? "n/a" : ((raw.failed - cur.failed) / raw.failed * 100).toFixed(1);
    lines.push("");
    lines.push(`**Δ vs. raw:** tool-calls ${calls}% fewer; failed-calls ${fails}% fewer.`);
  }
  lines.push("");
}

const md = lines.join("\n");
console.log(md);
writeFileSync(join(RUNS, "summary.md"), md);
writeFileSync(join(RUNS, "summary.json"), JSON.stringify(buckets, null, 2));
