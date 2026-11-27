// `browxai runtime`: the files of a runtime directory. Every write goes to a new
// temp file or link first and is renamed into place, so a reader sees the old file
// or the new one, never half of either.
//
// `current` is a relative symlink to `versions/<v>`. A switch creates
// `current.tmp-<pid>` and renames it over `current` with rename(2), which replaces
// the link itself in one step. `ln -sfn` unlinks first, which leaves a moment with
// no `current`, and BSD `mv` would move the temp link into the directory `current`
// points at.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  LAYOUT_SCHEMA_VERSION,
  cliOf,
  compareVersions,
  isVersion,
  versionDir,
  type RuntimePaths,
} from "./runtime-layout.js";

/** Write `data` to `path` through a sibling temp file and a rename, with `mode`. */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // The umask can strip bits from the mode given to open; set it exactly.
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A directory with mode 0700, created when missing. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Create the directories and `layout.json` of a new runtime. Leaves an existing
 *  managed runtime as it is. */
export function createLayout(paths: RuntimePaths): void {
  ensurePrivateDir(paths.root);
  ensurePrivateDir(paths.versions);
  ensurePrivateDir(paths.staging);
  ensurePrivateDir(paths.bin);
  if (!existsSync(paths.layout)) {
    writeFileAtomic(paths.layout, JSON.stringify({ schemaVersion: LAYOUT_SCHEMA_VERSION }) + "\n");
  }
}

/** The version `current` names, or undefined when there is no `current` or it
 *  names something other than `versions/<version>`. */
export function readCurrent(paths: RuntimePaths): string | undefined {
  const target = readLinkSettled(paths.current);
  if (target === undefined) return undefined;
  const m = /^versions\/([^/]+)\/?$/.exec(target);
  return m && isVersion(m[1]!) ? m[1] : undefined;
}

/** `readlink`, tried up to three times: on APFS a lookup that races a switch of
 *  the link can fail with EINVAL. */
function readLinkSettled(path: string): string | undefined {
  for (let i = 0; i < 3; i++) {
    try {
      return readlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EINVAL") return undefined;
    }
  }
  return undefined;
}

/** The file-system steps of a switch a test can replace, to stop it half way. */
export interface SwitchIo {
  symlink?: (target: string, path: string) => void;
  rename?: (from: string, to: string) => void;
}

/** Point `current` at `versions/<version>` in one rename. On any failure the
 *  temp link is removed and `current` is what it was. */
export function switchCurrent(
  paths: RuntimePaths,
  version: string,
  io: SwitchIo = {},
  pid: number = process.pid,
): void {
  if (!isVersion(version)) throw new Error(`not a version: ${version}`);
  if (!existsSync(cliOf(versionDir(paths, version)))) {
    throw new Error(`${cliOf(versionDir(paths, version))} is missing`);
  }
  const tmp = join(paths.root, `current.tmp-${pid}`);
  rmSync(tmp, { force: true });
  try {
    (io.symlink ?? symlinkSync)(join("versions", version), tmp);
    (io.rename ?? renameSync)(tmp, paths.current);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The kept versions, newest first. Only directories named as a version count. */
export function listVersions(paths: RuntimePaths): string[] {
  let names: string[];
  try {
    names = readdirSync(paths.versions);
  } catch {
    return [];
  }
  return names.filter(isVersion).sort((a, b) => compareVersions(b, a));
}

/** What the runtime remembers between commands. */
export interface RuntimeState {
  /** The version `current` named before the last switch. */
  previous?: string;
  /** Failed applies per version. */
  failed?: Record<string, number>;
  /** Versions that are not applied again, with the reason. */
  held?: Record<string, string>;
}

/** `state.json`, or an empty state when it is missing or unreadable. */
export function readState(paths: RuntimePaths): RuntimeState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.state, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const s = parsed as Record<string, unknown>;
    return {
      ...(typeof s.previous === "string" && isVersion(s.previous) ? { previous: s.previous } : {}),
      ...(isRecord(s.failed) ? { failed: s.failed as Record<string, number> } : {}),
      ...(isRecord(s.held) ? { held: s.held as Record<string, string> } : {}),
    };
  } catch {
    return {};
  }
}

function isRecord(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function writeState(paths: RuntimePaths, state: RuntimeState): void {
  writeFileAtomic(paths.state, JSON.stringify(state, null, 2) + "\n");
}

/** The node recorded at install, or undefined. */
export function readNodePath(paths: RuntimePaths): string | undefined {
  try {
    const value = readFileSync(paths.nodePath, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
