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
/** Mutable state for an in-flight screenshot_on window, threaded through the
 *  fire handler. */
interface OnWindowState {
  paths: string[];
  capturedAt: number[];
  warnings: string[];
  i: number;
  capHit: boolean;
  snapping: boolean;
  tStart: number;
  resolvedDir: string;
  ext: string;
  snap: SnapFn;
  clock: OnClock;
  trigger: string;
  /** End the window early (cancel timer + resolve). */
  endWindow: () => void;
}

/** Trigger handler: capture one frame per visible state. Drops overlapping fires
 *  (a single screenshot per state is the useful unit), ends the window on the
 *  per-window cap, else fires a fire-and-forget snap that writes the PNG. */
function onScreenshotFire(st: OnWindowState): void {
  if (st.capHit || st.snapping) return;
  if (st.paths.length >= MAX_TRIGGERS_PER_WINDOW) {
    st.capHit = true;
    st.warnings.push(
      `reached MAX_TRIGGERS_PER_WINDOW=${MAX_TRIGGERS_PER_WINDOW} for trigger "${st.trigger}"; window stopped early`,
    );
    st.endWindow();
    return;
  }
  st.snapping = true;
  const t = st.clock.now();
  st.snap()
    .then((buf) => {
      const ts = t - st.tStart;
      const name = `${String(st.i++).padStart(4, "0")}-${ts}.${st.ext}`;
      // $BROWX_WORKSPACE-rooted by construction (resolveWorkspacePath in caller).
      const p = join(st.resolvedDir, name);
      writeFileSync(p, buf);
      st.paths.push(p);
      st.capturedAt.push(ts);
    })
    .catch((err) => {
      st.warnings.push(
        `capture on "${st.trigger}" at +${st.clock.now() - st.tStart}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      st.snapping = false;
    });
}

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

  // Resolver for the window's natural end. The trigger source can also push us
  // to early-finish when the per-window cap is hit.
  let resolveWindow: () => void = () => undefined;
  const windowDone = new Promise<void>((r) => {
    resolveWindow = r;
  });
  const cancelTimer = clock.setTimeout(() => resolveWindow(), args.durationMs);

  const st: OnWindowState = {
    paths,
    capturedAt,
    warnings,
    i: 0,
    capHit: false,
    snapping: false,
    tStart: clock.now(),
    resolvedDir,
    ext,
    snap,
    clock,
    trigger: args.trigger,
    endWindow: () => {
      cancelTimer();
      resolveWindow();
    },
  };

  const dispose = source.subscribe(args.trigger, () => onScreenshotFire(st));
  try {
    await windowDone;
  } finally {
    dispose();
    cancelTimer();
  }

  // A snap may still be in flight when the timer fires — drain briefly so the
  // final capture lands. Bounded so a wedged snap can't extend the window; the
  // outer `withDeadline` is the ultimate ceiling.
  const drainDeadline = clock.now() + 250;
  while (st.snapping && clock.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (st.snapping) {
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
