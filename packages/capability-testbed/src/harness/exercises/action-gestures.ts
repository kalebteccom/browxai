import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const GESTURES = {
  chip: '[data-testid="drag-chip"]',
  dropTarget: '[data-testid="drop-target"]',
  dropOut: '[data-testid="drop-out"]',
  dblBtn: '[data-testid="dbl-btn"]',
  dblOut: '[data-testid="dbl-out"]',
  touchpad: '[data-testid="touchpad"]',
  touchOut: '[data-testid="touch-out"]',
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

function centre(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function pointIn(box: Box, xRatio: number, yRatio: number): Point {
  return { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio };
}

function verifyOk(data: JsonRecord): boolean {
  return data.ok === true;
}

function actionFailed(tool: string, data: JsonRecord): ExerciseResult | undefined {
  return data.ok === true ? undefined : fail(`${tool} returned ok:false`, data);
}

function structuredRefusal(data: JsonRecord): boolean {
  const error = stringAt(data, "error")?.toLowerCase() ?? "";
  return (
    data.ok === false &&
    (typeof data.engine === "string" ||
      typeof data.hint === "string" ||
      error.includes("not supported") ||
      error.includes("cdp"))
  );
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("verify_text", { selector, text, exact }), "verify_text");
}

async function verifyAttribute(
  ctx: ExerciseCtx,
  selector: string,
  attr: string,
  value?: string,
): Promise<JsonRecord> {
  const args: Record<string, unknown> = { selector, attr };
  if (value !== undefined) args.value = value;
  return payloadRecord(await ctx.call("verify_attribute", args), "verify_attribute");
}

async function evalRecord(ctx: ExerciseCtx, expr: string, label: string): Promise<JsonRecord> {
  const data = payloadRecord(await ctx.call("eval_js", { expr }), "eval_js");
  if (data.ok !== true) throw new Error(`${label} eval_js returned ok:false`);
  const value = data.value;
  if (!isRecord(value)) throw new Error(`${label} eval_js value was not an object`);
  return value;
}

async function boxFor(ctx: ExerciseCtx, selector: string): Promise<Box> {
  const data = payloadRecord(await ctx.call("inspect", { selector }), "inspect");
  if (data.found !== true) throw new Error(`inspect did not find ${selector}`);
  return boxFromRecord(data.box, "inspect");
}

async function touchOutState(ctx: ExerciseCtx): Promise<JsonRecord> {
  return evalRecord(
    ctx,
    `(() => {
      const node = document.querySelector('[data-testid="touch-out"]');
      if (!node) return { found: false };
      return {
        found: true,
        text: node.textContent || "",
        moved: node.getAttribute("data-moved"),
        wheel: node.getAttribute("data-wheel"),
        ended: node.getAttribute("data-ended")
      };
    })()`,
    "touch output",
  );
}

async function installPointerMoveLogger(ctx: ExerciseCtx): Promise<void> {
  const setup = payloadRecord(
    await ctx.call("eval_js", {
      expr: `(() => {
        const pad = document.querySelector('[data-testid="touchpad"]');
        const out = document.querySelector('[data-testid="touch-out"]');
        if (!pad || !out) return { ok: false, error: "touchpad missing" };
        pad.addEventListener("pointermove", (event) => {
          out.textContent = "mouse-move:" + Math.round(event.clientX) + "," + Math.round(event.clientY);
          out.setAttribute("data-moved", "1");
        }, { once: true });
        return { ok: true };
      })()`,
    }),
    "eval_js",
  );
  if (setup.ok !== true) throw new Error("failed to install pointermove logger");
}

async function installWheelLogger(ctx: ExerciseCtx): Promise<void> {
  const setup = payloadRecord(
    await ctx.call("eval_js", {
      expr: `(() => {
        const pad = document.querySelector('[data-testid="touchpad"]');
        const out = document.querySelector('[data-testid="touch-out"]');
        if (!pad || !out) return { ok: false, error: "touchpad missing" };
        // NON-passive on purpose: Chromium dispatches CDP-injected wheel events
        // to passive listeners asynchronously (compositor thread), so a passive
        // listener would not have fired by the time the exercise reads the
        // attribute. A non-passive listener fires synchronously on the main
        // thread. (browxai dispatches the wheel correctly either way.)
        pad.addEventListener("wheel", (event) => {
          out.textContent = "wheel:" + Math.round(event.deltaY);
          out.setAttribute("data-wheel", "1");
        }, { once: true });
        return { ok: true };
      })()`,
    }),
    "eval_js",
  );
  if (setup.ok !== true) throw new Error("failed to install wheel logger");
}

async function installTouchEndLogger(ctx: ExerciseCtx): Promise<void> {
  const setup = payloadRecord(
    await ctx.call("eval_js", {
      expr: `(() => {
        const pad = document.querySelector('[data-testid="touchpad"]');
        const out = document.querySelector('[data-testid="touch-out"]');
        if (!pad || !out) return { ok: false, error: "touchpad missing" };
        pad.addEventListener("touchend", (event) => {
          out.textContent = "touchend:" + event.touches.length;
          out.setAttribute("data-ended", "1");
        }, { once: true, passive: true });
        return { ok: true };
      })()`,
    }),
    "eval_js",
  );
  if (setup.ok !== true) throw new Error("failed to install touchend logger");
}

const drag = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  const action = payloadRecord(
    await ctx.call("drag", {
      from: { selector: GESTURES.chip },
      to: { selector: GESTURES.dropTarget },
      steps: 8,
    }),
    "drag",
  );
  const failed = actionFailed("drag", action);
  if (failed) return failed;
  const verify = await verifyText(ctx, GESTURES.dropOut, "dropped:chip", true);
  if (verifyOk(verify)) {
    return pass("drag moved the chip onto the drop target", { action, verify });
  }
  return fail("drag did not update the drop output", { action, verify });
});

const double_click = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  const action = payloadRecord(
    await ctx.call("double_click", { target: { selector: GESTURES.dblBtn } }),
    "double_click",
  );
  const failed = actionFailed("double_click", action);
  if (failed) return failed;
  const verify = await verifyText(ctx, GESTURES.dblOut, "1", true);
  if (verifyOk(verify)) {
    return pass("double_click incremented the double-click counter", { action, verify });
  }
  return fail("double_click did not increment the counter", { action, verify });
});

const mouse_down = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  const point = centre(await boxFor(ctx, GESTURES.touchpad));
  const action = payloadRecord(await ctx.call("mouse_down", { coords: point }), "mouse_down");
  const failed = actionFailed("mouse_down", action);
  if (failed) return failed;
  const verify = await verifyText(ctx, GESTURES.touchOut, "pointers:1", true);
  if (verifyOk(verify)) {
    return pass("mouse_down fired pointerdown on the touchpad", { point, action, verify });
  }
  return fail("mouse_down did not update the pointer count", { point, action, verify });
});

const mouse_move = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  await installPointerMoveLogger(ctx);
  const point = pointIn(await boxFor(ctx, GESTURES.touchpad), 0.65, 0.55);
  const action = payloadRecord(await ctx.call("mouse_move", { coords: point }), "mouse_move");
  const failed = actionFailed("mouse_move", action);
  if (failed) return failed;
  const attr = await verifyAttribute(ctx, GESTURES.touchOut, "data-moved", "1");
  const state = await touchOutState(ctx);
  const text = stringAt(state, "text") ?? "";
  if (verifyOk(attr) && text.startsWith("mouse-move:")) {
    return pass("mouse_move fired pointermove over the touchpad", { point, action, attr, state });
  }
  return fail("mouse_move did not fire the pointermove logger", { point, action, attr, state });
});

const mouse_up = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  const point = centre(await boxFor(ctx, GESTURES.touchpad));
  const down = payloadRecord(await ctx.call("mouse_down", { coords: point }), "mouse_down");
  const downFailed = actionFailed("mouse_down setup", down);
  if (downFailed) return downFailed;
  const downVerify = await verifyText(ctx, GESTURES.touchOut, "pointers:1", true);
  if (!verifyOk(downVerify)) {
    return fail("mouse_up setup did not establish a pressed pointer", { point, down, downVerify });
  }
  const action = payloadRecord(await ctx.call("mouse_up", { coords: point }), "mouse_up");
  const failed = actionFailed("mouse_up", action);
  if (failed) return failed;
  const verify = await verifyText(ctx, GESTURES.touchOut, "pointers:0", true);
  if (verifyOk(verify)) {
    return pass("mouse_up released the pointer on the touchpad", {
      point,
      down,
      downVerify,
      action,
      verify,
    });
  }
  return fail("mouse_up did not drop the pointer count", { point, down, downVerify, action, verify });
});

const mouse_wheel = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  await installWheelLogger(ctx);
  const point = centre(await boxFor(ctx, GESTURES.touchpad));
  const action = payloadRecord(
    await ctx.call("mouse_wheel", { coords: point, deltaY: 42 }),
    "mouse_wheel",
  );
  if (structuredRefusal(action)) {
    return pass("mouse_wheel returned a structured engine refusal", action);
  }
  const failed = actionFailed("mouse_wheel", action);
  if (failed) return failed;
  const attr = await verifyAttribute(ctx, GESTURES.touchOut, "data-wheel", "1");
  const state = await touchOutState(ctx);
  if (verifyOk(attr) && stringAt(state, "text") === "wheel:42") {
    return pass("mouse_wheel dispatched a wheel event at the touchpad", {
      point,
      action,
      attr,
      state,
    });
  }
  return fail("mouse_wheel did not reach the touchpad wheel listener", {
    point,
    action,
    attr,
    state,
  });
});

const touch_start = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  const point = centre(await boxFor(ctx, GESTURES.touchpad));
  const action = payloadRecord(
    await ctx.call("touch_start", { coords: point, identifier: 11 }),
    "touch_start",
  );
  if (structuredRefusal(action)) {
    return pass("touch_start returned a structured engine refusal", action);
  }
  const failed = actionFailed("touch_start", action);
  if (failed) return failed;
  const verify = await verifyText(ctx, GESTURES.touchOut, "touches:1", true);
  if (verifyOk(verify)) {
    return pass("touch_start fired the touchstart handler", { point, action, verify });
  }
  return fail("touch_start did not update the touch count", { point, action, verify });
});

const touch_move = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  const box = await boxFor(ctx, GESTURES.touchpad);
  const start = pointIn(box, 0.35, 0.45);
  const moveTo = pointIn(box, 0.62, 0.6);
  const setup = payloadRecord(
    await ctx.call("touch_start", { coords: start, identifier: 21 }),
    "touch_start",
  );
  if (structuredRefusal(setup)) {
    const refusedMove = payloadRecord(
      await ctx.call("touch_move", { coords: moveTo, identifier: 21 }),
      "touch_move",
    );
    if (structuredRefusal(refusedMove)) {
      return pass("touch_move returned a structured engine refusal", { setup, refusedMove });
    }
    return fail("touch_start refused but touch_move did not return a matching refusal", {
      setup,
      refusedMove,
    });
  }
  const setupFailed = actionFailed("touch_start setup", setup);
  if (setupFailed) return setupFailed;
  const setupVerify = await verifyText(ctx, GESTURES.touchOut, "touches:1", true);
  if (!verifyOk(setupVerify)) {
    return fail("touch_move setup did not establish an active touch", { setup, setupVerify });
  }
  const action = payloadRecord(
    await ctx.call("touch_move", { coords: moveTo, identifier: 21 }),
    "touch_move",
  );
  if (structuredRefusal(action)) {
    return pass("touch_move returned a structured engine refusal", action);
  }
  const failed = actionFailed("touch_move", action);
  if (failed) return failed;
  const verify = await verifyText(ctx, GESTURES.touchOut, "move-touches:1", true);
  if (verifyOk(verify)) {
    return pass("touch_move fired the touchmove handler", {
      start,
      moveTo,
      setup,
      setupVerify,
      action,
      verify,
    });
  }
  return fail("touch_move did not update the move touch count", {
    start,
    moveTo,
    setup,
    setupVerify,
    action,
    verify,
  });
});

const touch_end = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  await installTouchEndLogger(ctx);
  const point = centre(await boxFor(ctx, GESTURES.touchpad));
  const setup = payloadRecord(
    await ctx.call("touch_start", { coords: point, identifier: 31 }),
    "touch_start",
  );
  if (structuredRefusal(setup)) {
    const refusedEnd = payloadRecord(await ctx.call("touch_end", { identifier: 31 }), "touch_end");
    if (structuredRefusal(refusedEnd)) {
      return pass("touch_end returned a structured engine refusal", { setup, refusedEnd });
    }
    return fail("touch_start refused but touch_end did not return a matching refusal", {
      setup,
      refusedEnd,
    });
  }
  const setupFailed = actionFailed("touch_start setup", setup);
  if (setupFailed) return setupFailed;
  const setupVerify = await verifyText(ctx, GESTURES.touchOut, "touches:1", true);
  if (!verifyOk(setupVerify)) {
    return fail("touch_end setup did not establish an active touch", { point, setup, setupVerify });
  }
  const action = payloadRecord(await ctx.call("touch_end", { identifier: 31 }), "touch_end");
  if (structuredRefusal(action)) {
    return pass("touch_end returned a structured engine refusal", action);
  }
  const failed = actionFailed("touch_end", action);
  if (failed) return failed;
  const attr = await verifyAttribute(ctx, GESTURES.touchOut, "data-ended", "1");
  const state = await touchOutState(ctx);
  if (verifyOk(attr) && stringAt(state, "text") === "touchend:0") {
    return pass("touch_end fired the touchend handler and cleared touches", {
      point,
      setup,
      setupVerify,
      action,
      attr,
      state,
    });
  }
  return fail("touch_end did not update the touchend output", {
    point,
    setup,
    setupVerify,
    action,
    attr,
    state,
  });
});

const gesture_pinch = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  const point = centre(await boxFor(ctx, GESTURES.touchpad));
  const action = payloadRecord(
    await ctx.call("gesture_pinch", { coords: point, scale: 1.5, steps: 4, startOffset: 20 }),
    "gesture_pinch",
  );
  if (structuredRefusal(action)) {
    return pass("gesture_pinch returned a structured engine refusal", action);
  }
  const failed = actionFailed("gesture_pinch", action);
  if (failed) return failed;
  const state = await touchOutState(ctx);
  const text = stringAt(state, "text") ?? "";
  if (text === "move-touches:2" || text === "touches:2") {
    return pass("gesture_pinch dispatched a two-touch sequence on the touchpad", {
      point,
      action,
      state,
    });
  }
  return fail("gesture_pinch did not produce two-touch DOM evidence", { point, action, state });
});

const gesture_swipe = exercise(async (ctx) => {
  await ctx.goto("/gestures");
  const box = await boxFor(ctx, GESTURES.touchpad);
  const from = pointIn(box, 0.75, 0.5);
  const to = pointIn(box, 0.25, 0.5);
  const action = payloadRecord(
    await ctx.call("gesture_swipe", { from, to, durationMs: 120, steps: 6, identifier: 41 }),
    "gesture_swipe",
  );
  if (structuredRefusal(action)) {
    return pass("gesture_swipe returned a structured engine refusal", action);
  }
  const failed = actionFailed("gesture_swipe", action);
  if (failed) return failed;
  const state = await touchOutState(ctx);
  if (stringAt(state, "text") === "move-touches:1") {
    return pass("gesture_swipe dispatched a one-touch swipe on the touchpad", {
      from,
      to,
      action,
      state,
    });
  }
  return fail("gesture_swipe did not produce one-touch move evidence", { from, to, action, state });
});

const exercises = {
  drag,
  double_click,
  mouse_down,
  mouse_move,
  mouse_up,
  mouse_wheel,
  touch_start,
  touch_move,
  touch_end,
  gesture_pinch,
  gesture_swipe,
} satisfies ExerciseMap;

export default exercises;
