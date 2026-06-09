// `screenshot_on` — event-driven screenshot capture. Arm a trigger over a
// bounded observation window; snap a screenshot every time the trigger
// fires; return when the window closes (or the per-window cap is hit).
//
// Sibling of `screenshot_schedule` (periodic cadence): both share the
// workspace-rooted disk-write contract and the `file-io` capability gate.
//
// Anti-wedge: the call is bounded by `durationMs` (required); the per-window
// capture cap (`MAX_TRIGGERS_PER_WINDOW`) prevents runaway in event storms
// (e.g. a console-error-on-every-frame loop). The outer MCP handler wraps
// the controller in `withDeadline` against the action-timeout.
//
// Trigger surface is fixed:
//   - `navigation`         → page `framenavigated` (main-frame only)
//   - `console-error`      → page `console` type === "error" OR `pageerror`
//   - `network-mutation`   → CDP `Network.responseReceived` for a write-shaped
//                            method (POST/PUT/PATCH/DELETE) with 2xx status
//   - `dialog`             → page `dialog` (alert/confirm/prompt/beforeunload)
//
// Trigger sources are injectable so the controller stays browser-agnostic for
// unit tests. The real wiring (in server.ts) hooks into Playwright's `Page`
// event API + the per-session `CDPSession`.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { resolveWorkspacePath } from "../session/storage.js";

export const TRIGGERS = ["navigation", "console-error", "network-mutation", "dialog"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** Max captures per `screenshot_on` window. The window is already bounded by
 *  `durationMs`; this cap prevents an event-storm trigger (e.g. console-error
 *  fired every animation frame) from filling disk with thousands of frames in
 *  a multi-second window. Surfaced as a `warnings[]` entry when reached. */
export const MAX_TRIGGERS_PER_WINDOW = 50;
export const MIN_DURATION_MS = 1;
export const MAX_DURATION_MS = 600_000; // 10 minutes

export interface ScreenshotOnArgs {
  trigger: Trigger;
  /** Observation window length (ms). Required — the trigger is armed for
   *  exactly this long. */
  durationMs: number;
  /** Workspace-rooted output directory. The server handler defaults this. */
  intoDir: string;
  /** `"png"` (default) or `"jpeg"`. */
  format?: "png" | "jpeg";
}

export interface ScreenshotOnResult {
  intoDir: string;
  trigger: Trigger;
  /** Per-capture offset (ms from window start). */
  capturedAt: number[];
  /** Absolute paths to written files (same length as `capturedAt`). */
  paths: string[];
  warnings: string[];
}

export function validateOnArgs(args: ScreenshotOnArgs): void {
  if (!TRIGGERS.includes(args.trigger)) {
    throw new Error(
      `screenshot_on: \`trigger\` must be one of [${TRIGGERS.join(", ")}] — got "${args.trigger}"`,
    );
  }
  if (
    !Number.isFinite(args.durationMs) ||
    args.durationMs < MIN_DURATION_MS ||
    args.durationMs > MAX_DURATION_MS
  ) {
    throw new Error(
      `screenshot_on: \`durationMs\` must be in [${MIN_DURATION_MS}, ${MAX_DURATION_MS}] — got ${args.durationMs}`,
    );
  }
}

export type SnapFn = () => Promise<Buffer>;

/** Subscribe-once handle returned by a trigger source. The controller passes
 *  in a callback fired on every trigger event; the source returns a disposer
 *  it MUST call exactly once when the window closes (no listener leaks). */
export type TriggerDisposer = () => void;
export interface TriggerSource {
  /** Subscribe to `trigger` events. Returns a disposer the controller calls
   *  on window close (success or wedge). */
  subscribe(trigger: Trigger, onFire: () => void): TriggerDisposer;
}

/** Injectable timing seam. */
export interface OnClock {
  now(): number;
  /** Returns a promise that resolves after `ms`. Cancellable via the returned
   *  disposer (used to short-circuit when the per-window cap is hit). */
  setTimeout(fn: () => void, ms: number): () => void;
}

const REAL_CLOCK: OnClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(handle);
  },
};

/** Run the trigger window. The caller is responsible for the outer
 *  `withDeadline` wrap (anti-wedge). The trigger source must be wired by the
 *  caller (the server handler binds it to the live `Page` / `CDPSession`). */
export async function runScreenshotOn(
  snap: SnapFn,
  source: TriggerSource,
  args: ScreenshotOnArgs,
  workspaceRoot: string,
  clock: OnClock = REAL_CLOCK,
): Promise<ScreenshotOnResult> {
  validateOnArgs(args);

  // Resolve + create the target dir under $BROWX_WORKSPACE.
  // `resolveWorkspacePath` rejects path escapes before any byte hits disk.
  const resolvedDir = resolveWorkspacePath(workspaceRoot, args.intoDir, "screenshot_on");
  mkdirSync(resolvedDir, { recursive: true });

  const fmt: "png" | "jpeg" = args.format ?? "png";
  const ext = fmt === "jpeg" ? "jpg" : "png";

  const paths: string[] = [];
  const capturedAt: number[] = [];
  const warnings: string[] = [];

  const tStart = clock.now();
  let i = 0;
  let capHit = false;
  // Serialise captures — if a trigger fires while a previous snap is still in
  // flight (e.g. console-error storm), drop the extra fire. Cheaper than
  // queueing N writes that all converge on the same UI state.
  let snapping = false;

  // Resolver for the window's natural end. The trigger source can also push
  // us to early-finish when the per-window cap is hit.
  let resolveWindow: () => void = () => undefined;
  const windowDone = new Promise<void>((r) => {
    resolveWindow = r;
  });

  const cancelTimer = clock.setTimeout(() => resolveWindow(), args.durationMs);

  const onFire = (): void => {
    if (capHit) return;
    if (snapping) {
      // Drop the in-flight overlap — a single screenshot per visible state is
      // the useful unit; we don't want N nearly-identical PNGs for a sub-ms
      // event burst.
      return;
    }
    if (paths.length >= MAX_TRIGGERS_PER_WINDOW) {
      capHit = true;
      warnings.push(
        `reached MAX_TRIGGERS_PER_WINDOW=${MAX_TRIGGERS_PER_WINDOW} for trigger "${args.trigger}"; window stopped early`,
      );
      cancelTimer();
      resolveWindow();
      return;
    }
    snapping = true;
    const t = clock.now();
    // Fire-and-forget — the trigger source is event-emitter shaped; we can't
    // await inside the handler. Errors are caught and surfaced as warnings.
    snap()
      .then((buf) => {
        const ts = t - tStart;
        const idx = i++;
        const name = `${String(idx).padStart(4, "0")}-${ts}.${ext}`;
        // $BROWX_WORKSPACE-rooted by construction (resolveWorkspacePath above).
        const p = join(resolvedDir, name);
        writeFileSync(p, buf);
        paths.push(p);
        capturedAt.push(ts);
      })
      .catch((err) => {
        warnings.push(
          `capture on "${args.trigger}" at +${clock.now() - tStart}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        snapping = false;
      });
  };

  const dispose = source.subscribe(args.trigger, onFire);
  try {
    await windowDone;
  } finally {
    dispose();
    cancelTimer();
  }

  // A snap may still be in flight when the timer fires — drain briefly so the
  // final capture lands on the result. Bounded so a wedged snap can't extend
  // the window indefinitely; the outer `withDeadline` is the ultimate ceiling.
  const drainDeadline = clock.now() + 250;
  while (snapping && clock.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (snapping) {
    warnings.push(
      `screenshot_on: final capture did not settle within 250ms drain window — result may omit one frame`,
    );
  }

  return {
    intoDir: resolvePath(resolvedDir),
    trigger: args.trigger,
    capturedAt,
    paths,
    warnings,
  };
}

/** Default `intoDir` shape — `screenshots/<sessionId>-<isoTs>/`. Same shape
 *  `screenshot_schedule` uses; the MCP handler joins it against
 *  `$BROWX_WORKSPACE` via `resolveWorkspacePath`. */
export function defaultOnDir(sessionId: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `screenshots/${sessionId}-${ts}`;
}
