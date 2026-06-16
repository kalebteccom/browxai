import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexPlanItem, CodexTokenUsage } from "../runtime/codex-events.js";

export type CoverageOutcome =
  | "success"
  | "structured_refusal"
  | "unavailable"
  | "error"
  | "schema_error"
  | "abandoned"
  | "wrong_tool";

export interface TraceToolCallRef {
  readonly id: string;
  readonly label: string;
  readonly tool: string;
}

export interface TraceTurn {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls: readonly TraceToolCallRef[];
}

export interface ToolEvent {
  readonly id: string;
  readonly label: string;
  readonly server?: string;
  readonly tool: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly durationMs: number;
  readonly retried: boolean;
  readonly abandoned: boolean;
  readonly schemaValidationFailure: boolean;
  readonly wrongToolAttempt: boolean;
  readonly changedArgumentRetry: boolean;
  readonly firstSuccessLatencyMs?: number;
  readonly coverageOutcome: CoverageOutcome;
  readonly precedingReasoning?: string;
  readonly precedingProse?: string;
}

export interface ReasoningItem {
  readonly text: string;
  readonly atMs: number;
}

export interface MissionMarker {
  readonly missionId: string;
  readonly status: "done" | "blocked";
  readonly reflection: string;
}

export interface TraceRecord {
  readonly sessionId: string;
  readonly missionId: string;
  readonly runIndex: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly missionMarker?: MissionMarker;
  readonly turns: readonly TraceTurn[];
  readonly toolEvents: readonly ToolEvent[];
  readonly reasoningItems: readonly ReasoningItem[];
  readonly planSnapshots: ReadonlyArray<{
    readonly atMs: number;
    readonly items: readonly CodexPlanItem[];
  }>;
  readonly tokenUsage: CodexTokenUsage;
  readonly termination?: {
    readonly kind: "completed" | "timed_out" | "budget_exhausted" | "errored";
    readonly reason: string;
    readonly toolCalls: number;
    readonly turns: number;
  };
}

export type TraceJsonlEntry =
  | {
      readonly kind: "codex_raw";
      readonly direction: "in" | "out";
      readonly atMs: number;
      readonly frame: unknown;
    }
  | { readonly kind: "codex_event"; readonly atMs: number; readonly event: unknown }
  | { readonly kind: "browxai_diagnostics"; readonly atMs?: number; readonly record: unknown }
  | { readonly kind: "trace_record"; readonly record: TraceRecord };

export async function writeTraceJsonl(
  path: string,
  entries: readonly TraceJsonlEntry[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

export function readTraceRecordFromJsonl(raw: string): TraceRecord | null {
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const entry = JSON.parse(line) as { kind?: unknown; record?: unknown };
    if (entry.kind === "trace_record") return entry.record as TraceRecord;
  }
  return null;
}
