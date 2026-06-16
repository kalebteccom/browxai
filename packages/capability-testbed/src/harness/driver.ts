import { EXERCISES } from "./exercises/index.js";
import type {
  BrowxaiResult,
  Client,
  ExerciseCtx,
  ExerciseResult,
  ManifestRow,
  ToolReport,
} from "./types.js";

const logsByContext = new WeakMap<ExerciseCtx, string[]>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorEvidence(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return { thrown: err };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`exercise timed out after ${ms}ms`)), ms);
  });
}

function resultWithTimeout(exercise: Promise<ExerciseResult>, timeoutMs: number): Promise<ExerciseResult> {
  return Promise.race([exercise, timeout(timeoutMs)]);
}

function joinedUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function buildContext(
  client: Client,
  session: string,
  baseUrl: string,
  workspace: string,
): Promise<ExerciseCtx> {
  const log: string[] = [];
  const ctx: ExerciseCtx = {
    client,
    session,
    baseUrl,
    workspace,
    async goto(path: string): Promise<BrowxaiResult> {
      const result = await client.callTool("navigate", { session, url: joinedUrl(baseUrl, path) });
      try {
        await client.callTool("snapshot", { session });
      } catch {
        await delay(250);
      }
      return result;
    },
    async call(tool: string, args: Record<string, unknown> = {}): Promise<BrowxaiResult> {
      return client.callTool(tool, { ...args, session });
    },
    log(msg: string): void {
      log.push(msg);
    },
  };
  logsByContext.set(ctx, log);
  return ctx;
}

export async function runExercise(
  row: ManifestRow,
  ctx: ExerciseCtx,
  timeoutMs: number,
): Promise<ToolReport> {
  const started = Date.now();
  const exercise = EXERCISES[row.tool];
  const log = logsByContext.get(ctx) ?? [];

  if (!exercise) {
    return {
      tool: row.tool,
      capability: row.capability,
      outcome: "pending",
      detail: "No exercise registered for this tool",
      durationMs: Date.now() - started,
      log: [...log],
    };
  }

  try {
    const result = await resultWithTimeout(exercise(ctx), timeoutMs);
    return {
      tool: row.tool,
      capability: row.capability,
      outcome: result.outcome,
      detail: result.detail,
      evidence: result.evidence,
      durationMs: Date.now() - started,
      log: [...log],
    };
  } catch (err) {
    return {
      tool: row.tool,
      capability: row.capability,
      outcome: "error",
      detail: err instanceof Error ? err.message : "Exercise threw a non-Error value",
      evidence: errorEvidence(err),
      durationMs: Date.now() - started,
      log: [...log],
    };
  }
}
