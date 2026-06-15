// `screenshot_schedule` — periodic screenshot captures at a fixed interval,
// stopped by a hard count or a wall-clock duration. Sibling of
// `screenshot_on` (event-driven). The controller itself is browser-agnostic:
// the *snap* function is injected, so the policy (cadence + stop) and the
// path-write side stay independently unit-testable.
//
// Anti-wedge: every call is bounded — either `count` OR `durationMs` must be
// supplied (mutually exclusive), so an unbounded interval-fire-forever loop
// can't exist. The outer MCP handler additionally wraps the controller in
// `withDeadline` against the action-timeout so the call returns even if a
// single `snap` wedges. Capability `file-io` (the bytes hit disk).

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { resolveWorkspacePath } from "../session/storage.js";

export const MIN_INTERVAL_MS = 100;
export const MAX_INTERVAL_MS = 60_000;
/** Hard cap on captures-per-call. The schedule is already bounded by
 *  count/durationMs; this is a belt-and-braces ceiling so a 100ms cadence over
 *  the 1h action-timeout ceiling can't blow up disk space in one call. */
export const MAX_CAPTURES_PER_CALL = 1000;

export interface ScheduleArgs {
  everyMs: number;
  /** Mutually exclusive with `durationMs`. */
  count?: number;
  /** Mutually exclusive with `count`. */
  durationMs?: number;
  /** Destination directory (workspace-rooted). Defaulted by the server
   *  handler before this layer ever sees it (so the controller's contract
   *  stays "give me a resolved dir"). */
  intoDir: string;
  /** Image format — `"png"` (default) or `"jpeg"`. Recorded in each file's
   *  extension so the caller can spot the format from the dir alone. */
  format?: "png" | "jpeg";
}

export interface ScheduleResult {
  intoDir: string;
  count: number;
  capturedAt: number[];
  paths: string[];
  warnings: string[];
}

/** Validate the shape; throw early so the MCP handler can return a structured
 *  error before any disk write. */
export function validateScheduleArgs(args: ScheduleArgs): void {
  if (
    !Number.isFinite(args.everyMs) ||
    args.everyMs < MIN_INTERVAL_MS ||
    args.everyMs > MAX_INTERVAL_MS
  ) {
    throw new Error(
      `screenshot_schedule: \`everyMs\` must be in [${MIN_INTERVAL_MS}, ${MAX_INTERVAL_MS}] — got ${args.everyMs}`,
    );
  }
  const hasCount = typeof args.count === "number";
  const hasDuration = typeof args.durationMs === "number";
  if (hasCount && hasDuration) {
    throw new Error(
      `screenshot_schedule: \`count\` and \`durationMs\` are mutually exclusive — pass exactly one`,
    );
  }
  if (!hasCount && !hasDuration) {
    throw new Error(
      `screenshot_schedule: pass either \`count\` (N captures) or \`durationMs\` (window length, ms) — unbounded schedules are refused`,
    );
  }
  if (
    hasCount &&
    (!Number.isInteger(args.count) ||
      (args.count as number) < 1 ||
      (args.count as number) > MAX_CAPTURES_PER_CALL)
  ) {
    throw new Error(
      `screenshot_schedule: \`count\` must be an integer in [1, ${MAX_CAPTURES_PER_CALL}] — got ${args.count}`,
    );
  }
  if (
    hasDuration &&
    (!Number.isFinite(args.durationMs) || (args.durationMs as number) < args.everyMs)
  ) {
    throw new Error(
      `screenshot_schedule: \`durationMs\` must be >= \`everyMs\` — got durationMs=${args.durationMs}, everyMs=${args.everyMs}`,
    );
  }
}

/** Inject a `snap()` for tests; the real wiring passes a closure over
 *  Playwright's `page.screenshot()`. Returns the encoded bytes. */
export type SnapFn = () => Promise<Buffer>;

/** Injectable timing seam (real impl uses `setTimeout` + `Date.now`). */
export interface ScheduleClock {
  now(): number;
  /** Sleep for `ms`. Returns when the timer fires; never rejects. */
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: ScheduleClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};

/** Run the schedule. The caller is responsible for the outer `withDeadline`
 *  wrap (anti-wedge), and supplies `workspaceRoot` so `intoDir` resolves
 *  inside `$BROWX_WORKSPACE`. */
/** Attempt one capture; on failure surface a warning and return null (a single
 *  transient hiccup shouldn't poison the whole window). */
async function tryCapture(snap: SnapFn, i: number, warnings: string[]): Promise<Buffer | null> {
  try {
    return await snap();
  } catch (err) {
    warnings.push(`capture ${i}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Sleep until the next scheduled tick (drift-tolerant: anchored to the capture
 *  start, so a slow snap still fires the next tick on-cadence). Returns true when
 *  the window has ended (caller should break). */
async function cadenceSleep(
  clock: ScheduleClock,
  captureStart: number,
  everyMs: number,
  hasCount: boolean,
  windowEndMs: number,
): Promise<boolean> {
  const sleepMs = Math.max(0, captureStart + everyMs - clock.now());
  if (!hasCount && clock.now() + sleepMs >= windowEndMs) {
    await clock.sleep(Math.max(0, windowEndMs - clock.now()));
    return true;
  }
  await clock.sleep(sleepMs);
  return false;
}

export async function runSchedule(
  snap: SnapFn,
  args: ScheduleArgs,
  workspaceRoot: string,
  clock: ScheduleClock = REAL_CLOCK,
): Promise<ScheduleResult> {
  validateScheduleArgs(args);

  // Resolve + create the target dir under $BROWX_WORKSPACE. `resolveWorkspacePath`
  // rejects path-escape attempts before any byte hits disk (same chokepoint as
  // `screenshot({path})`).
  const resolvedDir = resolveWorkspacePath(workspaceRoot, args.intoDir, "screenshot_schedule");
  mkdirSync(resolvedDir, { recursive: true });

  const fmt: "png" | "jpeg" = args.format ?? "png";
  const ext = fmt === "jpeg" ? "jpg" : "png";

  const paths: string[] = [];
  const capturedAt: number[] = [];
  const warnings: string[] = [];

  const tStart = clock.now();
  const hasCount = typeof args.count === "number";
  const targetCount = hasCount ? (args.count as number) : MAX_CAPTURES_PER_CALL;
  const windowEndMs = hasCount ? Number.POSITIVE_INFINITY : tStart + (args.durationMs as number);

  let i = 0;
  while (i < targetCount && clock.now() < windowEndMs) {
    // Belt-and-braces ceiling — independent of count/duration. Ensures a
    // 100ms-cadence over the 1h action-timeout ceiling can't blow up disk space.
    if (paths.length >= MAX_CAPTURES_PER_CALL) {
      warnings.push(`reached MAX_CAPTURES_PER_CALL=${MAX_CAPTURES_PER_CALL}; schedule stopped early`);
      break;
    }
    const t = clock.now();
    const buf = await tryCapture(snap, i, warnings);
    if (buf === null) {
      i++;
      // Honour the cadence even on a failed capture.
      if (i < targetCount && clock.now() < windowEndMs) await clock.sleep(Math.max(0, args.everyMs));
      continue;
    }
    const ts = clock.now() - tStart;
    // `p` inherits its $BROWX_WORKSPACE-rooted dir from `resolvedDir`.
    const p = join(resolvedDir, `${String(i).padStart(4, "0")}-${ts}.${ext}`);
    writeFileSync(p, buf);
    paths.push(p);
    capturedAt.push(ts);
    i++;
    if (i >= targetCount) break;
    if (await cadenceSleep(clock, t, args.everyMs, hasCount, windowEndMs)) break;
  }

  return {
    intoDir: resolvePath(resolvedDir),
    count: paths.length,
    capturedAt,
    paths,
    warnings,
  };
}

/** Default `intoDir` shape — `screenshots/<sessionId>-<isoTs>/`. The MCP
 *  handler joins this against `$BROWX_WORKSPACE` via `resolveWorkspacePath`,
 *  same as a user-supplied path. ISO timestamp uses `:` / `.` → `-` so the
 *  path is filesystem-friendly on every platform. */
export function defaultScheduleDir(sessionId: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `screenshots/${sessionId}-${ts}`;
}

/** Shared dir-creation helper — re-used by `screenshot_on`. Rooted inside
 *  $BROWX_WORKSPACE (path escape is rejected by `resolveWorkspacePath`). */
export function ensureWorkspaceDir(workspaceRoot: string, intoDir: string, tool: string): string {
  const resolved = resolveWorkspacePath(workspaceRoot, intoDir, tool);
  // $BROWX_WORKSPACE-rooted by construction (resolveWorkspacePath above).
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Stat helper used by the result envelope — best-effort byte count per file. */
export function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
