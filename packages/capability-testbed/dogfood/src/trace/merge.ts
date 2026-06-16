import type { DiagnosticsCallRecord } from "./diagnostics-reader.js";
import type { CoverageOutcome, ToolEvent, TraceRecord } from "./trace-record.js";

function outcomeWithDiagnostics(
  event: ToolEvent,
  failureKind: string | undefined,
): CoverageOutcome {
  if (failureKind === undefined) return event.coverageOutcome;
  if (event.coverageOutcome === "structured_refusal" || event.coverageOutcome === "unavailable") {
    return event.coverageOutcome;
  }
  if (failureKind === "bad-arg") return "schema_error";
  return "error";
}

function attachDiagnostics(event: ToolEvent, diagnostics: DiagnosticsCallRecord): ToolEvent {
  const failureKind = diagnostics.resultMeta?.failureKind;
  const result =
    failureKind === undefined
      ? event.result
      : {
          ...(event.result && typeof event.result === "object"
            ? (event.result as Record<string, unknown>)
            : { value: event.result }),
          __diagnostics: {
            failureKind,
            ok: diagnostics.resultMeta?.ok,
            warningsCount: diagnostics.resultMeta?.warningsCount,
          },
        };
  return {
    ...event,
    result,
    durationMs: diagnostics.durationMs ?? event.durationMs,
    coverageOutcome: outcomeWithDiagnostics(event, failureKind),
    schemaValidationFailure: event.schemaValidationFailure || failureKind === "bad-arg",
  };
}

export function mergeDiagnosticsIntoTrace(
  trace: TraceRecord,
  diagnostics: readonly DiagnosticsCallRecord[],
): TraceRecord {
  const byTool = new Map<string, DiagnosticsCallRecord[]>();
  for (const record of diagnostics) {
    const list = byTool.get(record.tool) ?? [];
    list.push(record);
    byTool.set(record.tool, list);
  }
  const ordinals = new Map<string, number>();
  const toolEvents = trace.toolEvents.map((event) => {
    if (event.server !== "browxai") return event;
    const ordinal = ordinals.get(event.tool) ?? 0;
    ordinals.set(event.tool, ordinal + 1);
    const match = byTool.get(event.tool)?.[ordinal];
    return match ? attachDiagnostics(event, match) : event;
  });
  return { ...trace, toolEvents };
}
