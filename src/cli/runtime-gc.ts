// `browxai runtime gc`: keep three versions (`current`, the previous one and one
// more) and remove older ones that no running process uses. A process counts as
// using a version when `<runtime>/versions/<v>/` is in its command line, which holds
// for every server the launcher started: its `exec` puts the resolved `cli.js` path
// in node's argv. When the process list can't be read, nothing is removed.

import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isVersion, versionDir, type RuntimePaths } from "./runtime-layout.js";
import type { Runner } from "./runtime-exec.js";
import { listVersions, readCurrent, type RuntimeState } from "./runtime-store.js";

/** How many versions gc keeps: current, previous and one more. */
export const KEEP_VERSIONS = 3;

/** A staging directory whose process is gone is removed after this long. */
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

export interface ProcessInfo {
  pid: number;
  command: string;
}

/** Lists running processes with their command lines; undefined when it can't. */
export type ProcessLister = () => Promise<ProcessInfo[] | undefined>;

/** `/proc/<pid>/cmdline` on Linux, `ps` elsewhere. */
export function systemProcessLister(
  run: Runner,
  platform: NodeJS.Platform = process.platform,
): ProcessLister {
  if (platform === "linux" && existsSync("/proc/self/cmdline")) {
    return () => Promise.resolve(readProc("/proc"));
  }
  return async () => {
    const r = await run("ps", ["-A", "-o", "pid=", "-o", "args="], { timeoutMs: 10_000 });
    if (r.status !== 0) return undefined;
    return parsePs(r.stdout);
  };
}

export function parsePs(stdout: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), command: m[2]! });
  }
  return out;
}

function readProc(dir: string): ProcessInfo[] | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const out: ProcessInfo[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const raw = readFileSync(join(dir, name, "cmdline"), "utf8");
      if (raw)
        out.push({ pid: Number(name), command: raw.replace(/\0+$/, "").replace(/\0/g, " ") });
    } catch {
      /* the process ended, or belongs to someone we can't read */
    }
  }
  return out;
}

/** The pids using each kept version, or undefined when the process list can't be read. */
export async function versionsInUse(
  paths: RuntimePaths,
  list: ProcessLister,
): Promise<Map<string, number[]> | undefined> {
  const processes = await list();
  if (!processes) return undefined;
  const roots = new Set([paths.root]);
  try {
    roots.add(realpathSync(paths.root));
  } catch {
    /* no runtime directory yet */
  }
  const prefixes = [...roots].map((r) => join(r, "versions") + "/");
  const use = new Map<string, number[]>();
  for (const p of processes) {
    if (p.pid === process.pid) continue;
    for (const v of versionsNamedIn(p.command, prefixes)) {
      use.set(v, [...(use.get(v) ?? []), p.pid]);
    }
  }
  return use;
}

function versionsNamedIn(command: string, prefixes: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const prefix of prefixes) {
    let at = command.indexOf(prefix);
    while (at >= 0) {
      const rest = command.slice(at + prefix.length);
      const v = rest.slice(0, rest.indexOf("/") < 0 ? rest.length : rest.indexOf("/"));
      if (isVersion(v)) found.add(v);
      at = command.indexOf(prefix, at + 1);
    }
  }
  return found;
}

/** The versions gc keeps: current, previous, then the newest others up to three. */
export function versionsToKeep(
  versions: readonly string[],
  current?: string,
  previous?: string,
): Set<string> {
  const keep = new Set([current, previous].filter((v): v is string => !!v && versions.includes(v)));
  for (const v of versions) {
    if (keep.size >= KEEP_VERSIONS) break;
    keep.add(v);
  }
  return keep;
}

export interface GcResult {
  removed: string[];
  inUse: Array<{ version: string; pids: number[] }>;
  kept: string[];
  stagingRemoved: string[];
  /** True when the process list couldn't be read, so no version was removed. */
  unknown: boolean;
}

export interface GcDeps {
  list: ProcessLister;
  now?: () => number;
  /** Whether a process with this pid is alive. */
  alive?: (pid: number) => boolean;
}

export async function collectGarbage(
  paths: RuntimePaths,
  state: RuntimeState,
  deps: GcDeps,
): Promise<GcResult> {
  const versions = listVersions(paths);
  const keep = versionsToKeep(versions, readCurrent(paths), state.previous);
  const result: GcResult = {
    removed: [],
    inUse: [],
    kept: [...keep],
    stagingRemoved: [],
    unknown: false,
  };
  const candidates = versions.filter((v) => !keep.has(v));
  if (candidates.length > 0) {
    const use = await versionsInUse(paths, deps.list);
    if (!use) result.unknown = true;
    for (const v of use ? candidates : []) {
      const pids = use!.get(v);
      if (pids) result.inUse.push({ version: v, pids });
      else {
        removeVersion(paths, v);
        result.removed.push(v);
      }
    }
  }
  result.stagingRemoved = sweepStaging(paths, deps.now?.() ?? Date.now(), deps.alive ?? isAlive);
  return result;
}

/** Move the version out of `versions/` in one rename, then delete it, so a
 *  half-deleted tree is never listed as a kept version. */
function removeVersion(paths: RuntimePaths, version: string): void {
  const trash = join(paths.staging, `gc-${version}-${process.pid}`);
  rmSync(trash, { recursive: true, force: true });
  renameSync(versionDir(paths, version), trash);
  rmSync(trash, { recursive: true, force: true });
}

/** Remove staging directories older than an hour whose process is gone. Their
 *  names end in `-<pid>`. */
function sweepStaging(paths: RuntimePaths, now: number, alive: (pid: number) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(paths.staging);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const full = join(paths.staging, name);
    const pid = Number(/-(\d+)$/.exec(name)?.[1] ?? NaN);
    if (Number.isFinite(pid) && alive(pid)) continue;
    let age: number;
    try {
      age = now - statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (age < STAGING_MAX_AGE_MS) continue;
    rmSync(full, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function renderGc(r: GcResult): string {
  const lines = [`kept: ${r.kept.join(", ") || "none"}`];
  if (r.removed.length) lines.push(`removed: ${r.removed.join(", ")}`);
  for (const u of r.inUse) lines.push(`kept ${u.version}: in use by pid ${u.pids.join(", ")}`);
  if (r.stagingRemoved.length) lines.push(`removed from staging: ${r.stagingRemoved.join(", ")}`);
  if (r.unknown) lines.push("the process list could not be read, so no version was removed");
  return lines.join("\n") + "\n";
}
