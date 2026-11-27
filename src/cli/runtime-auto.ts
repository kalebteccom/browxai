// `browxai runtime update --auto`: what the background job runs every hour. It
// takes the lock, returns at once when no check is due, contacts the registry,
// and applies the channel's version through the same stage, verify, smoke-check
// and switch steps as a manual update, within the limits of runtime-schedule.ts.
// Every check and apply writes one journal line. A failed registry contact backs
// off and leaves `current` alone. Under `--auto` every outcome but an internal
// error exits 0, so the job never looks broken because the machine is offline.

import { readFileSync } from "node:fs";
import { applyVersion } from "./runtime-apply.js";
import type { Runner } from "./runtime-exec.js";
import { collectGarbage } from "./runtime-gc.js";
import { enginesCheck, guardReason } from "./runtime-guards.js";
import { npmContext, type FlowDeps, type FlowIo } from "./runtime-install.js";
import { appendJournal, type JournalEntry } from "./runtime-journal.js";
import { compareVersions, type RuntimePaths } from "./runtime-layout.js";
import { acquireLock } from "./runtime-lock.js";
import { recordNotes } from "./runtime-notes.js";
import { npmRegistry, type NpmContext, type VersionInfo } from "./runtime-npm.js";
import {
  bootDelayUntil,
  contactGate,
  decideAuto,
  lastDay,
  nextBackoffMs,
  nextCheckAfter,
  SCHEDULE,
  type Random,
} from "./runtime-schedule.js";
import {
  readSettingsFile,
  resolveAutoUpdate,
  resolveChannel,
  resolveCooldown,
  resolveMajorPolicy,
} from "./runtime-settings.js";
import { writeShim } from "./runtime-shim.js";
import {
  readCurrent,
  readState,
  syncPreviousVersion,
  updateState,
  type RuntimeState,
} from "./runtime-store.js";

/** The clock, random source and boot time the job reads. Tests pass fakes. */
export interface AutoClock {
  now: () => number;
  random: Random;
  /** The machine's boot time in ms since the epoch, or undefined when unknown. */
  bootTime: () => Promise<number | undefined>;
}

/** Two boot times this close are the same boot: Linux derives `btime` from the
 *  clock and uptime, so it can move by a second. */
const SAME_BOOT_MS = 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

export async function autoUpdateFlow(
  paths: RuntimePaths,
  opts: { skipDelay: boolean },
  deps: FlowDeps & { clock: AutoClock },
  io: FlowIo,
): Promise<number> {
  const now = deps.clock.now();
  const { file, error } = readSettingsFile(paths);
  const auto = resolveAutoUpdate(deps.env, file, error);
  if (auto.warning) io.err(`warning: ${auto.warning}\n`);
  const lock = acquireLock(paths, { now: deps.clock.now });
  if (!lock.ok) {
    io.out(`another update run (pid ${lock.pid}) holds ${paths.lock}. Nothing to do.\n`);
    return 0;
  }
  try {
    if (!auto.on) return off(paths, `auto-update off (${auto.source})`, now, io);
    writeShim(paths);
    // The launcher reads `previous-version` for its fallback; a runtime switched
    // by an older browxai has none yet.
    syncPreviousVersion(paths, readState(paths).previous);
    return await autoRun(paths, opts, deps, io);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    journal(paths, now, { event: "error", reason });
    updateState(paths, (s) => ({ ...s, lastResult: `error: ${reason}` }));
    io.err(`browxai runtime: ${reason}\n`);
    return 1;
  } finally {
    lock.release();
  }
}

/** Auto-update is off: say so once in the journal, not on every hourly wake. */
function off(paths: RuntimePaths, result: string, now: number, io: FlowIo): number {
  const state = readState(paths);
  if (state.lastResult !== result) {
    journal(paths, now, { event: "skip", result });
    updateState(paths, (s) => ({ ...s, lastResult: result }));
  }
  io.out(`${result}. Nothing to do.\n`);
  return 0;
}

function journal(paths: RuntimePaths, now: number, entry: Omit<JournalEntry, "at" | "mode">): void {
  appendJournal(paths, { at: iso(now), mode: "auto", ...entry });
}

/** After the first run that follows a boot, the next contact waits 10 to 30 minutes. */
async function afterBoot(
  paths: RuntimePaths,
  clock: AutoClock,
  now: number,
): Promise<RuntimeState> {
  const boot = await clock.bootTime().catch(() => undefined);
  const state = readState(paths);
  if (boot === undefined) return state;
  if (state.bootSeen !== undefined && Math.abs(boot - state.bootSeen) < SAME_BOOT_MS) return state;
  const delay = bootDelayUntil(now, clock.random);
  const next =
    state.nextCheck && Date.parse(state.nextCheck) > Date.parse(delay) ? state.nextCheck : delay;
  return updateState(paths, (s) => ({ ...s, bootSeen: boot, nextCheck: next }));
}

async function autoRun(
  paths: RuntimePaths,
  opts: { skipDelay: boolean },
  deps: FlowDeps & { clock: AutoClock },
  io: FlowIo,
): Promise<number> {
  const now = deps.clock.now();
  const state = await afterBoot(paths, deps.clock, now);
  const gate = contactGate(state, now);
  if (!gate.go) {
    if (gate.quiet) return 0;
    updateState(paths, (s) => ({ ...s, nextCheck: gate.nextCheck, lastResult: gate.reason }));
    journal(paths, now, { event: "skip", result: gate.reason });
    io.out(`${gate.reason}. Next check after ${gate.nextCheck}.\n`);
    return 0;
  }
  const { file } = readSettingsFile(paths);
  const channel = resolveChannel(deps.env, file);
  if (!channel.ok) throw new Error(channel.error);
  const npm = npmContext(paths, deps);
  if ("error" in npm) throw new Error(npm.error);
  updateState(paths, (s) => ({ ...s, contacts: [...lastDay(s.contacts, now), iso(now)] }));
  const viewed = await (deps.registry ?? npmRegistry)(npm).view(channel.value);
  if (!viewed.ok) return backoff(paths, now, viewed.unreachable, viewed.message, io);
  updateState(paths, (s) => {
    const next: RuntimeState = {
      ...s,
      lastCheck: iso(now),
      nextCheck: nextCheckAfter(now, deps.clock.random),
    };
    delete next.backoffUntil;
    delete next.backoffMs;
    return next;
  });
  const cooldown = resolveCooldown(file);
  if (cooldown.warning) io.err(`warning: ${cooldown.warning}\n`);
  const major = resolveMajorPolicy(file);
  if (major.warning) io.err(`warning: ${major.warning}\n`);
  return decideAndApply(
    paths,
    viewed.info,
    { now, skipDelay: opts.skipDelay, hours: cooldown.hours, allowMajor: major.allow, npm },
    deps,
    io,
  );
}

function backoff(
  paths: RuntimePaths,
  now: number,
  unreachable: boolean,
  message: string,
  io: FlowIo,
): number {
  const s = updateState(paths, (st) => {
    const ms = nextBackoffMs(st.backoffMs);
    return {
      ...st,
      backoffMs: ms,
      backoffUntil: iso(now + ms),
      lastResult: unreachable ? "offline" : `registry error: ${message}`,
    };
  });
  journal(paths, now, {
    event: unreachable ? "offline" : "error",
    reason: message,
    result: `next contact after ${s.backoffUntil}`,
  });
  io.out(`${message}. current is unchanged. Next contact after ${s.backoffUntil}.\n`);
  return 0;
}

/** A newer version the major guard or the Node engines hold keeps back. */
async function guardFor(
  info: VersionInfo,
  current: string | undefined,
  allowMajor: boolean,
  npm: NpmContext,
): Promise<string | undefined> {
  if (!current || compareVersions(info.version, current) <= 0 || info.deprecated) return undefined;
  return guardReason(info, current, allowMajor, enginesCheck(npm));
}

async function decideAndApply(
  paths: RuntimePaths,
  info: VersionInfo,
  at: { now: number; skipDelay: boolean; hours: number; allowMajor: boolean; npm: NpmContext },
  deps: FlowDeps & { clock: AutoClock },
  io: FlowIo,
): Promise<number> {
  const current = readCurrent(paths);
  const guard = await guardFor(info, current, at.allowMajor, at.npm);
  const decision = decideAuto({
    candidate: info,
    current,
    state: readState(paths),
    now: at.now,
    cooldownHours: at.hours,
    skipDelay: at.skipDelay,
    compare: compareVersions,
    ...(guard ? { guard } : {}),
  });
  if (decision.kind !== "apply") {
    updateState(paths, (s) => {
      const next: RuntimeState = { ...s, lastResult: decision.result };
      if (decision.kind === "pending") next.pending = decision.pending;
      else delete next.pending;
      if (decision.kind === "none" && decision.currentDeprecated)
        next.currentDeprecated = decision.currentDeprecated;
      else delete next.currentDeprecated;
      return next;
    });
    journal(paths, at.now, { event: "check", version: info.version, result: decision.result });
    io.out(`${decision.result}.\n`);
    return 0;
  }
  return apply(paths, info, current, at.now, deps, io);
}

async function apply(
  paths: RuntimePaths,
  info: VersionInfo,
  current: string | undefined,
  now: number,
  deps: FlowDeps & { clock: AutoClock },
  io: FlowIo,
): Promise<number> {
  const v = info.version;
  const npm = npmContext(paths, deps);
  if ("error" in npm) throw new Error(npm.error);
  updateState(paths, (s) => ({ ...s, applies: [...lastDay(s.applies, now), iso(now)] }));
  io.out(`browxai runtime: applying ${v}\n`);
  const applied = await applyVersion(paths, info, {
    registry: (deps.registry ?? npmRegistry)(npm),
    npm,
    ...(deps.verify ? { verify: deps.verify } : {}),
    ...(deps.smoke ? { smoke: deps.smoke } : {}),
    out: io.out,
  });
  const ms = deps.clock.now() - now;
  if (!applied.ok) {
    const s = updateState(paths, (st) => failedApply(st, v, applied.reason));
    journal(paths, now, {
      event: "apply",
      version: v,
      result: applied.held ? "held" : "failed",
      reason: applied.reason,
      ms,
    });
    io.out(`✗ ${v} was not applied: ${applied.reason}. current is ${current ?? "not set"}.\n`);
    if (s.pending?.state === "held") io.out(`  ${v} is held: ${s.pending.reason}.\n`);
    return 0;
  }
  updateState(paths, (s) => {
    const next: RuntimeState = { ...s, lastResult: `applied ${v}` };
    delete next.pending;
    delete next.currentDeprecated;
    return next;
  });
  journal(paths, now, {
    event: "apply",
    version: v,
    ...(current ? { from: current } : {}),
    ...(info.integrity ? { integrity: info.integrity } : {}),
    result: "applied",
    ms,
  });
  io.out(`✓ current is ${v}${current ? `, was ${current}` : ""}.\n`);
  const notes = recordNotes(paths, applied.previous, v, now, "auto");
  if (notes.length) io.out(`  Upgrading notes for ${notes.join(", ")}: browxai runtime notes\n`);
  await collectGarbage(paths, readState(paths), { list: deps.list });
  return 0;
}

/** After a failed apply: hold the version after three failures, or for good
 *  when verification failed. Otherwise it is retried at the next check. */
function failedApply(state: RuntimeState, v: string, reason: string): RuntimeState {
  const failures = state.failed?.[v] ?? 0;
  let held = state.held?.[v];
  if (!held && failures >= SCHEDULE.failuresBeforeHold)
    held = `failed its checks ${failures} times`;
  return {
    ...state,
    ...(held ? { held: { ...state.held, [v]: held } } : {}),
    lastResult: `${v} failed: ${reason}`,
    pending: held
      ? { version: v, state: "held", reason: held }
      : { version: v, state: "failed", reason },
  };
}

/** The boot time: `sysctl -n kern.boottime` on macOS, `btime` in /proc/stat on Linux. */
export function systemBootTime(
  run: Runner,
  platform: NodeJS.Platform,
): () => Promise<number | undefined> {
  if (platform === "linux") {
    return () => {
      try {
        const m = /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
        return Promise.resolve(m ? Number(m[1]) * 1000 : undefined);
      } catch {
        return Promise.resolve(undefined);
      }
    };
  }
  if (platform === "darwin") {
    return async () => {
      const r = await run("/usr/sbin/sysctl", ["-n", "kern.boottime"], { timeoutMs: 5_000 });
      const m = /sec\s*=\s*(\d+)/.exec(r.stdout);
      return r.status === 0 && m ? Number(m[1]) * 1000 : undefined;
    };
  }
  return () => Promise.resolve(undefined);
}
