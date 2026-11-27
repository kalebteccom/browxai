// `browxai serve` under a runtime: drain onto a new version when idle (RFC 0015,
// D11). A daemon the launcher started (`BROWX_RUNTIME_DIR` set) reads `current`
// every 5 minutes, a local symlink read with no network. Once `current` names
// another version and the daemon has had no socket client and no open session
// for 15 minutes, it logs one line and exits 75 (EX_TEMPFAIL). A launchd job
// with `KeepAlive` and `SuccessfulExit` false, or a systemd unit with
// `Restart=on-failure`, starts it again through the launcher on the new
// version, and a connected bridge reconnects.
//
// `BROWX_RUNTIME_DAEMON_RESTART` is `idle` (the default under a runtime) or
// `off`. Any other value leaves the daemon running, with a warning.

import { isAbsolute } from "node:path";
import { isVersion, runtimePaths } from "./runtime-layout.js";
import { readCurrent } from "./runtime-store.js";

/** EX_TEMPFAIL: the job manager restarts a daemon that exits with it. */
export const DRAIN_EXIT_CODE = 75;
export const DRAIN_CHECK_MS = 5 * 60_000;
export const DRAIN_IDLE_MS = 15 * 60_000;

export type DrainSetting =
  { on: true; root: string; version: string } | { on: false; warning?: string };

/** Whether this daemon drains, from the variables the launcher sets. */
export function drainSetting(env: NodeJS.ProcessEnv, ownVersion: string): DrainSetting {
  const root = env.BROWX_RUNTIME_DIR?.trim();
  if (!root || !isAbsolute(root)) return { on: false };
  const mode = env.BROWX_RUNTIME_DAEMON_RESTART?.trim() || "idle";
  if (mode === "off") return { on: false };
  if (mode !== "idle") {
    return {
      on: false,
      warning: `BROWX_RUNTIME_DAEMON_RESTART=${mode} is not idle or off, so this daemon keeps running when the runtime switches versions`,
    };
  }
  const fromEnv = env.BROWX_RUNTIME_VERSION?.trim();
  const version = fromEnv && isVersion(fromEnv) ? fromEnv : ownVersion;
  return { on: true, root, version };
}

/** A clock a test can drive: `every` runs `fn` each `ms` until cancelled. */
export interface DrainClock {
  now: () => number;
  every: (ms: number, fn: () => void) => () => void;
}

export const systemDrainClock: DrainClock = {
  now: Date.now,
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    // The drain check never keeps a process alive on its own.
    t.unref();
    return () => clearInterval(t);
  },
};

export interface DrainDeps {
  root: string;
  /** The version this daemon runs. */
  version: string;
  connections: () => number;
  sessions: () => number;
  clock: DrainClock;
  log: (line: string) => void;
  /** Called once, with the exit code, when the daemon should exit. */
  onDrain: (code: number) => void;
}

export interface Drain {
  /** A client connected or disconnected: the idle time starts again. */
  activity: () => void;
  /** One check, as the 5-minute timer runs it. */
  check: () => void;
  stop: () => void;
}

export function startDrain(deps: DrainDeps): Drain {
  const paths = runtimePaths(deps.root);
  let lastBusy = deps.clock.now();
  let done = false;
  const check = (): void => {
    if (done) return;
    const now = deps.clock.now();
    if (deps.connections() > 0 || deps.sessions() > 0) {
      lastBusy = now;
      return;
    }
    const current = readCurrent(paths);
    if (!current || current === deps.version) return;
    if (now - lastBusy < DRAIN_IDLE_MS) return;
    done = true;
    cancel();
    deps.log(
      `browxai serve: current is ${current} and this daemon runs ${deps.version}. ` +
        `It had no client and no session for ${DRAIN_IDLE_MS / 60_000} minutes, so it exits with ${DRAIN_EXIT_CODE} for its job to start ${current}.`,
    );
    deps.onDrain(DRAIN_EXIT_CODE);
  };
  const cancel = deps.clock.every(DRAIN_CHECK_MS, check);
  return {
    activity: () => {
      lastBusy = deps.clock.now();
    },
    check,
    stop: () => {
      done = true;
      cancel();
    },
  };
}
