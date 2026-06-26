// Diagnostics — read-side report aggregation.
//
// . Pure read-side: given an enumerated set of `DiagnosticsRecord`s (produced
// by the recorder's `readAll`), roll them up into the `ReportSummary` the
// `diagnostics_report` tool surfaces. No recorder / IO / retention dependency
// — this imports only the shared record types from the redaction leaf, so it
// never closes a cycle back through the recorder.

import type { DiagnosticsRecord, EvalTaxonomy } from "./diagnostics-redact.js";

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Compute the percentile (p50, p95) over an unsorted number array. */
function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((pct / 100) * (sorted.length - 1))),
  );
  return sorted[idx] ?? 0;
}

export interface ReportSummary {
  perTool: Record<
    string,
    { count: number; failureCount: number; p50Duration: number; p95Duration: number }
  >;
  topEvalJsPatterns: Array<{
    exprSha: string;
    exprHead: string;
    count: number;
    taxonomy: EvalTaxonomy;
  }>;
  capabilityDenials: Record<string, number>;
  notesByCategory: Record<string, number>;
  missingPrimitiveHypotheses: Array<{ taxonomy: EvalTaxonomy; sampleHead: string; count: number }>;
}

export function buildReportSummary(
  records: DiagnosticsRecord[],
  opts: { since?: string; session?: string } = {},
): ReportSummary {
  const sinceMs = opts.since ? Date.parse(opts.since) : undefined;
  const perTool = new Map<string, { count: number; failureCount: number; durations: number[] }>();
  const evalByPattern = new Map<
    string,
    { count: number; exprHead: string; taxonomy: EvalTaxonomy }
  >();
  const capabilityDenials: Record<string, number> = {};
  const notesByCategory: Record<string, number> = {};
  const evalTaxonomyCounts = new Map<EvalTaxonomy, { count: number; sampleHead: string }>();

  for (const r of records) {
    if (sinceMs !== undefined && Date.parse(r.ts) < sinceMs) continue;
    if (opts.session && r.sessionId !== opts.session) continue;
    if (r.kind === "note") {
      notesByCategory[r.category] = (notesByCategory[r.category] ?? 0) + 1;
      continue;
    }
    // call record
    const row = perTool.get(r.tool) ?? { count: 0, failureCount: 0, durations: [] };
    row.count += 1;
    if (!r.resultMeta.ok) row.failureCount += 1;
    row.durations.push(r.durationMs);
    perTool.set(r.tool, row);
    if (r.resultMeta.failureKind === "capability-denied") {
      // Pull the capability name from the tool's static map if available.
      // We don't import the map here (avoid a cycle); the report tool injects
      // a hint via the dispatcher. For now bucket by tool name — the report
      // tool overlay rewrites this to capability where possible.
      capabilityDenials[r.tool] = (capabilityDenials[r.tool] ?? 0) + 1;
    }
    if (r.evalJs) {
      const e = evalByPattern.get(r.evalJs.exprSha) ?? {
        count: 0,
        exprHead: r.evalJs.exprHead,
        taxonomy: r.evalJs.taxonomy,
      };
      e.count += 1;
      evalByPattern.set(r.evalJs.exprSha, e);
      const t = evalTaxonomyCounts.get(r.evalJs.taxonomy) ?? {
        count: 0,
        sampleHead: r.evalJs.exprHead,
      };
      t.count += 1;
      evalTaxonomyCounts.set(r.evalJs.taxonomy, t);
    }
  }

  const perToolOut: ReportSummary["perTool"] = {};
  for (const [tool, row] of perTool) {
    perToolOut[tool] = {
      count: row.count,
      failureCount: row.failureCount,
      p50Duration: percentile(row.durations, 50),
      p95Duration: percentile(row.durations, 95),
    };
  }

  const topEvalJsPatterns: ReportSummary["topEvalJsPatterns"] = [];
  for (const [exprSha, info] of evalByPattern) {
    topEvalJsPatterns.push({
      exprSha,
      exprHead: info.exprHead,
      count: info.count,
      taxonomy: info.taxonomy,
    });
  }
  topEvalJsPatterns.sort((a, b) => b.count - a.count);
  topEvalJsPatterns.splice(10); // top 10

  const missingPrimitiveHypotheses: ReportSummary["missingPrimitiveHypotheses"] = [];
  for (const [taxonomy, info] of evalTaxonomyCounts) {
    // Heuristic: non-custom with count >= 3 OR custom with count >= 5.
    const threshold = taxonomy === "custom" ? 5 : 3;
    if (info.count >= threshold) {
      missingPrimitiveHypotheses.push({ taxonomy, sampleHead: info.sampleHead, count: info.count });
    }
  }
  missingPrimitiveHypotheses.sort((a, b) => b.count - a.count);

  return {
    perTool: perToolOut,
    topEvalJsPatterns,
    capabilityDenials,
    notesByCategory,
    missingPrimitiveHypotheses,
  };
}
