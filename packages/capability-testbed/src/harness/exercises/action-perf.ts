import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass, skip } from "../types.js";

type JsonRecord = Record<string, unknown>;
type TraceSetup = { readonly kind: "data"; readonly data: JsonRecord } | { readonly kind: "result"; readonly result: ExerciseResult };

const PERF = {
  alloc: '[data-testid="alloc"]',
  out: '[data-testid="perf-out"]',
  thrash: '[data-testid="thrash"]',
} as const;

function exercise(fn: (ctx: ExerciseCtx) => Promise<ExerciseResult>): Exercise {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      return {
        outcome: "error",
        detail: err instanceof Error ? err.message : "Exercise threw a non-Error value",
        evidence: String(err),
      };
    }
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  for (const item of value.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
}

function payload(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data;
  const text = firstText(value);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function payloadRecord(value: unknown, label: string): JsonRecord {
  const data = payload(value);
  if (!isRecord(data)) throw new Error(`${label} did not return a JSON object`);
  return data;
}

function asRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function recordAt(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringAt(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberAt(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireOk(record: JsonRecord, label: string): void {
  if (record.ok !== true) {
    throw new Error(`${label} did not return ok:true`);
  }
}

function unsupportedEngine(record: JsonRecord): boolean {
  return record.ok === false && typeof record.engine === "string";
}

function safeSession(ctx: ExerciseCtx): string {
  return ctx.session.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

function artifactPath(ctx: ExerciseCtx, name: string): string {
  return `capability-testbed/action-perf/${safeSession(ctx)}-${name}`;
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  const result = await ctx.call("verify_text", { selector, text, exact });
  const data = payloadRecord(result, "verify_text");
  requireOk(data, "verify_text");
  return data;
}

async function verifyVisible(ctx: ExerciseCtx, selector: string): Promise<JsonRecord> {
  const result = await ctx.call("verify_visible", { selector });
  const data = payloadRecord(result, "verify_visible");
  requireOk(data, "verify_visible");
  return data;
}

async function evalValue(ctx: ExerciseCtx, expr: string, timeoutMs?: number): Promise<unknown> {
  const args: Record<string, unknown> = { expr, returnType: "json" };
  if (timeoutMs !== undefined) args.timeoutMs = timeoutMs;
  const data = payloadRecord(await ctx.call("eval_js", args), "eval_js");
  requireOk(data, "eval_js");
  return data.value;
}

async function runTrace(ctx: ExerciseCtx, name: string): Promise<TraceSetup> {
  const started = payloadRecord(await ctx.call("perf_start"), "perf_start");
  if (unsupportedEngine(started)) {
    return { kind: "result", result: skip(`perf_start unsupported on engine: ${String(started.engine)}`) };
  }
  requireOk(started, "perf_start");
  await ctx.call("click", { selector: PERF.thrash });
  await verifyText(ctx, PERF.out, "thrashed", true);
  const stopped = payloadRecord(
    await ctx.call("perf_stop", { path: artifactPath(ctx, `${name}.json`) }),
    "perf_stop",
  );
  if (unsupportedEngine(stopped)) {
    return { kind: "result", result: skip(`perf_stop unsupported on engine: ${String(stopped.engine)}`) };
  }
  requireOk(stopped, "perf_stop");
  return { kind: "data", data: stopped };
}

async function timedLoop(ctx: ExerciseCtx): Promise<number> {
  const value = await evalValue(
    ctx,
    `(() => {
      const start = performance.now();
      let acc = 0;
      for (let i = 0; i < 3000000; i++) acc = (acc + Math.imul(i, 2654435761)) | 0;
      return { elapsedMs: performance.now() - start, acc };
    })()`,
    10_000,
  );
  if (!isRecord(value)) throw new Error("timed loop did not return an object");
  const elapsed = numberAt(value, "elapsedMs");
  if (elapsed === undefined) throw new Error("timed loop did not return elapsedMs");
  return elapsed;
}

function numericArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
}

const perf_start = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const started = payloadRecord(await ctx.call("perf_start"), "perf_start");
  if (unsupportedEngine(started)) return skip(`perf_start unsupported on engine: ${String(started.engine)}`);
  requireOk(started, "perf_start");
  await ctx.call("click", { selector: PERF.thrash });
  const verified = await verifyText(ctx, PERF.out, "thrashed", true);
  const stopped = payloadRecord(
    await ctx.call("perf_stop", { path: artifactPath(ctx, "perf-start.json") }),
    "perf_stop",
  );
  requireOk(stopped, "perf_stop");
  if (started.running === true && stringAt(stopped, "path")) {
    return pass("perf_start armed tracing and perf_stop flushed the resulting trace", {
      started,
      stopped: { path: stopped.path, eventCount: stopped.eventCount, bytes: stopped.bytes },
      verified,
    });
  }
  return fail("perf_start did not report a running trace", { started, stopped });
});

const perf_stop = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const stopped = await runTrace(ctx, "perf-stop");
  if (stopped.kind === "result") return stopped.result;
  const stoppedData = stopped.data;
  const visible = await verifyVisible(ctx, PERF.out);
  const bytes = numberAt(stoppedData, "bytes");
  const eventCount = numberAt(stoppedData, "eventCount");
  if (bytes !== undefined && bytes > 0 && eventCount !== undefined && stringAt(stoppedData, "path")) {
    return pass("perf_stop wrote a non-empty trace artifact and left the page readable", {
      path: stoppedData.path,
      bytes,
      eventCount,
      visible,
    });
  }
  return fail("perf_stop did not report a non-empty trace artifact", stoppedData);
});

const perf_insights = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const stopped = await runTrace(ctx, "perf-insights");
  if (stopped.kind === "result") return stopped.result;
  const tracePath = stringAt(stopped.data, "path");
  if (!tracePath) return fail("perf_stop did not return a trace path for perf_insights", stopped.data);
  const data = payloadRecord(await ctx.call("perf_insights", { tracePath }), "perf_insights");
  if (unsupportedEngine(data)) return skip(`perf_insights unsupported on engine: ${String(data.engine)}`);
  requireOk(data, "perf_insights");
  const visible = await verifyVisible(ctx, PERF.out);
  const insights = recordAt(data, "insights");
  const totals = insights ? recordAt(insights, "totals") : undefined;
  if (insights && totals && numberAt(data, "eventCount") !== undefined) {
    return pass("perf_insights parsed the written trace into structured totals", {
      tracePath,
      eventCount: data.eventCount,
      totals,
      visible,
    });
  }
  return fail("perf_insights did not return structured insights", data);
});

const coverage_start = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const started = payloadRecord(await ctx.call("coverage_start"), "coverage_start");
  if (unsupportedEngine(started)) return skip(`coverage_start unsupported on engine: ${String(started.engine)}`);
  requireOk(started, "coverage_start");
  await ctx.call("click", { selector: PERF.thrash });
  const verified = await verifyText(ctx, PERF.out, "thrashed", true);
  const stopped = payloadRecord(await ctx.call("coverage_stop"), "coverage_stop");
  if (unsupportedEngine(stopped)) return skip(`coverage_stop unsupported on engine: ${String(stopped.engine)}`);
  requireOk(stopped, "coverage_stop");
  if (started.running === true && Array.isArray(stopped.jsCoverage) && Array.isArray(stopped.cssCoverage)) {
    return pass("coverage_start armed coverage and coverage_stop returned JS/CSS arrays", {
      startedAt: started.startedAt,
      jsEntries: stopped.jsCoverage.length,
      cssEntries: stopped.cssCoverage.length,
      verified,
    });
  }
  return fail("coverage_start did not produce a structured coverage report", { started, stopped });
});

const heap_snapshot = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const data = payloadRecord(
    await ctx.call("heap_snapshot", { path: artifactPath(ctx, "heap.heapsnapshot") }),
    "heap_snapshot",
  );
  if (unsupportedEngine(data)) return skip(`heap_snapshot unsupported on engine: ${String(data.engine)}`);
  requireOk(data, "heap_snapshot");
  const visible = await verifyVisible(ctx, PERF.out);
  const bytes = numberAt(data, "bytes");
  if (bytes !== undefined && bytes > 0 && stringAt(data, "path")) {
    return pass("heap_snapshot wrote a non-empty V8 heap snapshot and the page stayed readable", {
      path: data.path,
      bytes,
      visible,
    });
  }
  return fail("heap_snapshot did not report a non-empty snapshot artifact", data);
});

const heap_retainers = exercise(async (ctx) => {
  await ctx.goto("/perf");
  await ctx.call("click", { selector: PERF.alloc });
  await verifyText(ctx, PERF.out, "allocated:");
  const snapshot = payloadRecord(
    await ctx.call("heap_snapshot", { path: artifactPath(ctx, "retainers.heapsnapshot") }),
    "heap_snapshot",
  );
  if (unsupportedEngine(snapshot)) return skip(`heap_snapshot unsupported on engine: ${String(snapshot.engine)}`);
  requireOk(snapshot, "heap_snapshot");
  const snapshotPath = stringAt(snapshot, "path");
  if (!snapshotPath) return fail("heap_snapshot did not return a path for heap_retainers", snapshot);
  const data = payloadRecord(
    await ctx.call("heap_retainers", { snapshotPath, query: { type: "object" } }),
    "heap_retainers",
  );
  if (unsupportedEngine(data)) return skip(`heap_retainers unsupported on engine: ${String(data.engine)}`);
  requireOk(data, "heap_retainers");
  const visible = await verifyVisible(ctx, PERF.out);
  const matchCount = numberAt(data, "matchCount");
  const retainers = asRecords(data.retainers);
  if (matchCount !== undefined && matchCount > 0 && retainers.length > 0) {
    return pass("heap_retainers reported object retainers from the written heap snapshot", {
      snapshotPath,
      matchCount,
      retainers: retainers.slice(0, 3),
      visible,
    });
  }
  return fail("heap_retainers did not report object retainers", data);
});

const cpu_emulate = exercise(async (ctx) => {
  await ctx.goto("/perf");
  await timedLoop(ctx);
  const baselineMs = await timedLoop(ctx);
  const data = payloadRecord(await ctx.call("cpu_emulate", { throttleRate: 4 }), "cpu_emulate");
  if (unsupportedEngine(data)) return skip(`cpu_emulate unsupported on engine: ${String(data.engine)}`);
  requireOk(data, "cpu_emulate");
  const throttledMs = await timedLoop(ctx);
  await ctx.call("cpu_emulate", { throttleRate: 1 });
  const applied = recordAt(data, "applied");
  const throttleRate = applied ? numberAt(applied, "throttleRate") : undefined;
  if (throttleRate === 4 && throttledMs > baselineMs * 1.2) {
    return pass("cpu_emulate applied a 4x throttle and the same page loop slowed down", {
      baselineMs,
      throttledMs,
      applied,
    });
  }
  return fail("cpu_emulate did not produce an observable slowdown", {
    baselineMs,
    throttledMs,
    data,
  });
});

const clock = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const atIso = "2030-01-02T03:04:05.000Z";
  const data = payloadRecord(await ctx.call("clock", { mode: "freeze", atIso }), "clock");
  if (unsupportedEngine(data)) return skip(`clock unsupported on engine: ${String(data.engine)}`);
  requireOk(data, "clock");
  const observed = await evalValue(ctx, "new Date().toISOString()");
  await ctx.call("clock", { mode: "release" });
  if (typeof observed === "string" && observed.startsWith("2030-01-02T03:04:05")) {
    return pass("clock froze Date on the page at the requested instant", {
      applied: data.applied,
      observed,
    });
  }
  return fail("clock did not freeze Date at the requested instant", { data, observed });
});

const seed_random = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const firstSeed = payloadRecord(await ctx.call("seed_random", { seed: 1337 }), "seed_random");
  requireOk(firstSeed, "seed_random");
  const first = numericArray(await evalValue(ctx, "[Math.random(), Math.random(), Math.random()]"));
  const secondSeed = payloadRecord(await ctx.call("seed_random", { seed: 1337 }), "seed_random");
  requireOk(secondSeed, "seed_random");
  const second = numericArray(await evalValue(ctx, "[Math.random(), Math.random(), Math.random()]"));
  if (first.length === 3 && second.length === 3 && first.every((value, index) => value === second[index])) {
    return pass("seed_random made Math.random deterministic for repeated seed application", {
      first,
      second,
      applied: firstSeed.applied,
    });
  }
  return fail("seed_random did not reproduce the same random sequence", {
    first,
    second,
    firstSeed,
    secondSeed,
  });
});

const flake_check = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const data = payloadRecord(
    await ctx.call("flake_check", {
      n: 3,
      stopOnAllGreen: 2,
      calls: [
        {
          tool: "navigate",
          label: "load perf",
          args: { url: `${ctx.baseUrl}/perf`, session: ctx.session },
        },
        {
          tool: "click",
          label: "thrash",
          args: { selector: PERF.thrash, session: ctx.session },
        },
      ],
    }),
    "flake_check",
  );
  const verified = await verifyText(ctx, PERF.out, "thrashed", true);
  const runsCompleted = numberAt(data, "runsCompleted");
  const steps = asRecords(data.steps);
  if (data.allGreen === true && runsCompleted !== undefined && runsCompleted >= 2 && steps.length === 2) {
    return pass("flake_check reran a stable navigate/click flow and the final page state was readable", {
      runsCompleted,
      firstDivergence: data.firstDivergence,
      steps,
      verified,
    });
  }
  return fail("flake_check did not report the stable flow as all-green", data);
});

const map: ExerciseMap = {
  perf_start,
  perf_stop,
  perf_insights,
  coverage_start,
  heap_snapshot,
  heap_retainers,
  cpu_emulate,
  clock,
  seed_random,
  flake_check,
};

export default map;
