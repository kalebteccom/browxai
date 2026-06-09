// Per-session artifact KV — session-scoped workspace primitives.
//
// First-class `save_artifact(name, content)` / `list_artifacts` /
// `load_artifact(name)` for the "build your own library over time" loop.
// Before this lane agents were forced to round-trip scripts/files/blobs
// through `name_ref`/`name_region` — both ref-typed and a poor fit for
// raw byte/string payloads.
//
// Design notes:
//   - **Per-session.** Each `SessionEntry` owns one registry; entries
//     don't cross sessions. Storage dir is
//     `$BROWX_WORKSPACE/.artifacts/<sessionId>/`.
//   - **Workspace-rooted paths only.** The name is restricted to a safe
//     character set (no path separators, no leading dots, no `..`) — same
//     posture as `assertSafeName` in `src/session/storage.ts`. Even with
//     that, the composed path is re-resolved + workspace-escape-rejected
//     defensively (defence in depth — `path/posix.join` with the workspace
//     prefix).
//   - **Cleared on session close.** Teardown wipes the whole
//     `<sessionId>/` subdir; sessions that never wrote an artifact leave
//     no trace.
//   - **Capacity-bounded.** Max 200 entries AND 50 MiB total. Oldest-write
//     evicted on overflow (per-name `mtime` ordering — LRU-by-write).
//   - **Encoding.** `utf8` (default) treats `content` as text; `base64`
//     decodes binary. Reads return the same encoding the caller wrote
//     with — round-trip-faithful for both text and binary payloads.
//   - **Capability split.** `artifact_save` → `action` (writes a file).
//     `artifact_get` / `artifact_list` → `read`.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { assertSafeName } from "./storage.js";

/** Max number of artifacts kept per session. Oldest-write evicted past this. */
export const ARTIFACT_MAX_ENTRIES = 200;
/** Max total bytes kept per session (50 MiB). Oldest-write evicted to fit. */
export const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;

export type ArtifactEncoding = "utf8" | "base64";

/** What `artifact_list` returns per entry. */
export interface ArtifactInfo {
  name: string;
  /** size on disk, bytes. */
  size: number;
  /** ISO timestamp of last write. */
  mtime: string;
}

/** Per-session artifact registry. One instance per SessionEntry. */
export class ArtifactsRegistry {
  constructor(
    /** Per-session storage dir: `$BROWX_WORKSPACE/.artifacts/<sessionId>/`. */
    readonly storageDir: string,
  ) {}

  /** Resolve + workspace-escape-check the on-disk path for a name. The name
   *  is asserted via `assertSafeName` first (no separators / no `..` — the
   *  shared validator from storage.ts) PLUS a no-leading-dot guard added
   *  here so we never write a hidden file into the artifacts dir; the path
   *  is then re-resolved + checked it stays inside `storageDir` as defence
   *  in depth. */
  pathFor(name: string): string {
    assertSafeName("artifact name", name);
    if (name.startsWith(".")) {
      throw new Error(`artifact name "${name}" invalid — names cannot start with '.'`);
    }
    const target = join(this.storageDir, name);
    const resolved = resolve(target);
    const root = resolve(this.storageDir);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new Error(
        `artifact name "${name}" resolved outside its session storage dir — refusing.`,
      );
    }
    return resolved;
  }

  /** Write an artifact. Overwrites an existing entry of the same name.
   *  Evicts oldest-write entries to stay under the capacity caps. */
  save(name: string, content: string, encoding: ArtifactEncoding = "utf8"): ArtifactInfo {
    const dest = this.pathFor(name);
    // `storageDir` is workspace-rooted by construction — the SessionEntry
    // factory sets it via `workspace.sub('.artifacts/<id>')` (see server.ts).
    // `dest` is the asserted-safe-name joined to that storageDir, with the
    // workspace-escape re-check in `pathFor`.
    if (!existsSync(this.storageDir)) mkdirSync(this.storageDir, { recursive: true });
    const buf =
      encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    // workspace.sub-rooted by construction (see comment above).
    writeFileSync(dest, buf);
    this.enforceCaps();
    const st = statSync(dest);
    return { name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  }

  /** Read an artifact's bytes back. Throws if the name is unknown or the
   *  file vanished. */
  get(
    name: string,
    encoding: ArtifactEncoding = "utf8",
  ): { content: string; size: number; mtime: string; encoding: ArtifactEncoding } {
    const dest = this.pathFor(name);
    if (!existsSync(dest)) {
      throw new Error(
        `artifact_get: no artifact "${name}" in this session — call artifact_save({ name, content }) first.`,
      );
    }
    const buf = readFileSync(dest);
    const st = statSync(dest);
    return {
      content: encoding === "base64" ? buf.toString("base64") : buf.toString("utf8"),
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      encoding,
    };
  }

  /** Enumerate every artifact in this session (sorted by name asc).
   *  Read-only; never throws on a single bad entry — skip unreadable. */
  list(): ArtifactInfo[] {
    if (!existsSync(this.storageDir)) return [];
    const out: ArtifactInfo[] = [];
    for (const entry of readdirSync(this.storageDir)) {
      const p = join(this.storageDir, entry);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        out.push({ name: entry, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      } catch {
        /* skip unreadable */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Best-effort wipe of the entire storage dir. Called on session
   *  teardown — every artifact written during the session is removed.
   *  Idempotent; ignores missing-dir. */
  clear(): void {
    try {
      if (existsSync(this.storageDir)) rmSync(this.storageDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  // ---- capacity enforcement -------------------------------------------------

  /** Evict oldest-write entries until both the entry-count and total-byte
   *  caps are satisfied. Called after every save. */
  private enforceCaps(): void {
    const entries = this.statsByMtime();
    // entry-count cap
    while (entries.length > ARTIFACT_MAX_ENTRIES) {
      const victim = entries.shift();
      if (!victim) break;
      this.evict(victim.path);
    }
    // byte cap
    let totalBytes = entries.reduce((s, e) => s + e.size, 0);
    while (totalBytes > ARTIFACT_MAX_BYTES) {
      const victim = entries.shift();
      if (!victim) break;
      this.evict(victim.path);
      totalBytes -= victim.size;
    }
  }

  /** stat every entry, sorted by mtime ascending (oldest first). */
  private statsByMtime(): Array<{ path: string; size: number; mtimeMs: number }> {
    if (!existsSync(this.storageDir)) return [];
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    for (const name of readdirSync(this.storageDir)) {
      const p = join(this.storageDir, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  private evict(p: string): void {
    try {
      rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
