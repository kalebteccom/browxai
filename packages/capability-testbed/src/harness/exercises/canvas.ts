import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const CANVAS = {
  stage: '[data-testid="canvas-stage"]',
  recolor: '[data-testid="recolor"]',
  out: '[data-testid="canvas-out"]',
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
  const data = isRecord(value) && "data" in value ? value.data : undefined;
  const text = firstText(value);
  if (data !== undefined) return data;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function payloadRecord(value: unknown, label: string): JsonRecord {
  const data = payload(value);
  if (!isRecord(data)) throw new Error(`${label} did not return a JSON object`);
  return data;
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

function boxFromRecord(value: unknown, label: string): Box {
  if (!isRecord(value)) throw new Error(`${label} did not include a box`);
  const x = numberAt(value, "x");
  const y = numberAt(value, "y");
  const width = numberAt(value, "width");
  const height = numberAt(value, "height");
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new Error(`${label} box was malformed`);
  }
  return { x, y, width, height };
}

function closeTo(actual: number | undefined, expected: number, epsilon = 0.001): boolean {
  return actual !== undefined && Math.abs(actual - expected) <= epsilon;
}

function nonEmptyBase64(value: unknown): value is string {
  return typeof value === "string" && value.length > 32;
}

async function captureImageData(ctx: ExerciseCtx): Promise<JsonRecord> {
  return payloadRecord(
    await ctx.call("canvas_capture", { selector: CANVAS.stage, format: "2d-imagedata" }),
    "canvas_capture",
  );
}

async function evalRecord(ctx: ExerciseCtx, expr: string, label: string): Promise<JsonRecord> {
  const data = payloadRecord(await ctx.call("eval_js", { expr, returnType: "json" }), "eval_js");
  if (data.ok !== true) throw new Error(`${label} eval_js returned ok:false`);
  const value = data.value;
  if (!isRecord(value)) throw new Error(`${label} eval_js value was not an object`);
  return value;
}

async function installDiscoverableTransform(ctx: ExerciseCtx): Promise<JsonRecord> {
  return evalRecord(
    ctx,
    `(() => {
      window.app = { scale: 2, offset: { x: 5, y: 7 } };
      return { ok: true, scale: window.app.scale, offset: window.app.offset };
    })()`,
    "canvas transform setup",
  );
}

async function boxFor(ctx: ExerciseCtx, selector: string): Promise<Box> {
  const data = payloadRecord(await ctx.call("inspect", { selector }), "inspect");
  if (data.found !== true) throw new Error(`inspect did not find ${selector}`);
  return boxFromRecord(data.box, "inspect");
}

const canvas_capture = exercise(async (ctx) => {
  await ctx.goto("/canvas");
  const data = payloadRecord(
    await ctx.call("canvas_capture", { selector: CANVAS.stage, format: "png" }),
    "canvas_capture",
  );
  if (
    data.ok === true &&
    data.format === "png" &&
    numberAt(data, "width") === 400 &&
    numberAt(data, "height") === 300 &&
    numberAt(data, "byteLength") !== undefined &&
    nonEmptyBase64(data.contentBase64)
  ) {
    return pass("canvas_capture returned non-empty PNG bytes for the test canvas", data);
  }
  return fail("canvas_capture did not return the expected PNG payload", data);
});

const canvas_diff = exercise(async (ctx) => {
  await ctx.goto("/canvas");
  const before = await captureImageData(ctx);
  await ctx.call("click", { selector: CANVAS.recolor });
  const after = await captureImageData(ctx);
  const width = numberAt(before, "width");
  const height = numberAt(before, "height");
  if (
    before.ok !== true ||
    after.ok !== true ||
    before.format !== "2d-imagedata" ||
    after.format !== "2d-imagedata" ||
    width === undefined ||
    height === undefined ||
    !nonEmptyBase64(before.contentBase64) ||
    !nonEmptyBase64(after.contentBase64)
  ) {
    return fail("canvas_diff setup did not capture comparable canvas image data", { before, after });
  }
  const diff = payloadRecord(
    await ctx.call("canvas_diff", {
      beforeBase64: before.contentBase64,
      afterBase64: after.contentBase64,
      width,
      height,
      inputFormat: "rgba",
    }),
    "canvas_diff",
  );
  if (
    diff.ok === true &&
    (numberAt(diff, "changedPixelCount") ?? 0) > 0 &&
    (numberAt(diff, "changedBytes") ?? 0) > 0 &&
    isRecord(diff.bboxOfChanges)
  ) {
    return pass("canvas_diff detected the recolored canvas region", { before, after, diff });
  }
  return fail("canvas_diff did not report the expected pixel changes", { before, after, diff });
});

const canvas_query = exercise(async (ctx) => {
  await ctx.goto("/canvas");
  const data = payloadRecord(
    await ctx.call("canvas_query", {
      adapter: "missing-testbed-adapter",
      op: "bounds",
      args: { selector: CANVAS.stage },
    }),
    "canvas_query",
  );
  if (
    data.ok === false &&
    data.code === "no-adapter" &&
    data.requestedAdapter === "missing-testbed-adapter" &&
    data.requestedOp === "bounds"
  ) {
    return pass("canvas_query returned the structured no-adapter result", data);
  }
  return fail("canvas_query did not return the expected no-adapter shape", data);
});

const canvas_world_to_screen = exercise(async (ctx) => {
  await ctx.goto("/canvas");
  const setup = await installDiscoverableTransform(ctx);
  const data = payloadRecord(
    await ctx.call("canvas_world_to_screen", {
      selector: CANVAS.stage,
      worldX: 10,
      worldY: 20,
    }),
    "canvas_world_to_screen",
  );
  const transform = recordAt(data, "transformDiscovered");
  if (
    data.ok === true &&
    closeTo(numberAt(data, "screenX"), 30) &&
    closeTo(numberAt(data, "screenY"), 54) &&
    data.adapterHint === "tldraw" &&
    transform
  ) {
    return pass("canvas_world_to_screen mapped a world point through a discovered transform", {
      setup,
      data,
    });
  }
  return fail("canvas_world_to_screen did not return the expected mapped point", { setup, data });
});

const canvas_screen_to_world = exercise(async (ctx) => {
  await ctx.goto("/canvas");
  const setup = await installDiscoverableTransform(ctx);
  const data = payloadRecord(
    await ctx.call("canvas_screen_to_world", {
      selector: CANVAS.stage,
      screenX: 30,
      screenY: 54,
    }),
    "canvas_screen_to_world",
  );
  const transform = recordAt(data, "transformDiscovered");
  if (
    data.ok === true &&
    closeTo(numberAt(data, "worldX"), 10) &&
    closeTo(numberAt(data, "worldY"), 20) &&
    data.adapterHint === "tldraw" &&
    transform
  ) {
    return pass("canvas_screen_to_world mapped a screen point back through a discovered transform", {
      setup,
      data,
    });
  }
  return fail("canvas_screen_to_world did not return the expected world point", { setup, data });
});

const gesture_chain = exercise(async (ctx) => {
  await ctx.goto("/canvas");
  const box = await boxFor(ctx, CANVAS.stage);
  const start = { x: box.x + 30, y: box.y + 30 };
  const middle = { x: box.x + 85, y: box.y + 70 };
  const end = { x: box.x + 140, y: box.y + 95 };
  const data = payloadRecord(
    await ctx.call("gesture_chain", {
      steps: [
        { kind: "down", x: start.x, y: start.y },
        { kind: "move", x: middle.x, y: middle.y, ms: 15 },
        { kind: "move", x: end.x, y: end.y, ms: 15 },
        { kind: "up", x: end.x, y: end.y },
      ],
    }),
    "gesture_chain",
  );
  const state = await evalRecord(
    ctx,
    `(() => {
      const out = document.querySelector('[data-testid="canvas-out"]');
      const stroke = Array.isArray(window.__lastStroke) ? window.__lastStroke : [];
      return { text: out ? out.textContent : "", strokeLength: stroke.length };
    })()`,
    "gesture chain verification",
  );
  if (
    data.ok === true &&
    numberAt(data, "stepsExecuted") === 4 &&
    (numberAt(state, "strokeLength") ?? 0) >= 2 &&
    stringAt(state, "text")?.startsWith("stroke points:")
  ) {
    return pass("gesture_chain dispatched a pointer stroke recorded by the canvas page", {
      data,
      state,
    });
  }
  return fail("gesture_chain did not leave the expected recorded stroke", { data, state });
});

const exercises = {
  canvas_capture,
  canvas_diff,
  canvas_query,
  canvas_world_to_screen,
  canvas_screen_to_world,
  gesture_chain,
} satisfies ExerciseMap;

export default exercises;
