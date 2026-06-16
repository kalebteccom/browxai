import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST, HARNESS_CAPABILITIES } from "../../../src/harness/manifest.js";
import type { Capability } from "../../../src/harness/types.js";
import type { DogfoodRunConfig } from "../config.js";
import type { DogfoodMission } from "../missions/schema.js";
import { coverageEligibleOutcome } from "../trace/codex-normalizer.js";
import type { ToolEvent, TraceRecord } from "../trace/trace-record.js";
import type {
  CapabilityFrictionRollup,
  DogfoodReport,
  FrictionMetric,
  MissionOutcome,
  MissionRunOutcome,
  NormalizedDogfoodReport,
  OracleToolOutcome,
} from "./schema.js";

export interface ReportTraceInput {
  readonly mission: DogfoodMission;
  readonly trace: TraceRecord;
  readonly tracePath: string;
  readonly oracleResults: readonly OracleToolOutcome[];
}

export interface GitMetadata {
  readonly sha: string;
  readonly dirty: boolean;
}

export interface ReportGenerationInput {
  readonly config: DogfoodRunConfig;
  readonly testbedBaseUrl: string;
  readonly catalog: readonly DogfoodMission[];
  readonly traces: readonly ReportTraceInput[];
  readonly git: GitMetadata;
}

export interface ReportPaths {
  readonly json: string;
  readonly markdown: string;
  readonly normalizedJson: string;
}

const manifestByTool = new Map(MANIFEST.map((row) => [row.tool, row]));

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function pct(touched: number, total: number): number {
  return total === 0 ? 100 : Math.round((touched / total) * 10_000) / 100;
}

function isEventCovered(event: ToolEvent): boolean {
  return (
    event.server === "browxai" &&
    manifestByTool.has(event.tool) &&
    coverageEligibleOutcome(event.coverageOutcome)
  );
}

function trimMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sortedValues = [...values].sort((a, b) => a - b);
  const sample = sortedValues.length >= 5 ? sortedValues.slice(1, -1) : sortedValues;
  return Math.round(sample.reduce((sum, value) => sum + value, 0) / sample.length);
}

function eventHasFriction(event: ToolEvent): boolean {
  return (
    event.coverageOutcome === "error" ||
    event.coverageOutcome === "schema_error" ||
    event.coverageOutcome === "abandoned" ||
    event.retried ||
    event.changedArgumentRetry ||
    event.wrongToolAttempt
  );
}

function oraclePassed(results: readonly OracleToolOutcome[]): boolean {
  return results.every((result) => result.outcome === "pass" || result.outcome === "skip");
}

function runOutcome(input: ReportTraceInput): MissionRunOutcome {
  const coveredTools = new Set(
    input.trace.toolEvents.filter(isEventCovered).map((event) => event.tool),
  );
  const required = new Set(input.mission.expectedTools);
  const missing = sorted([...required].filter((tool) => !coveredTools.has(tool)));
  const touched = sorted([...coveredTools].filter((tool) => required.has(tool)));
  const coverageComplete = missing.length === 0;
  const marker = input.trace.missionMarker;
  const finalMarkerPresent = marker !== undefined;
  const markerDone = marker?.status === "done";
  const oracleOk = oraclePassed(input.oracleResults);
  const termination = input.trace.termination;
  const frictionCount = input.trace.toolEvents.filter(eventHasFriction).length;
  const forcedIncomplete =
    termination?.kind === "timed_out" ||
    termination?.kind === "budget_exhausted" ||
    termination?.kind === "errored";
  const passed = !forcedIncomplete && finalMarkerPresent && markerDone && oracleOk && coverageComplete;
  const status: MissionRunOutcome["status"] = passed
    ? frictionCount > 0
      ? "passed_with_friction"
      : "passed"
    : forcedIncomplete || !coverageComplete
      ? "incomplete"
      : "failed";
  const failReason = passed
    ? undefined
    : termination?.reason !== undefined
      ? termination.reason
      : !finalMarkerPresent
      ? "missing final marker"
      : !markerDone
        ? "agent reported blocked"
        : !oracleOk
          ? "oracle failure"
          : !coverageComplete
            ? "agent coverage incomplete"
            : "mission failed";
  const finalAssistant = input.trace.turns
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n")
    .slice(0, 1000);
  return {
    runIndex: input.trace.runIndex,
    passed,
    status,
    coverageComplete,
    toolsTouched: touched,
    toolsMissing: missing,
    finalMarkerPresent,
    oraclePassed: oracleOk,
    frictionCount,
    ...(failReason !== undefined ? { failReason } : {}),
    agentReflection: marker?.reflection ?? finalAssistant,
    oracleResults: input.oracleResults,
  };
}

function missionOutcomes(inputs: readonly ReportTraceInput[]): Record<string, MissionOutcome> {
  const byMission = new Map<string, ReportTraceInput[]>();
  for (const input of inputs) {
    const rows = byMission.get(input.mission.id) ?? [];
    rows.push(input);
    byMission.set(input.mission.id, rows);
  }
  const out: Record<string, MissionOutcome> = {};
  for (const [missionId, rows] of byMission) {
    const runs = rows.map(runOutcome).sort((a, b) => a.runIndex - b.runIndex);
    const passCount = runs.filter((run) => run.passed).length;
    const runCount = runs.length;
    const requiredPassCount = runCount === 1 ? 1 : Math.ceil(0.8 * runCount);
    const stability: MissionOutcome["stability"] =
      runCount === 1
        ? "single-run"
        : passCount >= requiredPassCount
          ? "stable_pass"
          : passCount > 0
            ? "unstable_pass"
            : "stable_fail";
    const required = new Set(rows[0]?.mission.expectedTools ?? []);
    const touched = new Set<string>();
    for (const run of runs) {
      for (const tool of run.toolsTouched) touched.add(tool);
    }
    const missing = sorted([...required].filter((tool) => !touched.has(tool)));
    const hasFriction = runs.some((run) => run.frictionCount > 0);
    const passed = passCount >= requiredPassCount;
    const status: MissionOutcome["status"] = passed
      ? hasFriction
        ? "passed_with_friction"
        : "passed"
      : passCount > 0
        ? "unstable_pass"
        : missing.length > 0
          ? "incomplete"
          : "failed";
    const failReason = passed
      ? undefined
      : (runs.find((run) => run.failReason !== undefined)?.failReason ?? "mission failed");
    out[missionId] = {
      passed,
      status,
      stability,
      passCount,
      runCount,
      requiredPassCount,
      coverageComplete: missing.length === 0,
      toolsTouched: sorted(touched),
      toolsMissing: missing,
      ...(failReason !== undefined ? { failReason } : {}),
      agentReflection: runs[runs.length - 1]?.agentReflection ?? "",
      runs,
    };
  }
  return out;
}

function coverageMatrix(traces: readonly TraceRecord[]): DogfoodReport["coverageMatrix"] {
  const touched = new Set<string>();
  for (const trace of traces) {
    for (const event of trace.toolEvents) {
      if (isEventCovered(event)) touched.add(event.tool);
    }
  }
  const out: DogfoodReport["coverageMatrix"] = {};
  const caps = sorted(new Set(MANIFEST.map((row) => row.capability)));
  for (const capability of caps) {
    const tools = MANIFEST.filter((row) => row.capability === capability).map((row) => row.tool);
    const toolsTouched = sorted(tools.filter((tool) => touched.has(tool)));
    const toolsMissed = sorted(tools.filter((tool) => !touched.has(tool)));
    out[capability] = {
      toolsTouched,
      toolsMissed,
      pct: pct(toolsTouched.length, tools.length),
    };
  }
  return out;
}

function confusionScore(input: {
  readonly total: number;
  readonly errors: number;
  readonly retries: number;
  readonly abandons: number;
  readonly avgDurationMs: number;
  readonly schemaFailures: number;
  readonly wrongTools: number;
}): number {
  const attempts = Math.max(1, input.total);
  const errorRate = input.errors / attempts;
  const retryRate = input.retries / attempts;
  const abandonRate = input.abandons / attempts;
  const schemaRate = input.schemaFailures / attempts;
  const wrongToolRate = input.wrongTools / attempts;
  const latencyPenalty = Math.min(1, input.avgDurationMs / 10_000);
  return Math.round(
    100 *
      (0.25 * errorRate +
        0.2 * retryRate +
        0.2 * abandonRate +
        0.15 * latencyPenalty +
        0.1 * schemaRate +
        0.1 * wrongToolRate),
  );
}

function frictionMetrics(traces: readonly TraceRecord[]): Record<string, FrictionMetric> {
  const groups = new Map<string, ToolEvent[]>();
  const reasoningCounts = new Map<string, number>();
  for (const trace of traces) {
    for (const event of trace.toolEvents) {
      const key = event.tool;
      const rows = groups.get(key) ?? [];
      rows.push(event);
      groups.set(key, rows);
      if (event.precedingReasoning) {
        reasoningCounts.set(key, (reasoningCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const out: Record<string, FrictionMetric> = {};
  for (const [tool, events] of groups) {
    const durations = events.filter((event) => !event.abandoned).map((event) => event.durationMs);
    const avgDurationMs = trimMean(durations);
    const errorCount = events.filter(
      (event) => event.coverageOutcome === "error" || event.coverageOutcome === "schema_error",
    ).length;
    const retryCount = events.filter((event) => event.retried).length;
    const abandonCount = events.filter((event) => event.abandoned).length;
    const schemaValidationFailureCount = events.filter(
      (event) => event.schemaValidationFailure,
    ).length;
    const wrongToolAttemptCount = events.filter((event) => event.wrongToolAttempt).length;
    const changedArgumentRetryCount = events.filter((event) => event.changedArgumentRetry).length;
    const firstSuccessLatencies = events
      .map((event) => event.firstSuccessLatencyMs)
      .filter((value): value is number => typeof value === "number");
    const row = manifestByTool.get(tool);
    out[tool] = {
      tool,
      ...(row?.capability !== undefined ? { capability: row.capability } : {}),
      errorCount,
      retryCount,
      abandonCount,
      schemaValidationFailureCount,
      wrongToolAttemptCount,
      changedArgumentRetryCount,
      avgDurationMs,
      ...(firstSuccessLatencies[0] !== undefined
        ? { firstSuccessLatencyMs: Math.min(...firstSuccessLatencies) }
        : {}),
      reasoningSummaryCount: reasoningCounts.get(tool) ?? 0,
      confusionScore: confusionScore({
        total: events.length,
        errors: errorCount,
        retries: retryCount,
        abandons: abandonCount,
        avgDurationMs,
        schemaFailures: schemaValidationFailureCount,
        wrongTools: wrongToolAttemptCount,
      }),
    };
  }
  return out;
}

function capabilityFriction(
  metrics: Record<string, FrictionMetric>,
): Record<string, CapabilityFrictionRollup> {
  const groups = new Map<string, FrictionMetric[]>();
  for (const metric of Object.values(metrics)) {
    const capability = metric.capability ?? "outside-browxai";
    const rows = groups.get(capability) ?? [];
    rows.push(metric);
    groups.set(capability, rows);
  }
  const out: Record<string, CapabilityFrictionRollup> = {};
  for (const [capability, rows] of groups) {
    out[capability] = {
      errorCount: rows.reduce((sum, row) => sum + row.errorCount, 0),
      retryCount: rows.reduce((sum, row) => sum + row.retryCount, 0),
      abandonCount: rows.reduce((sum, row) => sum + row.abandonCount, 0),
      schemaValidationFailureCount: rows.reduce(
        (sum, row) => sum + row.schemaValidationFailureCount,
        0,
      ),
      wrongToolAttemptCount: rows.reduce((sum, row) => sum + row.wrongToolAttemptCount, 0),
      avgConfusionScore: Math.round(
        rows.reduce((sum, row) => sum + row.confusionScore, 0) / Math.max(1, rows.length),
      ),
    };
  }
  return out;
}

function aggregateStability(
  outcomes: Record<string, MissionOutcome>,
): DogfoodReport["aggregateSummary"]["aggregateStability"] {
  const values = Object.values(outcomes);
  if (values.every((outcome) => outcome.stability === "single-run")) return "single-run";
  if (values.every((outcome) => outcome.stability === "stable_pass")) return "stable";
  if (values.some((outcome) => outcome.stability === "unstable_pass")) return "unstable";
  return "failed";
}

function normalizedReport(report: DogfoodReport): NormalizedDogfoodReport {
  const normalizedFriction: NormalizedDogfoodReport["frictionMetrics"] = {};
  for (const [tool, metric] of Object.entries(report.frictionMetrics)) {
    const {
      avgDurationMs: _avgDurationMs,
      firstSuccessLatencyMs: _firstSuccessLatencyMs,
      reasoningSummaryCount: _reasoningSummaryCount,
      ...stable
    } = metric;
    void _avgDurationMs;
    void _firstSuccessLatencyMs;
    void _reasoningSummaryCount;
    normalizedFriction[tool] = stable;
  }
  const missionOutcomes: NormalizedDogfoodReport["missionOutcomes"] = {};
  for (const [missionId, outcome] of Object.entries(report.missionOutcomes)) {
    const { agentReflection: _agentReflection, runs, ...stableOutcome } = outcome;
    void _agentReflection;
    missionOutcomes[missionId] = {
      ...stableOutcome,
      runs: runs.map((run) => {
        const { agentReflection: _runReflection, oracleResults, ...stableRun } = run;
        void _runReflection;
        return {
          ...stableRun,
          oracleOutcomes: oracleResults.map((result) => result.outcome),
        };
      }),
    };
  }
  const {
    generatedAt: _generatedAt,
    testbedBaseUrl: _testbedBaseUrl,
    repoDirty: _repoDirty,
    ...stableMetadata
  } = report.metadata;
  void _generatedAt;
  void _testbedBaseUrl;
  void _repoDirty;
  return {
    schemaVersion: 1,
    metadata: stableMetadata,
    coverageMatrix: report.coverageMatrix,
    capabilityFriction: report.capabilityFriction,
    frictionMetrics: normalizedFriction,
    missionOutcomes,
    aggregateSummary: report.aggregateSummary,
  };
}

function markdownSummary(report: DogfoodReport): string {
  const topFriction = report.aggregateSummary.topFrictionTools.length
    ? report.aggregateSummary.topFrictionTools.join(", ")
    : "none";
  const missionRows = Object.entries(report.missionOutcomes)
    .map(
      ([id, outcome]) =>
        `| ${id} | ${outcome.status} | ${outcome.passCount}/${outcome.runCount} | ${outcome.toolsMissing.length} | ${outcome.failReason ?? ""} |`,
    )
    .join("\n");
  const coverageRows = Object.entries(report.coverageMatrix)
    .map(
      ([capability, bucket]) =>
        `| ${capability} | ${bucket.pct.toFixed(2)} | ${bucket.toolsTouched.length} | ${bucket.toolsMissed.length} |`,
    )
    .join("\n");
  return [
    "# browxai dogfood report",
    "",
    `- Generated: ${report.metadata.generatedAt}`,
    `- Mode: ${report.metadata.mode}`,
    `- Model: ${report.metadata.model} / ${report.metadata.effort}`,
    `- Sandbox: ${report.metadata.sandbox}, approval policy: ${report.metadata.approvalPolicy}`,
    `- Tool coverage: ${report.aggregateSummary.coveragePct.toFixed(2)}% (${String(report.aggregateSummary.totalToolsTouched)} tools)`,
    `- Aggregate stability: ${report.aggregateSummary.aggregateStability}`,
    `- Top friction tools: ${topFriction}`,
    "",
    "## Mission Outcomes",
    "",
    "| Mission | Status | Passes | Missing Tools | Reason |",
    "| --- | --- | ---: | ---: | --- |",
    missionRows,
    "",
    "## Capability Coverage",
    "",
    "| Capability | Coverage % | Touched | Missed |",
    "| --- | ---: | ---: | ---: |",
    coverageRows,
    "",
  ].join("\n");
}

export async function generateDogfoodReport(input: ReportGenerationInput): Promise<{
  readonly report: DogfoodReport;
  readonly normalized: NormalizedDogfoodReport;
  readonly paths: ReportPaths;
}> {
  const traces = input.traces.map((row) => row.trace);
  const matrix = coverageMatrix(traces);
  const metrics = frictionMetrics(traces);
  const outcomes = missionOutcomes(input.traces);
  const touchedTools = new Set<string>();
  for (const bucket of Object.values(matrix)) {
    for (const tool of bucket.toolsTouched) touchedTools.add(tool);
  }
  const topFrictionTools = Object.values(metrics)
    .sort(
      (a, b) =>
        b.confusionScore - a.confusionScore ||
        b.errorCount - a.errorCount ||
        b.retryCount - a.retryCount ||
        a.tool.localeCompare(b.tool),
    )
    .slice(0, 5)
    .map((metric) => metric.tool);
  const rowBackedCaps = new Set(MANIFEST.map((row) => row.capability));
  const rowlessCapabilities = sorted(
    [...HARNESS_CAPABILITIES].filter((capability) => !rowBackedCaps.has(capability as Capability)),
  );
  const report: DogfoodReport = {
    metadata: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      repoSha: input.git.sha,
      repoDirty: input.git.dirty,
      testbedBaseUrl: input.testbedBaseUrl,
      browxaiCapabilities: input.config.browxaiCapabilities,
      rowlessCapabilities,
      byobAttachPosture: "recorded_only",
      model: input.config.model,
      effort: input.config.effort,
      sandbox: input.config.sandbox,
      approvalPolicy: input.config.approvalPolicy,
      kDefault: input.config.kDefault,
      headless: input.config.headless,
      mode: input.config.mode,
    },
    coverageMatrix: matrix,
    capabilityFriction: capabilityFriction(metrics),
    frictionMetrics: metrics,
    missionOutcomes: outcomes,
    aggregateSummary: {
      totalToolsTouched: touchedTools.size,
      coveragePct: pct(touchedTools.size, MANIFEST.length),
      aggregateStability: aggregateStability(outcomes),
      topFrictionTools,
    },
    traces: input.traces.map((row) => ({
      missionId: row.mission.id,
      runIndex: row.trace.runIndex,
      path: row.tracePath,
    })),
  };
  const normalized = normalizedReport(report);
  await mkdir(input.config.reportsDir, { recursive: true });
  const paths = {
    json: join(input.config.reportsDir, "dogfood-report.json"),
    markdown: join(input.config.reportsDir, "dogfood-report.md"),
    normalizedJson: join(input.config.reportsDir, "dogfood-report.normalized.json"),
  };
  await writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(paths.normalizedJson, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await writeFile(paths.markdown, markdownSummary(report), "utf8");
  return { report, normalized, paths };
}
