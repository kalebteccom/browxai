// gesture_chain — multi-step pointer program (down / move / wheel / wait /
// up). Custom paint strokes, lasso paths, and gestures the canned `drag` /
// `gesture_swipe` family doesn't cover. (See canvas.ts header.)
//
// Bounded: caps at 200 steps, floors `move` step delays at 5 ms, bounds
// `wait` steps at 5000 ms.

export type GestureChainStepKind = "down" | "move" | "up" | "wait" | "wheel";

export interface GestureChainStep {
  kind: GestureChainStepKind;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  ms?: number;
  pointerId?: number;
}

export interface GestureChainArgs {
  steps: GestureChainStep[];
}

export interface GestureChainResult {
  ok: boolean;
  stepsExecuted: number;
  totalDurationMs: number;
  warnings: string[];
  error?: string;
  code?: string;
}

export const GESTURE_CHAIN_MAX_STEPS = 200;
export const GESTURE_CHAIN_MIN_MOVE_MS = 5;
export const GESTURE_CHAIN_MAX_WAIT_MS = 5000;

export interface ValidateGestureChainResult {
  ok: boolean;
  steps: GestureChainStep[];
  warnings: string[];
  error?: string;
  code?: string;
}

/** Per-step validation outcome: either an accepted clamped step, or a
 *  hard-refusal error (with code). Soft-clamp warnings are pushed onto the
 *  shared `warnings` accumulator. */
type StepOutcome =
  | { ok: true; step: GestureChainStep }
  | { ok: false; error: string; code: string };

function badStep(error: string): StepOutcome {
  return { ok: false, error, code: "bad-step" };
}

/** Validate + clamp a single pointer step (`down`/`up`/`move`). `move`
 *  floors its delay at GESTURE_CHAIN_MIN_MOVE_MS, warning when it clamps. */
function validatePointerStep(s: GestureChainStep, i: number, warnings: string[]): StepOutcome {
  if (typeof s.x !== "number" || typeof s.y !== "number") {
    return badStep(`gesture_chain: step[${i}] kind="${s.kind}" requires numeric x + y`);
  }
  const clamped: GestureChainStep = { kind: s.kind, x: s.x, y: s.y };
  if (s.pointerId !== undefined) clamped.pointerId = s.pointerId;
  if (s.kind === "move") {
    const ms = typeof s.ms === "number" ? s.ms : GESTURE_CHAIN_MIN_MOVE_MS;
    if (ms < GESTURE_CHAIN_MIN_MOVE_MS) {
      warnings.push(
        `gesture_chain: step[${i}] move ms=${ms} floored to ${GESTURE_CHAIN_MIN_MOVE_MS}ms — tighter pacing rarely changes app behaviour and starves the renderer`,
      );
      clamped.ms = GESTURE_CHAIN_MIN_MOVE_MS;
    } else {
      clamped.ms = ms;
    }
  }
  return { ok: true, step: clamped };
}

/** Validate + clamp a `wait` step. Refuses negatives; clamps over-long
 *  waits at GESTURE_CHAIN_MAX_WAIT_MS with a warning. */
function validateWaitStep(s: GestureChainStep, i: number, warnings: string[]): StepOutcome {
  const ms = typeof s.ms === "number" ? s.ms : 0;
  if (ms < 0) {
    return badStep(`gesture_chain: step[${i}] wait ms must be non-negative`);
  }
  const clamped: GestureChainStep = { kind: "wait" };
  if (ms > GESTURE_CHAIN_MAX_WAIT_MS) {
    warnings.push(
      `gesture_chain: step[${i}] wait ms=${ms} clamped to max ${GESTURE_CHAIN_MAX_WAIT_MS}ms — a single chained wait should not exceed 5s; split across calls`,
    );
    clamped.ms = GESTURE_CHAIN_MAX_WAIT_MS;
  } else {
    clamped.ms = ms;
  }
  return { ok: true, step: clamped };
}

/** Validate a `wheel` step — requires a non-zero delta; carries optional
 *  cursor position. */
function validateWheelStep(s: GestureChainStep, i: number): StepOutcome {
  const dx = typeof s.deltaX === "number" ? s.deltaX : 0;
  const dy = typeof s.deltaY === "number" ? s.deltaY : 0;
  if (dx === 0 && dy === 0) {
    return badStep(`gesture_chain: step[${i}] wheel requires non-zero deltaX or deltaY`);
  }
  const clamped: GestureChainStep = { kind: "wheel", deltaX: dx, deltaY: dy };
  if (typeof s.x === "number") clamped.x = s.x;
  if (typeof s.y === "number") clamped.y = s.y;
  return { ok: true, step: clamped };
}

function validateStep(s: GestureChainStep, i: number, warnings: string[]): StepOutcome {
  if (!s || typeof s.kind !== "string") {
    return badStep(`gesture_chain: step[${i}] missing kind`);
  }
  if (s.kind === "down" || s.kind === "up" || s.kind === "move") {
    return validatePointerStep(s, i, warnings);
  }
  if (s.kind === "wait") return validateWaitStep(s, i, warnings);
  if (s.kind === "wheel") return validateWheelStep(s, i);
  return badStep(`gesture_chain: step[${i}] unknown kind "${String(s.kind)}"`);
}

/** Validate + clamp a gesture-chain step list. Pure function — returns
 *  the normalised step list + any warnings the runtime should surface.
 *  Hard caps (max steps) refuse loudly; soft caps (min move ms, max wait
 *  ms) clamp + warn. */
export function validateGestureChain(steps: GestureChainStep[]): ValidateGestureChainResult {
  const warnings: string[] = [];
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, steps: [], warnings, error: "gesture_chain: `steps` must be a non-empty array", code: "no-steps" };
  }
  if (steps.length > GESTURE_CHAIN_MAX_STEPS) {
    return {
      ok: false,
      steps: [],
      warnings,
      error: `gesture_chain: ${steps.length} steps exceeds the maximum ${GESTURE_CHAIN_MAX_STEPS}; split the program across multiple calls`,
      code: "too-many-steps",
    };
  }
  const out: GestureChainStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const outcome = validateStep(steps[i]!, i, warnings);
    if (!outcome.ok) {
      return { ok: false, steps: [], warnings, error: outcome.error, code: outcome.code };
    }
    out.push(outcome.step);
  }
  return { ok: true, steps: out, warnings };
}

/** Thin adapter so unit tests can stub Playwright's `page.mouse`. */
export interface GestureChainPage {
  mouse: {
    down(options?: { button?: "left" | "right" | "middle" }): Promise<void>;
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    up(options?: { button?: "left" | "right" | "middle" }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
}

/** Execute one validated step against the page mouse. */
async function runGestureStep(page: GestureChainPage, s: GestureChainStep): Promise<void> {
  if (s.kind === "down") {
    // Position the pointer at the down point so the press lands where the
    // caller asked. Playwright's mouse.down() acts at the current pointer
    // position only.
    await page.mouse.move(s.x!, s.y!);
    await page.mouse.down();
  } else if (s.kind === "up") {
    await page.mouse.move(s.x!, s.y!);
    await page.mouse.up();
  } else if (s.kind === "move") {
    await page.mouse.move(s.x!, s.y!);
    if (s.ms && s.ms > 0) await new Promise((r) => setTimeout(r, s.ms));
  } else if (s.kind === "wait") {
    if (s.ms && s.ms > 0) await new Promise((r) => setTimeout(r, s.ms));
  } else if (s.kind === "wheel") {
    if (typeof s.x === "number" && typeof s.y === "number") {
      await page.mouse.move(s.x, s.y);
    }
    await page.mouse.wheel(s.deltaX ?? 0, s.deltaY ?? 0);
  }
}

/** Execute a validated step list against a Playwright page mouse. */
export async function runGestureChain(
  page: GestureChainPage,
  args: GestureChainArgs,
): Promise<GestureChainResult> {
  const v = validateGestureChain(args.steps);
  if (!v.ok) {
    return {
      ok: false,
      stepsExecuted: 0,
      totalDurationMs: 0,
      warnings: v.warnings,
      ...(v.error ? { error: v.error } : {}),
      ...(v.code ? { code: v.code } : {}),
    };
  }
  const started = Date.now();
  let executed = 0;
  for (const s of v.steps) {
    await runGestureStep(page, s);
    executed++;
  }
  return {
    ok: true,
    stepsExecuted: executed,
    totalDurationMs: Date.now() - started,
    warnings: v.warnings,
  };
}
