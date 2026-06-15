// perf_audit runner — orchestrates trace collection + coverage capture +
// network-response gathering for the duration of the audit window, then
// hands the assembled context to `composeReport`.
//
// Kept separate from `perf-audit.ts` (analysers) so the analysers stay
// pure-function + unit-testable, and the runner can be replaced /
// stubbed without dragging the registry along.

import type { CDPSession } from "playwright-core";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import type { TraceEvent } from "./perf.js";
import { CoverageTrackerState, type JsCoverageEntry, type CssCoverageEntry } from "./coverage.js";
import {
  composeReport,
  resolveCategories,
  type AuditCategory,
  type AuditReport,
  type AuditContext,
} from "./perf-audit.js";

const DEFAULT_DURATION_MS = 5_000;
const MAX_DURATION_MS = 30_000;

/** Same broad category set used by the audit's standalone trace window — we
 *  want everything render/loading/longtask-related so the analysers have
 *  enough to look at. */
const AUDIT_TRACE_CATEGORIES = [
  "devtools.timeline",
  "loading",
  "blink.user_timing",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "latencyInfo",
];

export interface RunPerfAuditOptions {
  categories?: string[];
  durationMs?: number;
  format?: "summary" | "full";
}

export interface RunPerfAuditResult {
  report: AuditReport;
  evidence: {
    tracePath: string;
    coveragePath?: string;
    memoryPath?: string;
  };
  durationMs: number;
  categoriesRun: AuditCategory[];
}

function clampDuration(d?: number): number {
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) return DEFAULT_DURATION_MS;
  if (d > MAX_DURATION_MS) return MAX_DURATION_MS;
  return Math.floor(d);
}

function resolveAuditPath(workspaceRoot: string, p: string, tool: string): string {
  const resolved = resolve(workspaceRoot, p);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(`${tool}: \`path\` must resolve inside $BROWX_WORKSPACE — got "${p}".`);
  }
  return resolved;
}

/** Default trace filename under `<workspace>/perf/<sessionId>-audit-<ts>.json`. */
export function defaultAuditTracePath(workspaceRoot: string, sessionId: string): string {
  const safe = (sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(workspaceRoot, "perf", `${safe}-audit-${ts}.json`);
}

function defaultCoveragePath(workspaceRoot: string, sessionId: string): string {
  const safe = (sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(workspaceRoot, "perf", `${safe}-coverage-${ts}.json`);
}

interface NetworkResponseMeta {
  url: string;
  status: number;
  mimeType?: string;
  encodedDataLength?: number;
  cacheControl?: string;
}

/** Run a full performance audit on `cdp`: record a trace + coverage for
 *  `durationMs`, gather network response metadata in parallel, then
 *  compose the report. Writes the trace + coverage to workspace-rooted
 *  files for the agent's reference. */
interface CollectedAuditData {
  traceEvents: TraceEvent[];
  responses: NetworkResponseMeta[];
  jsCoverage?: JsCoverageEntry[];
  cssCoverage?: CssCoverageEntry[];
}

/** Build the CDP network-response listeners, accumulating `responses[]` from
 *  `responseReceived` (+ a best-effort `loadingFinished` size patch). Returns the
 *  listeners + the shared accumulator. */
function makeNetworkListeners(responses: NetworkResponseMeta[]): {
  onResponseReceived: (e: unknown) => void;
  onLoadingFinished: (e: unknown) => void;
} {
  const responseHeaders = new Map<string, Record<string, string>>();
  return {
    onResponseReceived: (raw) => {
      const e = raw as {
        requestId: string;
        response?: {
          url?: string;
          status?: number;
          mimeType?: string;
          encodedDataLength?: number;
          headers?: Record<string, string>;
        };
      };
      const r = e?.response;
      if (!r || typeof r.url !== "string") return;
      const headers = r.headers ?? {};
      responseHeaders.set(e.requestId, headers);
      responses.push({
        url: r.url,
        status: r.status ?? 0,
        mimeType: r.mimeType,
        encodedDataLength: r.encodedDataLength,
        cacheControl: headers["cache-control"] ?? headers["Cache-Control"],
      });
    },
    onLoadingFinished: (raw) => {
      const e = raw as { requestId: string; encodedDataLength?: number };
      if (typeof e.encodedDataLength !== "number" || !responseHeaders.has(e.requestId)) return;
      for (let i = responses.length - 1; i >= 0; i--) {
        if (responses[i]!.encodedDataLength == null || responses[i]!.encodedDataLength === 0) {
          responses[i]!.encodedDataLength = e.encodedDataLength;
          break;
        }
      }
    },
  };
}

/** Run the trace + coverage + network collection window, detaching all listeners
 *  in `finally`. */
async function collectAuditData(cdp: CDPSession, durationMs: number): Promise<CollectedAuditData> {
  const traceEvents: TraceEvent[] = [];
  let traceComplete: (() => void) | null = null;
  const onData = (e: { value: TraceEvent[] }) => {
    if (Array.isArray(e?.value)) for (const ev of e.value) traceEvents.push(ev);
  };
  const onTraceComplete = () => {
    if (traceComplete) traceComplete();
  };
  const responses: NetworkResponseMeta[] = [];
  const net = makeNetworkListeners(responses);
  const coverage = new CoverageTrackerState();
  cdp.on("Tracing.dataCollected", onData);
  cdp.on("Tracing.tracingComplete", onTraceComplete);
  cdp.on("Network.responseReceived", net.onResponseReceived);
  cdp.on("Network.loadingFinished", net.onLoadingFinished);

  const data: CollectedAuditData = { traceEvents, responses };
  try {
    await cdp.send("Network.enable").catch(() => undefined);
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: { recordMode: "recordContinuously", includedCategories: AUDIT_TRACE_CATEGORIES },
    });
    await coverage.start(cdp).catch(() => undefined);
    await new Promise<void>((res) => setTimeout(res, durationMs));
    const traceCompletePromise = new Promise<void>((res) => {
      traceComplete = res;
    });
    await cdp.send("Tracing.end").catch(() => undefined);
    await Promise.race([traceCompletePromise, new Promise<void>((res) => setTimeout(res, 30_000))]);
    const covResult = await coverage.stop(cdp).catch(() => undefined);
    if (covResult && !covResult.notRunning) {
      data.jsCoverage = covResult.jsCoverage;
      data.cssCoverage = covResult.cssCoverage;
    }
  } finally {
    for (const [event, h] of [
      ["Tracing.dataCollected", onData],
      ["Tracing.tracingComplete", onTraceComplete],
      ["Network.responseReceived", net.onResponseReceived],
      ["Network.loadingFinished", net.onLoadingFinished],
    ] as const) {
      try {
        (cdp as unknown as { off: (e: string, fn: unknown) => void }).off(event, h);
      } catch {
        /* best-effort */
      }
    }
  }
  return data;
}

/** Write the trace + coverage evidence files (workspace-rooted) and return their
 *  resolved paths. */
function writeAuditEvidence(
  workspaceRoot: string,
  sessionId: string,
  durationMs: number,
  data: CollectedAuditData,
): { tracePath: string; coveragePath?: string } {
  const resolvedTrace = resolveAuditPath(
    workspaceRoot,
    defaultAuditTracePath(workspaceRoot, sessionId),
    "perf_audit",
  );
  const traceParent = dirname(resolvedTrace);
  if (traceParent && !existsSync(traceParent)) mkdirSync(traceParent, { recursive: true });
  // ws.root-rooted path — resolveAuditPath guards the escape.
  writeFileSync(
    resolvedTrace,
    JSON.stringify({
      traceEvents: data.traceEvents,
      metadata: {
        source: "browxai",
        sessionId,
        categories: AUDIT_TRACE_CATEGORIES,
        durationMs,
        eventCount: data.traceEvents.length,
        capturedAt: new Date().toISOString(),
        kind: "perf-audit",
      },
    }),
    "utf8",
  );
  if (!data.jsCoverage || !data.cssCoverage) return { tracePath: resolvedTrace };
  const resolvedCov = resolveAuditPath(
    workspaceRoot,
    defaultCoveragePath(workspaceRoot, sessionId),
    "perf_audit",
  );
  writeFileSync(
    resolvedCov,
    JSON.stringify({
      jsCoverage: data.jsCoverage,
      cssCoverage: data.cssCoverage,
      durationMs,
      capturedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  return { tracePath: resolvedTrace, coveragePath: resolvedCov };
}

export async function runPerfAudit(
  cdp: CDPSession,
  workspaceRoot: string,
  sessionId: string,
  opts: RunPerfAuditOptions = {},
): Promise<RunPerfAuditResult> {
  const durationMs = clampDuration(opts.durationMs);
  const format = opts.format === "full" ? "full" : "summary";
  const categoriesRun = resolveCategories(opts.categories);

  const data = await collectAuditData(cdp, durationMs);
  const evidencePaths = writeAuditEvidence(workspaceRoot, sessionId, durationMs, data);

  const ctx: AuditContext = {
    trace: data.traceEvents,
    jsCoverage: data.jsCoverage,
    cssCoverage: data.cssCoverage,
    responses: data.responses,
  };
  const report = composeReport(ctx, categoriesRun, format);

  return {
    report,
    evidence: {
      tracePath: evidencePaths.tracePath,
      ...(evidencePaths.coveragePath ? { coveragePath: evidencePaths.coveragePath } : {}),
    },
    durationMs,
    categoriesRun,
  };
}
