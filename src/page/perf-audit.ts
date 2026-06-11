// perf_audit — capability `read`. The headline tool.
//
// Promotes browxai's perf surface from *measurement* (`perf_start/stop/insights`)
// to *actionable* — agents get a structured audit with remediation hints, not
// a raw 100MB trace blob.
//
// Internally pluggable: each category is an `AuditCategoryAnalyser` function
// in the registry below. Adding a category = adding a registry entry. The
// public MCP surface is unchanged.
//
// Output budget: `format:"summary"` (default) MUST stay under 2000 tokens.
// `truncateSummaryToBudget` drops the lowest-severity issues + records a
// warning when the cap binds. `format:"full"` is unbounded — the caller
// opts in.

import { estimateTokens } from "../util/tokens.js";
import type { TraceEvent } from "./perf.js";
import type { JsCoverageEntry, CssCoverageEntry } from "./coverage.js";
import type { MemoryDiffResult } from "./memory-diff.js";

/** The eight initial audit categories. Order is meaningful — issues are
 *  surfaced in this order when severity ties. */
export type AuditCategory =
  | "render-blocking"
  | "unused-code"
  | "oversize-images"
  | "layout-thrashing"
  | "long-tasks"
  | "leak-suspects"
  | "cache-opportunities"
  | "font-loading";

export const ALL_AUDIT_CATEGORIES: AuditCategory[] = [
  "render-blocking",
  "unused-code",
  "oversize-images",
  "layout-thrashing",
  "long-tasks",
  "leak-suspects",
  "cache-opportunities",
  "font-loading",
];

export type IssueSeverity = "high" | "medium" | "low";

export interface AuditIssue {
  category: AuditCategory;
  severity: IssueSeverity;
  title: string;
  /** Free-form additional context, structured per category. */
  details?: Record<string, unknown>;
}

export interface AuditRemediation {
  category: AuditCategory;
  /** Imperative one-liner: "Defer non-critical CSS in <head>". */
  action: string;
  /** Optional URL pointing at the offending resource the remediation applies
   *  to (when the analyser identified a specific target). */
  target?: string;
}

export interface CategoryResult {
  issues: AuditIssue[];
  remediations: AuditRemediation[];
}

export interface AuditContext {
  trace: TraceEvent[];
  jsCoverage?: JsCoverageEntry[];
  cssCoverage?: CssCoverageEntry[];
  memoryDiff?: MemoryDiffResult;
  /** Network response metadata, when available, for cache-opportunities
   *  + oversize-images + font-loading categories. */
  responses?: Array<{
    url: string;
    status: number;
    mimeType?: string;
    encodedDataLength?: number;
    cacheControl?: string;
  }>;
}

export type AuditCategoryAnalyser = (ctx: AuditContext) => CategoryResult;

/** Registry — exported so tests can monkey-patch categories, and so future
 *  .x additions are a one-liner change. */
export const ANALYSERS: Record<AuditCategory, AuditCategoryAnalyser> = {
  "render-blocking": analyseRenderBlocking,
  "unused-code": analyseUnusedCode,
  "oversize-images": analyseOversizeImages,
  "layout-thrashing": analyseLayoutThrashing,
  "long-tasks": analyseLongTasks,
  "leak-suspects": analyseLeakSuspects,
  "cache-opportunities": analyseCacheOpportunities,
  "font-loading": analyseFontLoading,
};

// ---------------------------------------------------------------------------
// Category analysers
// ---------------------------------------------------------------------------

/** render-blocking — `ParseHTML`/`Layout` events with VeryHigh-priority
 *  resources blocking first paint. Heuristic: any `ResourceSendRequest`
 *  with `args.data.renderBlocking == "blocking"` or
 *  `args.data.priority == "VeryHigh"` BEFORE the first `firstPaint` event. */
export function analyseRenderBlocking(ctx: AuditContext): CategoryResult {
  let firstPaintTs = Infinity;
  for (const e of ctx.trace) {
    if (e.name === "firstPaint" && typeof e.ts === "number") {
      firstPaintTs = e.ts;
      break;
    }
  }
  const blockers: Array<{ url: string; priority: string }> = [];
  for (const e of ctx.trace) {
    if (e.name !== "ResourceSendRequest") continue;
    const ts = typeof e.ts === "number" ? e.ts : 0;
    if (ts >= firstPaintTs) continue;
    const args = e.args ?? {};
    const data = (args.data ?? {}) as Record<string, unknown>;
    const url = typeof data.url === "string" ? data.url : "";
    const blocking = typeof data.renderBlocking === "string" ? data.renderBlocking : "";
    const priority = typeof data.priority === "string" ? data.priority : "";
    if (!url) continue;
    if (
      blocking === "blocking" ||
      blocking === "in_body_parser_blocking" ||
      priority === "VeryHigh"
    ) {
      blockers.push({ url, priority: priority || blocking });
    }
  }
  const issues: AuditIssue[] = blockers.map((b) => ({
    category: "render-blocking" as const,
    severity:
      b.priority === "VeryHigh" || b.priority === "blocking"
        ? ("high" as const)
        : ("medium" as const),
    title: `Render-blocking resource: ${b.url}`,
    details: { url: b.url, priority: b.priority },
  }));
  const remediations: AuditRemediation[] = blockers.map((b) => ({
    category: "render-blocking" as const,
    action: b.url.endsWith(".css")
      ? "Inline critical CSS in <head>; defer the rest with rel=preload + onload."
      : "Add `defer` or `async` to the script tag, or move below the fold.",
    target: b.url,
  }));
  return { issues, remediations };
}

/** unused-code — scripts + CSS files with `usagePercent < 30`. Severity tied
 *  to absolute waste (bytes), not percent, because a 90%-dead 2KB file
 *  doesn't matter. */
export function analyseUnusedCode(ctx: AuditContext): CategoryResult {
  const issues: AuditIssue[] = [];
  const remediations: AuditRemediation[] = [];
  for (const js of ctx.jsCoverage ?? []) {
    if (js.usagePercent >= 30) continue;
    const wasted = js.totalBytes - js.usedBytes;
    if (wasted < 5000) continue;
    issues.push({
      category: "unused-code",
      severity: wasted > 100_000 ? "high" : wasted > 20_000 ? "medium" : "low",
      title: `Unused JS in ${js.url}: ${Math.round(wasted / 1024)}KB dead (${js.usagePercent}% used)`,
      details: {
        url: js.url,
        totalBytes: js.totalBytes,
        usedBytes: js.usedBytes,
        usagePercent: js.usagePercent,
      },
    });
    remediations.push({
      category: "unused-code",
      action: "Tree-shake / code-split this bundle; dead code is the largest opportunity.",
      target: js.url,
    });
  }
  for (const css of ctx.cssCoverage ?? []) {
    if (css.usagePercent >= 30) continue;
    const wasted = css.totalBytes - css.usedBytes;
    if (wasted < 5000) continue;
    issues.push({
      category: "unused-code",
      severity: wasted > 50_000 ? "high" : wasted > 10_000 ? "medium" : "low",
      title: `Unused CSS in ${css.url}: ${Math.round(wasted / 1024)}KB dead (${css.usagePercent}% used)`,
      details: {
        url: css.url,
        totalBytes: css.totalBytes,
        usedBytes: css.usedBytes,
        usagePercent: css.usagePercent,
      },
    });
    remediations.push({
      category: "unused-code",
      action: "PurgeCSS / Tailwind-style on-demand generation; ship only selectors the page uses.",
      target: css.url,
    });
  }
  return { issues, remediations };
}

/** oversize-images — images > 500KB. */
export function analyseOversizeImages(ctx: AuditContext): CategoryResult {
  const issues: AuditIssue[] = [];
  const remediations: AuditRemediation[] = [];
  // Prefer network responses metadata; fall back to ResourceFinish events.
  const seen = new Set<string>();
  for (const r of ctx.responses ?? []) {
    if (!r.mimeType || !r.mimeType.startsWith("image/")) continue;
    const bytes = r.encodedDataLength ?? 0;
    if (bytes < 500_000) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    issues.push({
      category: "oversize-images",
      severity: bytes > 2_000_000 ? "high" : "medium",
      title: `Oversize image: ${r.url} (${Math.round(bytes / 1024)}KB)`,
      details: { url: r.url, bytes, mimeType: r.mimeType },
    });
    remediations.push({
      category: "oversize-images",
      action:
        "Compress + resize to displayed dimensions; switch to AVIF/WebP; add srcset for responsive sizing.",
      target: r.url,
    });
  }
  for (const e of ctx.trace) {
    if (e.name !== "ResourceFinish") continue;
    const args = e.args ?? {};
    const data = (args.data ?? {}) as Record<string, unknown>;
    const url = typeof data.url === "string" ? data.url : "";
    const bytes = typeof data.encodedDataLength === "number" ? data.encodedDataLength : 0;
    if (!url || bytes < 500_000) continue;
    // Best-effort mime guess by extension.
    const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
    if (!["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(ext)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    issues.push({
      category: "oversize-images",
      severity: bytes > 2_000_000 ? "high" : "medium",
      title: `Oversize image: ${url} (${Math.round(bytes / 1024)}KB)`,
      details: { url, bytes },
    });
    remediations.push({
      category: "oversize-images",
      action: "Compress + resize to displayed dimensions; switch to AVIF/WebP.",
      target: url,
    });
  }
  return { issues, remediations };
}

/** layout-thrashing — > 5 forced sync layouts. */
export function analyseLayoutThrashing(ctx: AuditContext): CategoryResult {
  let forcedCount = 0;
  let shiftCount = 0;
  for (const e of ctx.trace) {
    if (e.name === "LayoutShift") shiftCount++;
    if (e.name === "ForcedSyncLayout") forcedCount++;
    if (e.name === "Layout" && hasForcedFlag(e)) forcedCount++;
  }
  const issues: AuditIssue[] = [];
  const remediations: AuditRemediation[] = [];
  if (forcedCount > 5) {
    issues.push({
      category: "layout-thrashing",
      severity: forcedCount > 50 ? "high" : forcedCount > 20 ? "medium" : "low",
      title: `${forcedCount} forced synchronous layouts in window`,
      details: { forcedCount, layoutShiftCount: shiftCount },
    });
    remediations.push({
      category: "layout-thrashing",
      action:
        "Batch DOM reads + writes; avoid alternating offsetWidth/offsetHeight measurements with style writes.",
    });
  }
  return { issues, remediations };
}

function hasForcedFlag(e: TraceEvent): boolean {
  const args = e.args as
    | { beginData?: Record<string, unknown>; data?: Record<string, unknown> }
    | undefined;
  if (!args) return false;
  const data = args.data ?? args.beginData ?? {};
  return Array.isArray(data.stackTrace) && (data.stackTrace as unknown[]).length > 0;
}

/** long-tasks — `RunTask` events > 50ms. */
export function analyseLongTasks(ctx: AuditContext): CategoryResult {
  const tasks: Array<{ durationMs: number }> = [];
  for (const e of ctx.trace) {
    if (e.name !== "RunTask" && e.name !== "LongTask") continue;
    const dur = typeof e.dur === "number" ? e.dur / 1000 : 0;
    if (dur >= 50) tasks.push({ durationMs: dur });
  }
  tasks.sort((a, b) => b.durationMs - a.durationMs);
  const issues: AuditIssue[] = tasks.map((t) => ({
    category: "long-tasks" as const,
    severity:
      t.durationMs > 200
        ? ("high" as const)
        : t.durationMs > 100
          ? ("medium" as const)
          : ("low" as const),
    title: `Long task: ${Math.round(t.durationMs)}ms blocking main thread`,
    details: { durationMs: t.durationMs },
  }));
  const remediations: AuditRemediation[] =
    tasks.length > 0
      ? [
          {
            category: "long-tasks",
            action:
              "Yield to the event loop with scheduler.postTask() or requestIdleCallback; move heavy work to a Web Worker.",
          },
        ]
      : [];
  return { issues, remediations };
}

/** leak-suspects — retainer-growth rows with deltaPercent > 10. */
export function analyseLeakSuspects(ctx: AuditContext): CategoryResult {
  const issues: AuditIssue[] = [];
  const remediations: AuditRemediation[] = [];
  if (!ctx.memoryDiff) return { issues, remediations };
  for (const row of ctx.memoryDiff.retainerGrowth) {
    const pct = row.deltaPercent === "+inf" ? Infinity : row.deltaPercent;
    if (pct <= 10) continue;
    if (row.deltaBytes <= 0) continue;
    issues.push({
      category: "leak-suspects",
      severity: row.deltaBytes > 1_000_000 ? "high" : row.deltaBytes > 100_000 ? "medium" : "low",
      title: `Retainer growth: ${row.node} +${Math.round(row.deltaBytes / 1024)}KB (${row.deltaPercent}%)`,
      details: {
        node: row.node,
        type: row.type,
        deltaBytes: row.deltaBytes,
        deltaPercent: row.deltaPercent,
      },
    });
    remediations.push({
      category: "leak-suspects",
      action:
        "Check listeners + cached references on this type; pair with heap_retainers({snapshotPath, query:{name}}) for the retention path.",
      target: row.node,
    });
  }
  return { issues, remediations };
}

/** cache-opportunities — static assets missing `Cache-Control` header. */
export function analyseCacheOpportunities(ctx: AuditContext): CategoryResult {
  const issues: AuditIssue[] = [];
  const remediations: AuditRemediation[] = [];
  const seen = new Set<string>();
  for (const r of ctx.responses ?? []) {
    if (r.status !== 200) continue;
    const ext = r.url.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
    const isStatic = [
      "js",
      "css",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "svg",
      "woff",
      "woff2",
      "ttf",
    ].includes(ext);
    if (!isStatic) continue;
    if (r.cacheControl && /max-age=\d+/i.test(r.cacheControl)) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    issues.push({
      category: "cache-opportunities",
      severity: "medium",
      title: `Missing/short Cache-Control on static asset: ${r.url}`,
      details: { url: r.url, cacheControl: r.cacheControl ?? null },
    });
    remediations.push({
      category: "cache-opportunities",
      action:
        "Add Cache-Control: public, max-age=31536000, immutable on content-hashed static assets.",
      target: r.url,
    });
  }
  return { issues, remediations };
}

/** font-loading — fonts loaded > 200ms after document start. */
export function analyseFontLoading(ctx: AuditContext): CategoryResult {
  let docStartMs = 0;
  for (const e of ctx.trace) {
    if (e.name === "navigationStart" && typeof e.ts === "number") {
      docStartMs = e.ts / 1000;
      break;
    }
  }
  const fontLoads: Array<{ url: string; offsetMs: number }> = [];
  for (const e of ctx.trace) {
    if (e.name !== "ResourceFinish") continue;
    const args = e.args ?? {};
    const data = (args.data ?? {}) as Record<string, unknown>;
    const url = typeof data.url === "string" ? data.url : "";
    const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
    if (!["woff", "woff2", "ttf", "otf"].includes(ext)) continue;
    const ts = typeof e.ts === "number" ? e.ts / 1000 : 0;
    const offset = ts - docStartMs;
    if (offset > 200) fontLoads.push({ url, offsetMs: offset });
  }
  const issues: AuditIssue[] = fontLoads.map((f) => ({
    category: "font-loading" as const,
    severity: f.offsetMs > 1000 ? ("high" as const) : ("medium" as const),
    title: `Font loaded ${Math.round(f.offsetMs)}ms after document start: ${f.url}`,
    details: { url: f.url, offsetMs: f.offsetMs },
  }));
  const remediations: AuditRemediation[] = fontLoads.map((f) => ({
    category: "font-loading" as const,
    action:
      "<link rel=preload as=font crossorigin> in <head>, or self-host with font-display: swap.",
    target: f.url,
  }));
  return { issues, remediations };
}

// ---------------------------------------------------------------------------
// Compose the final report
// ---------------------------------------------------------------------------

export interface AuditReport {
  summary: {
    score: number;
    topIssues: Array<{ category: AuditCategory; severity: IssueSeverity; title: string }>;
  };
  byCategory: Record<string, CategoryResult>;
  warnings: string[];
}

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = { high: 10, medium: 4, low: 1 };
const SUMMARY_TOKEN_BUDGET = 2000;
const MAX_PER_CATEGORY_SUMMARY = 3;

/** Compose an audit report from already-collected context. The category set
 *  is the categories the caller asked for (default = all). `format`
 *  controls whether each category's `issues`/`remediations` are capped at
 *  3 (summary mode) or unbounded (full mode). The summary itself (the
 *  short `summary.topIssues` list + score) always exists; in summary mode
 *  the per-category bodies are also capped.
 *
 *  Token-budget enforcement: when `format:"summary"`, the function checks
 *  estimated token count and drops lowest-severity issues + remediations
 *  until under 2000. If even after total trimming the body exceeds the
 *  cap, a `warnings[]` entry surfaces it. */
export function composeReport(
  ctx: AuditContext,
  categories: AuditCategory[],
  format: "summary" | "full",
): AuditReport {
  const byCategory: Record<string, CategoryResult> = {};
  const allIssues: AuditIssue[] = [];
  const warnings: string[] = [];
  for (const cat of categories) {
    const analyser = ANALYSERS[cat];
    if (!analyser) continue;
    try {
      const result = analyser(ctx);
      byCategory[cat] =
        format === "summary" ? capCategory(result, MAX_PER_CATEGORY_SUMMARY) : result;
      for (const i of result.issues) allIssues.push(i);
    } catch (err) {
      warnings.push(
        `Category ${cat} analyser threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      byCategory[cat] = { issues: [], remediations: [] };
    }
  }
  // Score: 100 - sum of severity-weighted issue counts, floored at 0.
  const penalty = allIssues.reduce((s, i) => s + SEVERITY_WEIGHT[i.severity], 0);
  const score = Math.max(0, 100 - penalty);
  const topIssues = pickTopIssues(allIssues);
  const report: AuditReport = {
    summary: { score, topIssues },
    byCategory,
    warnings,
  };
  if (format === "summary") {
    return enforceSummaryBudget(report);
  }
  return report;
}

function capCategory(r: CategoryResult, n: number): CategoryResult {
  // Cap by severity-weighted ordering — high first, then medium, then low.
  const sortedIssues = [...r.issues].sort(
    (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity],
  );
  const keptIssues = sortedIssues.slice(0, n);
  // Remediations don't have severity directly — keep the first N.
  const keptRems: AuditRemediation[] = [];
  for (const rem of r.remediations) {
    if (keptRems.length >= n) break;
    keptRems.push(rem);
  }
  return { issues: keptIssues, remediations: keptRems };
}

function pickTopIssues(
  all: AuditIssue[],
): Array<{ category: AuditCategory; severity: IssueSeverity; title: string }> {
  const sorted = [...all].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
  const top = sorted.slice(0, 10);
  return top.map((i) => ({ category: i.category, severity: i.severity, title: i.title }));
}

/** Drop lowest-severity issues across all categories until estimated tokens
 *  are within the summary budget. Adds a warnings[] entry if the cap binds. */
export function enforceSummaryBudget(report: AuditReport): AuditReport {
  const estimate = () => estimateTokens(JSON.stringify(report));
  if (estimate() <= SUMMARY_TOKEN_BUDGET) return report;
  let dropped = 0;
  // Drop lowest-severity issues + paired remediations.
  const order: IssueSeverity[] = ["low", "medium", "high"];
  for (const sev of order) {
    if (estimate() <= SUMMARY_TOKEN_BUDGET) break;
    for (const cat of Object.keys(report.byCategory)) {
      const r = report.byCategory[cat]!;
      const newIssues: AuditIssue[] = [];
      for (const i of r.issues) {
        if (i.severity === sev && estimate() > SUMMARY_TOKEN_BUDGET) {
          dropped++;
          continue;
        }
        newIssues.push(i);
      }
      r.issues = newIssues;
      // Also trim remediations proportional to issue drops at this severity.
      if (r.remediations.length > r.issues.length) {
        r.remediations = r.remediations.slice(0, Math.max(1, r.issues.length));
      }
      if (estimate() <= SUMMARY_TOKEN_BUDGET) break;
    }
    // After each severity pass, also trim topIssues at the matching severity —
    // the summary section duplicates the heaviest cross-category list, so it
    // can dominate the budget on its own.
    if (estimate() > SUMMARY_TOKEN_BUDGET) {
      const before = report.summary.topIssues.length;
      report.summary.topIssues = report.summary.topIssues.filter((t) => t.severity !== sev);
      dropped += before - report.summary.topIssues.length;
    }
  }
  // If still over budget, trim topIssues + remaining categories aggressively.
  while (report.summary.topIssues.length > 1 && estimate() > SUMMARY_TOKEN_BUDGET) {
    report.summary.topIssues.pop();
    dropped++;
  }
  while (estimate() > SUMMARY_TOKEN_BUDGET) {
    let trimmed = false;
    for (const cat of Object.keys(report.byCategory)) {
      const r = report.byCategory[cat]!;
      if (r.issues.length > 0) {
        r.issues.pop();
        if (r.remediations.length > r.issues.length) r.remediations.pop();
        dropped++;
        trimmed = true;
        if (estimate() <= SUMMARY_TOKEN_BUDGET) break;
      }
    }
    if (!trimmed) break;
  }
  if (dropped > 0) {
    report.warnings.push(
      `summary token budget enforced (${SUMMARY_TOKEN_BUDGET}): dropped ${dropped} low/medium severity entries. Re-run with format:"full" for the full report.`,
    );
  }
  return report;
}

/** Resolve the requested category set — empty/undefined → all. Unknown
 *  category names are dropped silently. */
export function resolveCategories(requested?: string[]): AuditCategory[] {
  if (!requested || requested.length === 0) return [...ALL_AUDIT_CATEGORIES];
  const out: AuditCategory[] = [];
  for (const c of requested) {
    if (ALL_AUDIT_CATEGORIES.includes(c as AuditCategory)) out.push(c as AuditCategory);
  }
  if (out.length === 0) return [...ALL_AUDIT_CATEGORIES];
  return out;
}
