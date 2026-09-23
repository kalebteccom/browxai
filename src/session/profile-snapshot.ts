// Profile snapshot / restore — capability `human`.
//
// A destructive authenticated-SPA test mutates the persistent profile (an
// accidental timeline edit, a half-finished form, dirty local state). Repeat
// runs then start from a polluted baseline. This copies a session's profile
// directory to/from a named snapshot under the workspace, so a test can
// checkpoint a clean state and restore it between runs.
//
// Copying a profile dir while Chromium has it open yields a corrupt copy
// (locked SQLite, in-flight writes) — the caller MUST close sessions first;
// the server tool enforces that guard.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Provenance. `profile_restore` copies a snapshot over a browser profile, and a
// browser profile holds cookies and saved logins, so a snapshot must be one
// `profile_snapshot` wrote. The write tools already refuse
// `profile-snapshots/` (src/util/workspace.ts); on top of that each snapshot
// carries a manifest: a digest of its file tree, MACed with a key kept in the
// workspace (also write-protected). Restore recomputes both and refuses on any
// mismatch, so bytes that reached the directory any other way never land in a
// profile.

const MANIFEST = ".browx-snapshot.json";
/** Also listed in the workspace's protected files. */
export const SNAPSHOT_KEY_FILE = ".browx-snapshot-key";
/** Bound on the tree walk, so a pathological directory cannot stall a call. */
const MAX_ENTRIES = 200_000;

function snapshotKey(workspaceRoot: string): Buffer {
  const p = join(workspaceRoot, SNAPSHOT_KEY_FILE);
  if (!existsSync(p)) {
    try {
      writeFileSync(p, randomBytes(32), { mode: 0o600, flag: "wx" });
    } catch {
      /* created concurrently: read it below */
    }
  }
  const key = readFileSync(p);
  if (key.length < 32)
    throw new Error("profile snapshot key is corrupt; remove it and re-snapshot");
  return key;
}

/** Digest of every entry under `dir` except the manifest: relative path, kind,
 *  and content (a symlink contributes its target string, never what it points
 *  at). Sorted, so the digest does not depend on readdir order. */
function treeDigest(dir: string): string {
  const h = createHash("sha256");
  const entries: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === MANIFEST) continue;
      if (entries.length >= MAX_ENTRIES) throw new Error("profile snapshot has too many entries");
      entries.push(r);
      const st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) h.update(`L\0${r}\0${readlinkSync(join(dir, r))}\0`);
      else if (st.isDirectory()) {
        h.update(`D\0${r}\0`);
        walk(r);
      } else if (st.isFile()) {
        h.update(`F\0${r}\0${st.size}\0`);
        h.update(readFileSync(join(dir, r)));
      } else throw new Error(`profile snapshot holds an unsupported entry: ${r}`);
    }
  };
  walk("");
  return h.digest("hex");
}

function mac(key: Buffer, snapshot: string, digest: string): string {
  return createHmac("sha256", key).update(`browx-snapshot\0${snapshot}\0${digest}`).digest("hex");
}

// mnemonic / profile names — no path separators or traversal.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function checkName(kind: string, name: string): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(
      `${kind} "${name}" invalid — use only letters, digits, '.', '_', '-' (no path separators)`,
    );
  }
}

/** The on-disk dir for a session profile. `default`/undefined → the default
 *  session's profile (`defaultProfileDir`, i.e. BROWX_DEFAULT_PROFILE when set,
 *  else `<root>/profile`); a name → `<root>/profiles/<name>`. */
function profileDir(
  workspaceRoot: string,
  profile: string | undefined,
  defaultProfileDir?: string,
): string {
  if (!profile || profile === "default") return defaultProfileDir ?? join(workspaceRoot, "profile");
  checkName("profile", profile);
  return join(workspaceRoot, "profiles", profile);
}

function snapshotDir(workspaceRoot: string, snapshot: string): string {
  checkName("snapshot", snapshot);
  return join(workspaceRoot, "profile-snapshots", snapshot);
}

export interface ProfileSnapshotResult {
  ok: boolean;
  action: "snapshot" | "restore";
  profile: string;
  snapshot: string;
}

/** Copy a profile directory into a named snapshot (overwrites an existing
 *  snapshot of the same name). */
export function snapshotProfile(
  workspaceRoot: string,
  profile: string | undefined,
  snapshot: string,
  defaultProfileDir?: string,
): ProfileSnapshotResult {
  const src = profileDir(workspaceRoot, profile, defaultProfileDir);
  const dest = snapshotDir(workspaceRoot, snapshot);
  if (!existsSync(src)) {
    throw new Error(
      `profile_snapshot: no profile directory at "${src}" — open a persistent session with this profile first`,
    );
  }
  // Replace, never merge: a leftover file would not be covered by intent.
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, force: true, verbatimSymlinks: true });
  const digest = treeDigest(dest);
  writeFileSync(
    join(dest, MANIFEST),
    JSON.stringify({ version: 1, digest, mac: mac(snapshotKey(workspaceRoot), snapshot, digest) }),
  );
  return { ok: true, action: "snapshot", profile: profile ?? "default", snapshot };
}

/** Restore a named snapshot back over a profile directory. */
export function restoreProfile(
  workspaceRoot: string,
  profile: string | undefined,
  snapshot: string,
  defaultProfileDir?: string,
): ProfileSnapshotResult {
  const src = snapshotDir(workspaceRoot, snapshot);
  const dest = profileDir(workspaceRoot, profile, defaultProfileDir);
  if (!existsSync(src)) {
    throw new Error(
      `profile_restore: no snapshot "${snapshot}" — take one with profile_snapshot first`,
    );
  }
  verifySnapshot(workspaceRoot, snapshot, src);
  cpSync(src, dest, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (from) => from !== join(src, MANIFEST),
  });
  return { ok: true, action: "restore", profile: profile ?? "default", snapshot };
}

/** Throws unless `dir` carries a manifest this workspace's key signed and its
 *  tree still matches the digest in it. */
function verifySnapshot(workspaceRoot: string, snapshot: string, dir: string): void {
  const refuse = (why: string): never => {
    throw new Error(
      `profile_restore: refusing snapshot "${snapshot}": ${why}. Only a snapshot profile_snapshot ` +
        "wrote, unmodified since, can be restored; take a new one.",
    );
  };
  const mf = join(dir, MANIFEST);
  if (!existsSync(mf)) refuse("it has no snapshot manifest");
  let m: { version?: unknown; digest?: unknown; mac?: unknown };
  try {
    m = JSON.parse(readFileSync(mf, "utf8")) as typeof m;
  } catch {
    return refuse("its manifest is unreadable");
  }
  if (m.version !== 1 || typeof m.digest !== "string" || typeof m.mac !== "string")
    refuse("its manifest is malformed");
  const digest = m.digest as string;
  const want = Buffer.from(mac(snapshotKey(workspaceRoot), snapshot, digest), "hex");
  const got = Buffer.from(m.mac as string, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want))
    refuse("its manifest was not signed by this workspace");
  if (treeDigest(dir) !== digest) refuse("its files changed after it was taken");
}
