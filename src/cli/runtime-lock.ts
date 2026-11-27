// `browxai runtime`: one update at a time. `<runtime>/lock` holds the pid and
// start time of the run that owns it, created with O_EXCL so two runs can't both
// take it. A lock whose pid is gone, or that is older than an hour, is stale: a
// killed run never stops updates for good.

import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import type { RuntimePaths } from "./runtime-layout.js";

export const LOCK_MAX_AGE_MS = 60 * 60 * 1000;

export interface LockDeps {
  now?: () => number;
  pid?: number;
  /** Whether a process with this pid is alive. */
  alive?: (pid: number) => boolean;
}

export type LockResult =
  { ok: true; release: () => void } | { ok: false; pid: number; startedAt: string };

interface LockFile {
  pid: number;
  startedAt: string;
}

function readLock(path: string): LockFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockFile>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "string") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
  } catch {
    /* missing, or torn by a run killed while writing it */
  }
  return undefined;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether the lock another run left is past its use. A lock that can't be read
 *  counts as stale, since its writer died before finishing it. */
export function isStale(lock: LockFile | undefined, deps: Required<LockDeps>): boolean {
  if (!lock) return true;
  const started = Date.parse(lock.startedAt);
  if (Number.isNaN(started) || deps.now() - started > LOCK_MAX_AGE_MS) return true;
  return lock.pid !== deps.pid && !deps.alive(lock.pid);
}

function create(path: string, body: LockFile): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(body) + "\n");
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Take the lock, replacing a stale one once. */
export function acquireLock(paths: RuntimePaths, deps: LockDeps = {}): LockResult {
  const d: Required<LockDeps> = {
    now: deps.now ?? Date.now,
    pid: deps.pid ?? process.pid,
    alive: deps.alive ?? pidAlive,
  };
  const body = { pid: d.pid, startedAt: new Date(d.now()).toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (create(paths.lock, body)) {
      return {
        ok: true,
        release: () => {
          if (readLock(paths.lock)?.pid === d.pid) rmSync(paths.lock, { force: true });
        },
      };
    }
    const held = readLock(paths.lock);
    if (!isStale(held, d)) return { ok: false, pid: held!.pid, startedAt: held!.startedAt };
    rmSync(paths.lock, { force: true });
  }
  const held = readLock(paths.lock);
  return { ok: false, pid: held?.pid ?? 0, startedAt: held?.startedAt ?? "" };
}
