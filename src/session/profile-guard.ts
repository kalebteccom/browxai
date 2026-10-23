// Which profile directory a persistent session launches on, and the refusal when
// another live session already has it open.
//
// A persistent session with no explicit `profile` runs on the workspace's default
// profile, whatever its id. One Chrome can hold a profile directory at a time, so
// a second session asking for the same directory gets a named refusal here instead
// of Chrome's own lock error (or a silent hand-off to the first browser).

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";
import { assertValidProfileName, invalidNameRefusal } from "../util/profile-name.js";
import { resolveWorkspacePath, type Workspace } from "../util/workspace.js";

/** The profile directory for a persistent launch: `<workspace>/profiles/<name>`
 *  for an explicit name, else the workspace default profile. A name that is not
 *  one plain directory name is refused before anything is created, and the
 *  resolved directory must sit directly under `<workspace>/profiles`. */
export function resolveProfileDir(
  workspace: Pick<Workspace, "root" | "sub" | "defaultProfile">,
  profile: string | undefined,
): string {
  if (!profile) return workspace.defaultProfile();
  assertValidProfileName("profile", profile);
  const profilesDir = join(workspace.root, "profiles");
  const dir = resolveWorkspacePath(profilesDir, profile, "open_session");
  if (dir === profilesDir) throw new Error(invalidNameRefusal("profile", profile));
  return workspace.sub(relative(workspace.root, dir));
}

interface LiveSession {
  id: string;
  session: { profileDir?: string };
}

/** The message for a launch of `id` on `profileDir` that another live session
 *  holds, or null when no other live session is on that directory. */
export function liveProfileRefusal(
  live: readonly LiveSession[],
  id: string,
  profileDir: string,
  profile: string | undefined,
): string | null {
  const holder = live.find((e) => e.id !== id && e.session.profileDir === profileDir);
  if (!holder) return null;
  const label = profile ? `profile "${profile}"` : "the workspace default profile";
  return (
    `profile-in-use: session "${id}" cannot launch on ${label} (${profileDir}): ` +
    `session "${holder.id}" has it open, and a browser profile can be open in one browser at a time. ` +
    `Pass an explicit \`profile\` name to open_session for "${id}", use mode "incognito", ` +
    `or close_session "${holder.id}" first.`
  );
}

/** Throws the `profile-in-use` refusal when another live session holds
 *  `profileDir`. Runs in the session factory, before the browser launches. */
export function refuseLiveProfile(
  registry: { list(): readonly LiveSession[] },
  id: string,
  profileDir: string,
  profile: string | undefined,
): void {
  const message = liveProfileRefusal(registry.list(), id, profileDir, profile);
  if (message) throw new Error(message);
}

/** Who holds a profile directory on disk, per the lock files Chrome keeps in it. */
export interface ProfileLock {
  /** Pid of the Chrome that holds the profile, when the lock names one. */
  pid?: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The Chrome holding `profileDir` right now, or null. Chrome keeps a
 *  `SingletonLock` symlink (`<host>-<pid>`) in a profile on macOS and Linux and a
 *  `lockfile` on Windows. A symlink naming a dead pid on this host is left over
 *  from a crash and does not count. A lock from another host cannot be checked
 *  and is left to Chrome to judge, so it does not count either. */
export function profileLockHolder(
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
  host: string = hostname(),
): ProfileLock | null {
  if (platform === "win32") {
    return existsSync(join(profileDir, "lockfile")) ? {} : null;
  }
  let target: string;
  try {
    const link = join(profileDir, "SingletonLock");
    if (!lstatSync(link).isSymbolicLink()) return null;
    target = readlinkSync(link);
  } catch {
    return null;
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m || m[1] !== host) return null;
  const pid = Number(m[2]);
  return pidAlive(pid) ? { pid } : null;
}

/** Throws a `profile-in-use` refusal when a Chrome outside this server's own
 *  sessions (a `browxai chrome` window, another server) holds `profileDir`. */
export function refuseLockedProfile(profileDir: string, id: string): void {
  const lock = profileLockHolder(profileDir);
  if (!lock) return;
  const who = lock.pid ? `a Chrome (pid ${lock.pid})` : "a Chrome";
  throw new Error(
    `profile-in-use: session "${id}" cannot launch on ${profileDir}: ${who} outside this server ` +
      "has it open (a `browxai chrome start` / `chrome login` window, or another browxai server). " +
      'Quit that Chrome, pass an explicit `profile` name to open_session, or use mode "incognito".',
  );
}
