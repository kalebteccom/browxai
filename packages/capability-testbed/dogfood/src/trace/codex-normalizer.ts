import { isDeepStrictEqual } from "node:util";
import type { CodexEvent, RpcFrame } from "../runtime/codex-events.js";
import { mapCodexNotification } from "../runtime/codex-events.js";
import type {
  CoverageOutcome,
  MissionMarker,
  ToolEvent,
  TraceJsonlEntry,
  TraceRecord,
  TraceToolCallRef,
} from "./trace-record.js";

interface ActiveTool {
  readonly id: string;
  readonly label: string;
  readonly server?: string;
  readonly tool: string;
  readonly args: unknown;
  readonly startedAtMs: number;
  readonly wrongToolAttempt: boolean;
  readonly precedingReasoning?: string;
  readonly precedingProse?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstJsonObject(result: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(result);
  if (direct && ("ok" in direct || "isError" in direct || "error" in direct)) return direct;
  const content = direct?.content;
  if (!Array.isArray(content)) return direct;
  for (const item of content) {
    const obj = asRecord(item);
    const text = obj?.text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      const parsedObj = asRecord(parsed);
      if (parsedObj) return parsedObj;
    } catch {
      /* keep scanning */
    }
  }
  return direct;
}

function diagnosticsFailureKind(result: unknown): string | undefined {
  const obj = asRecord(result);
  const diag = asRecord(obj?.__diagnostics);
  const kind = diag?.failureKind;
  return typeof kind === "string" ? kind : undefined;
}

function hasSchemaFailure(result: unknown): boolean {
  const parsed = firstJsonObject(result);
  const failureKind = diagnosticsFailureKind(result);
  if (failureKind === "bad-arg") return true;
  const text = `${stringValue(parsed?.error)} ${stringValue(parsed?.message)} ${stringValue(result)}`;
  return /\b(schema|invalid|unknown|expected|required|must)\b/i.test(text);
}

function isStructuredRefusal(result: unknown): boolean {
  const parsed = firstJsonObject(result);
  const failureKind = diagnosticsFailureKind(result);
  if (failureKind === "capability-denied" || failureKind === "bad-arg") return false;
  const text = `${stringValue(parsed?.error)} ${stringValue(parsed?.reason)} ${stringValue(parsed?.detail)} ${stringValue(result)}`;
  return /\b(no provider|not configured|unavailable|unsupported|not supported|headless|incognito|refus|denied|no adapter)\b/i.test(
    text,
  );
}

function classifyCoverage(input: {
  readonly result: unknown;
  readonly abandoned: boolean;
  readonly wrongToolAttempt: boolean;
}): CoverageOutcome {
  if (input.abandoned) return "abandoned";
  if (input.wrongToolAttempt) return "wrong_tool";
  const parsed = firstJsonObject(input.result);
  const isError = parsed?.isError === true;
  const okFalse = parsed?.ok === false;
  if (hasSchemaFailure(input.result)) return "schema_error";
  if (isStructuredRefusal(input.result)) {
    return /\bunavailable|not configured|no provider|no adapter\b/i.test(stringValue(input.result))
      ? "unavailable"
      : "structured_refusal";
  }
  if (isError || okFalse || diagnosticsFailureKind(input.result) !== undefined) return "error";
  return "success";
}

function isCoverageEligible(outcome: CoverageOutcome): boolean {
  return outcome === "success" || outcome === "structured_refusal" || outcome === "unavailable";
}

function extractMissionMarker(text: string, missionId: string): MissionMarker | undefined {
  const marker = /DOGFOOD_MISSION_DONE\s+({[^\n]+})/g;
  let match: RegExpExecArray | null;
  let parsed: MissionMarker | undefined;
  while ((match = marker.exec(text)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const value = JSON.parse(raw) as Partial<MissionMarker>;
      if (
        value.missionId === missionId &&
        (value.status === "done" || value.status === "blocked") &&
        typeof value.reflection === "string"
      ) {
        parsed = {
          missionId: value.missionId,
          status: value.status,
          reflection: value.reflection,
        };
      }
    } catch {
      /* ignore malformed marker candidates */
    }
  }
  return parsed;
}

export class TraceBuilder {
  private readonly startedAtMs: number;
  private readonly entries: TraceJsonlEntry[] = [];
  private readonly active = new Map<string, ActiveTool>();
  private readonly toolEvents: ToolEvent[] = [];
  private readonly reasoningItems: Array<{ text: string; atMs: number }> = [];
  private readonly planSnapshots: Array<TraceRecord["planSnapshots"][number]> = [];
  private readonly assistantToolRefs: TraceToolCallRef[] = [];
  private assistantText = "";
  private lastReasoning: string | undefined;
  private lastProse: string | undefined;
  private tokenUsage = { input: 0, output: 0, total: 0 };
  private turnCompleted = false;
  private turnCount = 0;
  private termination:
    | {
        readonly kind: "completed" | "timed_out" | "budget_exhausted" | "errored";
        readonly reason: string;
      }
    | undefined;

  constructor(
    private readonly input: {
      readonly sessionId: string;
      readonly missionId: string;
      readonly runIndex: number;
      readonly prompt: string;
      readonly startedAtMs?: number;
    },
  ) {
    this.startedAtMs = input.startedAtMs ?? Date.now();
  }

  addRaw(direction: "in" | "out", frame: RpcFrame, atMs = Date.now()): void {
    this.entries.push({ kind: "codex_raw", direction, atMs, frame });
    if (direction === "in") {
      for (const event of mapCodexNotification(frame, atMs)) this.addEvent(event);
    }
  }

  addEvent(event: CodexEvent): void {
    this.entries.push({ kind: "codex_event", atMs: event.atMs, event });
    if (event.kind === "reasoning") {
      this.reasoningItems.push({ text: event.text, atMs: event.atMs });
      this.lastReasoning = event.text;
      return;
    }
    if (event.kind === "assistant_message") {
      this.assistantText += `${this.assistantText.length > 0 ? "\n" : ""}${event.text}`;
      this.lastProse = event.text;
      return;
    }
    if (event.kind === "plan_update") {
      this.planSnapshots.push({ atMs: event.atMs, items: event.items });
      return;
    }
    if (event.kind === "context_usage") {
      this.tokenUsage = event.usage;
      return;
    }
    if (event.kind === "status") {
      if (event.state === "active") this.turnCount += 1;
      this.turnCompleted = event.state === "idle";
      return;
    }
    if (event.kind !== "tool_call") return;

    const wrongToolAttempt = event.itemType !== "mcpToolCall" || event.server !== "browxai";
    if (event.phase === "started") {
      this.active.set(event.itemId, {
        id: event.itemId,
        label: event.label,
        ...(event.server !== undefined ? { server: event.server } : {}),
        tool: event.tool,
        args: event.args,
        startedAtMs: event.atMs,
        wrongToolAttempt,
        ...(this.lastReasoning !== undefined ? { precedingReasoning: this.lastReasoning } : {}),
        ...(this.lastProse !== undefined ? { precedingProse: this.lastProse } : {}),
      });
      this.assistantToolRefs.push({ id: event.itemId, label: event.label, tool: event.tool });
      return;
    }

    const active = this.active.get(event.itemId) ?? {
      id: event.itemId,
      label: event.label,
      ...(event.server !== undefined ? { server: event.server } : {}),
      tool: event.tool,
      args: event.args,
      startedAtMs: event.atMs,
      wrongToolAttempt,
      ...(this.lastReasoning !== undefined ? { precedingReasoning: this.lastReasoning } : {}),
      ...(this.lastProse !== undefined ? { precedingProse: this.lastProse } : {}),
    };
    this.active.delete(event.itemId);
    this.toolEvents.push(this.completeToolEvent(active, event.result, event.atMs, false));
  }

  addDiagnosticsRecord(record: unknown): void {
    const obj = asRecord(record);
    const ts = typeof obj?.ts === "string" ? Date.parse(obj.ts) : undefined;
    this.entries.push({
      kind: "browxai_diagnostics",
      ...(Number.isFinite(ts) ? { atMs: ts } : {}),
      record,
    });
  }

  finalize(completedAtMs = Date.now()): {
    record: TraceRecord;
    entries: readonly TraceJsonlEntry[];
  } {
    for (const active of this.active.values()) {
      this.toolEvents.push(this.completeToolEvent(active, undefined, completedAtMs, true));
    }
    this.active.clear();

    const marker = extractMissionMarker(this.assistantText, this.input.missionId);
    const record: TraceRecord = {
      sessionId: this.input.sessionId,
      missionId: this.input.missionId,
      runIndex: this.input.runIndex,
      startedAt: new Date(this.startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      ...(marker !== undefined ? { missionMarker: marker } : {}),
      turns: [
        { role: "user", content: this.input.prompt, toolCalls: [] },
        { role: "assistant", content: this.assistantText, toolCalls: this.assistantToolRefs },
      ],
      toolEvents: this.toolEvents,
      reasoningItems: this.reasoningItems,
      planSnapshots: this.planSnapshots,
      tokenUsage: this.tokenUsage,
      ...(this.termination !== undefined
        ? {
            termination: {
              ...this.termination,
              toolCalls: this.toolEvents.length,
              turns: this.turnCount,
            },
          }
        : {}),
    };
    this.entries.push({ kind: "trace_record", record });
    return { record, entries: this.entries };
  }

  hasCompletedTurn(): boolean {
    return this.turnCompleted;
  }

  hasMissionMarker(): boolean {
    return extractMissionMarker(this.assistantText, this.input.missionId) !== undefined;
  }

  markTermination(kind: "completed" | "timed_out" | "budget_exhausted" | "errored", reason: string): void {
    if (this.termination !== undefined) return;
    this.termination = { kind, reason };
  }

  toolCallCount(): number {
    return this.toolEvents.length + this.active.size;
  }

  turnCountSoFar(): number {
    return this.turnCount;
  }

  private completeToolEvent(
    active: ActiveTool,
    result: unknown,
    completedAtMs: number,
    abandoned: boolean,
  ): ToolEvent {
    const previousForTool = this.toolEvents.filter((event) => event.tool === active.tool);
    const previousFailure = previousForTool.find(
      (event) => !isCoverageEligible(event.coverageOutcome) || event.abandoned,
    );
    const changedArgumentRetry =
      previousFailure !== undefined && !isDeepStrictEqual(previousFailure.args, active.args);
    const retried = previousFailure !== undefined;
    const outcome = classifyCoverage({
      result,
      abandoned,
      wrongToolAttempt: active.wrongToolAttempt,
    });
    const firstSuccessSeen = this.toolEvents.some(
      (event) => event.tool === active.tool && isCoverageEligible(event.coverageOutcome),
    );
    const firstSuccessLatencyMs =
      !firstSuccessSeen && isCoverageEligible(outcome)
        ? completedAtMs - this.startedAtMs
        : undefined;
    return {
      id: active.id,
      label: active.label,
      ...(active.server !== undefined ? { server: active.server } : {}),
      tool: active.tool,
      args: active.args,
      result,
      durationMs: Math.max(0, completedAtMs - active.startedAtMs),
      retried,
      abandoned,
      schemaValidationFailure: outcome === "schema_error",
      wrongToolAttempt: active.wrongToolAttempt,
      changedArgumentRetry,
      ...(firstSuccessLatencyMs !== undefined ? { firstSuccessLatencyMs } : {}),
      coverageOutcome: outcome,
      ...(active.precedingReasoning !== undefined
        ? { precedingReasoning: active.precedingReasoning }
        : {}),
      ...(active.precedingProse !== undefined ? { precedingProse: active.precedingProse } : {}),
    };
  }
}

export function coverageEligibleOutcome(outcome: CoverageOutcome): boolean {
  return isCoverageEligible(outcome);
}
