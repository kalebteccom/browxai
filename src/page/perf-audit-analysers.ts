// perf_audit category analysers — the eight `AuditCategoryAnalyser` functions
// and the `ANALYSERS` registry that maps each category to its analyser. Split
// out of perf-audit.ts so the analysers (the bulk of the file) live apart from
// the report composer; re-exported through `./perf-audit.js`.
//
// RFC 0004 P4 / D6 — `ANALYSERS` is the SINGLE source of truth for the audit
// category set: an add-only registry (one entry per category). The
// `AuditCategory` union and the `ALL_AUDIT_CATEGORIES` array are DERIVED from
// its keys, so adding a category is ONE edit (a new `ANALYSERS` entry) and a
// typo'd category string is a compile error, not a silently-dropped key. This
// makes the perf-audit registry — the doctrine's own cited OCP exemplar
// (architecture-principles §2) — genuinely exemplary.

import type { TraceEvent } from "./perf.js";
import type {
  AuditCategoryAnalyser,
  AuditContext,
  AuditIssue,
  AuditRemediation,
  CategoryResult,
} from "./perf-audit-types.js";

/** The audit category registry — the ONE place a category is declared. Each
 *  key is a category name; each value is its analyser. `as const satisfies`
 *  pins the keys as string literals (so `AuditCategory` derives a closed union)
 *  while still type-checking every value against the analyser signature.
 *
 *  Order is meaningful — issues are surfaced in this order when severity ties. */
export const ANALYSERS = {
  "render-blocking": analyseRenderBlocking,
  "unused-code": analyseUnusedCode,
  "oversize-images": analyseOversizeImages,
  "layout-thrashing": analyseLayoutThrashing,
  "long-tasks": analyseLongTasks,
  "leak-suspects": analyseLeakSuspects,
  "cache-opportunities": analyseCacheOpportunities,
  "font-loading": analyseFontLoading,
} as const satisfies Record<string, AuditCategoryAnalyser>;

/** The closed audit-category vocabulary — DERIVED from `ANALYSERS`'s keys, never
 *  hand-listed. A category exists iff it has an analyser. */
export type AuditCategory = keyof typeof ANALYSERS;

/** Every audit category, in declaration order — DERIVED from `ANALYSERS`. The
 *  `Object.keys` cast is sound because the keys ARE the `AuditCategory` union. */
export const ALL_AUDIT_CATEGORIES = Object.keys(ANALYSERS) as AuditCategory[];

// ---------------------------------------------------------------------------
// Category analysers
// ---------------------------------------------------------------------------

/** render-blocking — `ParseHTML`/`Layout` events with VeryHigh-priority
 *  resources blocking first paint. Heuristic: any `ResourceSendRequest`
 *  with `args.data.renderBlocking == "blocking"` or
 *  `args.data.priority == "VeryHigh"` BEFORE the first `firstPaint` event. */
/** Detect whether a `ResourceSendRequest` event (before first paint) is a render
 *  blocker, returning its `{url, priority}` or null. */
function renderBlocker(
  e: TraceEvent,
  firstPaintTs: number,
): { url: string; priority: string } | null {
  if (e.name !== "ResourceSendRequest") return null;
  const ts = typeof e.ts === "number" ? e.ts : 0;
  if (ts >= firstPaintTs) return null;
  const data = ((e.args ?? {}).data ?? {}) as Record<string, unknown>;
  const url = typeof data.url === "string" ? data.url : "";
  const blocking = typeof data.renderBlocking === "string" ? data.renderBlocking : "";
  const priority = typeof data.priority === "string" ? data.priority : "";
  if (!url) return null;
  const isBlocker =
    blocking === "blocking" || blocking === "in_body_parser_blocking" || priority === "VeryHigh";
  return isBlocker ? { url, priority: priority || blocking } : null;
}

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
    const b = renderBlocker(e, firstPaintTs);
    if (b) blockers.push(b);
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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);

/** Record one oversize image (deduped) into the issue/remediation accumulators. */
function pushOversizeImage(
  acc: { issues: AuditIssue[]; remediations: AuditRemediation[]; seen: Set<string> },
  url: string,
  bytes: number,
  action: string,
  extraDetails: Record<string, unknown> = {},
): void {
  if (acc.seen.has(url)) return;
  acc.seen.add(url);
  acc.issues.push({
    category: "oversize-images",
    severity: bytes > 2_000_000 ? "high" : "medium",
    title: `Oversize image: ${url} (${Math.round(bytes / 1024)}KB)`,
    details: { url, bytes, ...extraDetails },
  });
  acc.remediations.push({ category: "oversize-images", action, target: url });
}

/** oversize-images — images > 500KB. */
export function analyseOversizeImages(ctx: AuditContext): CategoryResult {
  const acc = { issues: [] as AuditIssue[], remediations: [] as AuditRemediation[], seen: new Set<string>() };
  // Prefer network responses metadata; fall back to ResourceFinish events.
  for (const r of ctx.responses ?? []) {
    if (!r.mimeType?.startsWith("image/")) continue;
    const bytes = r.encodedDataLength ?? 0;
    if (bytes < 500_000) continue;
    pushOversizeImage(
      acc,
      r.url,
      bytes,
      "Compress + resize to displayed dimensions; switch to AVIF/WebP; add srcset for responsive sizing.",
      { mimeType: r.mimeType },
    );
  }
  for (const e of ctx.trace) {
    const img = oversizeImageFromTrace(e);
    if (img) {
      pushOversizeImage(
        acc,
        img.url,
        img.bytes,
        "Compress + resize to displayed dimensions; switch to AVIF/WebP.",
      );
    }
  }
  return { issues: acc.issues, remediations: acc.remediations };
}

/** Pull an oversize-image `{url, bytes}` out of a `ResourceFinish` trace event
 *  (image extension + ≥500KB), or null. */
function oversizeImageFromTrace(e: TraceEvent): { url: string; bytes: number } | null {
  if (e.name !== "ResourceFinish") return null;
  const data = ((e.args ?? {}).data ?? {}) as Record<string, unknown>;
  const url = typeof data.url === "string" ? data.url : "";
  const bytes = typeof data.encodedDataLength === "number" ? data.encodedDataLength : 0;
  if (!url || bytes < 500_000) return null;
  const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext) ? { url, bytes } : null;
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
