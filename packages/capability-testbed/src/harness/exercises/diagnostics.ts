import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

function exercise(fn: (ctx: ExerciseCtx) => Promise<ExerciseResult>): Exercise {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      return fail("exercise failed unexpectedly", errorEvidence(err));
    }
  };
}

function errorEvidence(err: unknown): JsonRecord {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { thrown: err };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
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

function dataRecord(value: unknown): JsonRecord | undefined {
  const data = payload(value);
  return isRecord(data) ? data : undefined;
}

const diagnostics_note = exercise(async (ctx) => {
  await ctx.goto("/core");
  const since = new Date(Date.now() - 1000).toISOString();
  const insight = `capability-testbed diagnostics note ${ctx.session}`;
  const note = dataRecord(
    await ctx.call("diagnostics_note", {
      insight,
      category: "ergonomic-friction",
      severity: "info",
      ref: "capability-testbed",
    }),
  );
  const search = dataRecord(
    await ctx.call("diagnostics_search", {
      since,
      category: "ergonomic-friction",
      sessionId: ctx.session,
      limit: 20,
    }),
  );
  const found = records(search?.records).find((record) => record.insight === insight);
  if (note?.ok === true && note.session === ctx.session && found?.kind === "note") {
    return pass("diagnostics_note wrote a note retrievable by diagnostics_search", {
      note,
      found,
    });
  }
  return fail("diagnostics_note was not found through diagnostics_search", { note, search });
});

const map: ExerciseMap = {
  diagnostics_note,
};

export default map;
