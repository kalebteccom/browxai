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

function numberAt(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const eval_js = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("eval_js", {
    expr: "document.title",
    returnType: "json",
  });
  const data = dataRecord(result);
  const visible = dataRecord(
    await ctx.call("verify_text", {
      selector: '[data-testid="greeting"]',
      text: "Hello, browxai",
      exact: true,
    }),
  );
  if (data?.ok === true && data.value === "Core read surface" && visible?.ok === true) {
    return pass("eval_js returned the core document title and read verification passed", {
      data,
      visible,
    });
  }
  return fail("eval_js did not return the expected core document title", { data, visible });
});

const poll_eval = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("poll_eval", {
    expr: "window.__counter >= 2",
    intervalMs: 50,
    timeoutMs: 1500,
  });
  const data = dataRecord(result);
  const counter = dataRecord(
    await ctx.call("eval_js", {
      expr: "window.__counter",
      returnType: "json",
    }),
  );
  if (
    data?.ok === true &&
    data.truthy === true &&
    data.value === true &&
    data.timedOut === false &&
    numberAt(data, "polls") !== undefined &&
    typeof counter?.value === "number"
  ) {
    return pass("poll_eval observed the advancing core counter before timeout", {
      poll: data,
      counter,
    });
  }
  return fail("poll_eval did not observe the advancing counter", { poll: data, counter });
});

const map: ExerciseMap = {
  eval_js,
  poll_eval,
};

export default map;
