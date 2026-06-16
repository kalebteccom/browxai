import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DogfoodRunConfig } from "./config.js";
import { CATALOG } from "./missions/catalog.js";
import { buildMissionPrompt } from "./missions/prompt.js";
import { selectMissions, validateCatalog, type DogfoodMission } from "./missions/schema.js";
import { InlineCodexAppServerOwn, codexMcpConfigArgs } from "./runtime/codex-app-server-own.js";
import {
  preflightLiveRun,
  startBrowxaiServe,
  startTestbedServer,
  type ManagedProcess,
  type TestbedServerProcess,
} from "./runtime/processes.js";
import { mockCodexFramesForMission } from "./mock/fixtures.js";
import { runMissionOracle } from "./oracle/exercise-oracle.js";
import type { OracleToolOutcome } from "./report/schema.js";
import {
  generateDogfoodReport,
  type GitMetadata,
  type ReportTraceInput,
} from "./report/generator.js";
import { TraceBuilder } from "./trace/codex-normalizer.js";
import { readDiagnosticsRecords } from "./trace/diagnostics-reader.js";
import { mergeDiagnosticsIntoTrace } from "./trace/merge.js";
import { writeTraceJsonl, type TraceRecord } from "./trace/trace-record.js";

const execFileAsync = promisify(execFile);

export interface DogfoodRunResult {
  readonly reportPath: string;
  readonly markdownPath: string;
  readonly normalizedReportPath: string;
  readonly runRoot: string;
  readonly traceCount: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function gitMetadata(repoRoot: string): Promise<GitMetadata> {
  try {
    const [{ stdout: shaRaw }, { stdout: statusRaw }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
      execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot }),
    ]);
    return {
      sha: shaRaw.trim(),
      dirty: statusRaw.trim().length > 0,
    };
  } catch {
    return { sha: "unknown", dirty: true };
  }
}

function sessionIdFor(mission: DogfoodMission, runIndex: number, nativeId: string | null): string {
  const suffix = nativeId ? nativeId.slice(-8).replace(/[^a-zA-Z0-9_-]/g, "") : "pending";
  return `dogfood-${mission.id}-r${String(runIndex)}-${suffix}`;
}

function initialSessionId(mission: DogfoodMission, runIndex: number): string {
  return `dogfood-${mission.id}-r${String(runIndex)}-pending`;
}

function tracePath(config: DogfoodRunConfig, mission: DogfoodMission, runIndex: number): string {
  return join(config.tracesDir, mission.id, `run-${String(runIndex)}.jsonl`);
}

function budgetReason(builder: TraceBuilder, config: DogfoodRunConfig): string | undefined {
  const toolCalls = builder.toolCallCount();
  const turns = builder.turnCountSoFar();
  if (toolCalls > config.maxToolCalls || turns > config.maxTurns) {
    return `budget-exhausted: ${String(toolCalls)} tool calls / ${String(turns)} turns`;
  }
  return undefined;
}

function mockOracleResults(mission: DogfoodMission): OracleToolOutcome[] {
  return mission.oracle.exerciseTools.map((tool) => ({
    tool,
    outcome: "pass",
    detail: "mock oracle pass",
  }));
}

async function writeMergedTrace(input: {
  readonly path: string;
  readonly builder: TraceBuilder;
  readonly diagnostics?: readonly unknown[];
  readonly mergeDiagnostics?: (trace: TraceRecord) => TraceRecord;
}): Promise<TraceRecord> {
  for (const record of input.diagnostics ?? []) input.builder.addDiagnosticsRecord(record);
  const finalized = input.builder.finalize();
  const merged = input.mergeDiagnostics
    ? input.mergeDiagnostics(finalized.record)
    : finalized.record;
  const entries = [...finalized.entries];
  const last = entries[entries.length - 1];
  if (last?.kind === "trace_record") {
    entries[entries.length - 1] = { kind: "trace_record", record: merged };
  }
  await writeTraceJsonl(input.path, entries);
  return merged;
}

async function runMockMission(input: {
  readonly config: DogfoodRunConfig;
  readonly mission: DogfoodMission;
  readonly runIndex: number;
  readonly baseUrl: string;
}): Promise<ReportTraceInput> {
  const sessionId = `mock-${input.mission.id}-r${String(input.runIndex)}`;
  const prompt = buildMissionPrompt({
    mission: input.mission,
    baseUrl: input.baseUrl,
    sessionId,
    maxToolCalls: input.config.maxToolCalls,
    maxTurns: input.config.maxTurns,
  });
  const builder = new TraceBuilder({
    sessionId,
    missionId: input.mission.id,
    runIndex: input.runIndex,
    prompt,
    startedAtMs: 1_700_000_000_000 + input.runIndex * 1_000,
  });
  let atMs = 1_700_000_000_100 + input.runIndex * 1_000;
  builder.addRaw(
    "out",
    {
      id: 1,
      method: "turn/start",
      params: { threadId: `mock-thread-${input.mission.id}`, input: [{ type: "text", text: prompt }] },
    },
    atMs,
  );
  atMs += 5;
  for (const frame of mockCodexFramesForMission({
    mission: input.mission,
    sessionId,
    runIndex: input.runIndex,
  })) {
    builder.addRaw("in", frame, atMs);
    atMs += 5;
    const reason = budgetReason(builder, input.config);
    if (reason !== undefined) {
      builder.markTermination("budget_exhausted", reason);
      break;
    }
    if (input.config.timeoutMs <= 5) {
      const timeoutReason = `timed out after ${String(input.config.timeoutMs)}ms`;
      builder.markTermination("timed_out", timeoutReason);
      break;
    }
  }
  if (builder.hasCompletedTurn() && builder.hasMissionMarker()) {
    builder.markTermination("completed", "mission completed");
  }
  const path = tracePath(input.config, input.mission, input.runIndex);
  const record = await writeMergedTrace({ path, builder });
  return {
    mission: input.mission,
    trace: record,
    tracePath: path,
    oracleResults: mockOracleResults(input.mission),
  };
}

async function runLiveMission(input: {
  readonly config: DogfoodRunConfig;
  readonly mission: DogfoodMission;
  readonly runIndex: number;
  readonly baseUrl: string;
}): Promise<ReportTraceInput> {
  const provisionalSessionId = initialSessionId(input.mission, input.runIndex);
  const appArgs = codexMcpConfigArgs({
    command: input.config.proxyCommand,
    args: [...input.config.proxyArgsPrefix, "--socket", input.config.browxaiSocket],
  });
  const codex = new InlineCodexAppServerOwn({
    cwd: input.config.repoRoot,
    codexBin: input.config.codexBin,
    appServerArgs: appArgs,
    model: input.config.model,
    effort: input.config.effort,
    sandbox: input.config.sandbox,
    approvalPolicy: input.config.approvalPolicy,
  });
  await delay(100);
  const sessionId =
    sessionIdFor(input.mission, input.runIndex, codex.nativeId()) || provisionalSessionId;
  const prompt = buildMissionPrompt({
    mission: input.mission,
    baseUrl: input.baseUrl,
    sessionId,
    maxToolCalls: input.config.maxToolCalls,
    maxTurns: input.config.maxTurns,
  });
  const builder = new TraceBuilder({
    sessionId,
    missionId: input.mission.id,
    runIndex: input.runIndex,
    prompt,
  });
  codex.onRaw((direction, frame) => builder.addRaw(direction, frame));

  const deadline = Date.now() + input.config.timeoutMs;
  try {
    await codex.startTurn(prompt, Math.max(1, Math.min(30_000, input.config.timeoutMs)));
    while (Date.now() < deadline) {
      const reason = budgetReason(builder, input.config);
      if (reason !== undefined) {
        builder.markTermination("budget_exhausted", reason);
        await codex.interrupt();
        break;
      }
      if (builder.hasCompletedTurn()) {
        builder.markTermination(
          "completed",
          builder.hasMissionMarker() ? "mission completed" : "turn completed without DONE marker",
        );
        break;
      }
      await delay(250);
    }
    if (!builder.hasCompletedTurn() && builder.toolCallCount() <= input.config.maxToolCalls) {
      const reason = `timed out after ${String(input.config.timeoutMs)}ms`;
      builder.markTermination("timed_out", reason);
      await codex.interrupt();
    }
  } catch (err) {
    if (Date.now() >= deadline) {
      builder.markTermination("timed_out", `timed out after ${String(input.config.timeoutMs)}ms`);
    } else {
      builder.markTermination("errored", err instanceof Error ? err.message : String(err));
    }
  } finally {
    await codex.stop();
  }

  const diagnostics = await readDiagnosticsRecords(input.config.workspace, sessionId);
  const path = tracePath(input.config, input.mission, input.runIndex);
  const record = await writeMergedTrace({
    path,
    builder,
    diagnostics,
    mergeDiagnostics: (trace) => mergeDiagnosticsIntoTrace(trace, diagnostics),
  });
  const oracleResults = input.config.runOracle
    ? await runMissionOracle({
        mission: input.mission,
        runIndex: input.runIndex,
        socketPath: input.config.browxaiSocket,
        baseUrl: input.baseUrl,
        workspace: input.config.workspace,
        timeoutMs: input.config.oracleTimeoutMs,
      })
    : [];
  return {
    mission: input.mission,
    trace: record,
    tracePath: path,
    oracleResults,
  };
}

async function runErroredMission(input: {
  readonly config: DogfoodRunConfig;
  readonly mission: DogfoodMission;
  readonly runIndex: number;
  readonly baseUrl: string;
  readonly error: unknown;
}): Promise<ReportTraceInput> {
  const sessionId = initialSessionId(input.mission, input.runIndex);
  const prompt = buildMissionPrompt({
    mission: input.mission,
    baseUrl: input.baseUrl,
    sessionId,
    maxToolCalls: input.config.maxToolCalls,
    maxTurns: input.config.maxTurns,
  });
  const builder = new TraceBuilder({
    sessionId,
    missionId: input.mission.id,
    runIndex: input.runIndex,
    prompt,
  });
  builder.markTermination(
    "errored",
    input.error instanceof Error ? input.error.message : String(input.error),
  );
  const path = tracePath(input.config, input.mission, input.runIndex);
  const record = await writeMergedTrace({ path, builder });
  return {
    mission: input.mission,
    trace: record,
    tracePath: path,
    oracleResults: [],
  };
}

async function stopProcesses(processes: readonly ManagedProcess[]): Promise<void> {
  for (const proc of [...processes].reverse()) {
    await proc.stop().catch(() => undefined);
  }
}

export async function runDogfood(config: DogfoodRunConfig): Promise<DogfoodRunResult> {
  validateCatalog(CATALOG);
  const missions = selectMissions(CATALOG, config.mission);
  await mkdir(config.runRoot, { recursive: true });
  await mkdir(config.tracesDir, { recursive: true });
  await mkdir(config.reportsDir, { recursive: true });
  await mkdir(config.workspace, { recursive: true });

  const git = await gitMetadata(config.repoRoot);
  const reportInputs: ReportTraceInput[] = [];
  const processes: ManagedProcess[] = [];
  let testbed: TestbedServerProcess | undefined;
  let baseUrl = config.testbedBaseUrl ?? "mock://capability-testbed";

  try {
    if (config.mode === "live") {
      await preflightLiveRun(config);
      testbed = await startTestbedServer(config);
      processes.push(testbed);
      baseUrl = testbed.baseUrl;
      processes.push(await startBrowxaiServe(config));
    }

    for (const mission of missions) {
      const k = config.kOverride ?? mission.kRuns;
      for (let runIndex = 0; runIndex < k; runIndex += 1) {
        const input = { config, mission, runIndex, baseUrl };
        try {
          reportInputs.push(
            config.mode === "mock" ? await runMockMission(input) : await runLiveMission(input),
          );
        } catch (err) {
          reportInputs.push(await runErroredMission({ ...input, error: err }));
        }
      }
    }

    const { paths } = await generateDogfoodReport({
      config,
      testbedBaseUrl: baseUrl,
      catalog: CATALOG,
      traces: reportInputs,
      git,
    });
    return {
      reportPath: paths.json,
      markdownPath: paths.markdown,
      normalizedReportPath: paths.normalizedJson,
      runRoot: config.runRoot,
      traceCount: reportInputs.length,
    };
  } finally {
    if (!config.keepOpen) await stopProcesses(processes);
  }
}

export async function readReportSummary(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { aggregateSummary?: unknown };
  return JSON.stringify(parsed.aggregateSummary ?? {}, null, 2);
}
