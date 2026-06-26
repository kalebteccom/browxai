// Lockfile / reproducibility store for the `browxai plugin` CLI — the
// `<workspace>/plugins-lock.json` read/write seam plus the content-pin hash
// (`sha256OfPackage`) that backs every `contentSha256`. Split out of `cli.ts`
// so `browxai doctor` can read the lock and recompute the pin (drift
// detection) without depending on the CLI command surface.
//
// Lock file shape (kept small + hand-readable):
//   - <workspace>/plugins-lock.json    auto-generated pin + sha256
//
// Leaf module: imports only node stdlib + the `PluginPaths` type. It MUST NOT
// import from `./cli.js` (the barrel that re-exports it) — that would be an
// import cycle.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type PluginPaths } from "./resolver.js";

export interface LockEntry {
  /** npm package name. */
  readonly name: string;
  /** Installed version (read from the package's package.json after install). */
  readonly version: string;
  /** Where the package was installed from (`npm`, `file:./path`, etc.). */
  readonly source: string;
  /** sha256 over the package's package.json + main entry — the
   *  reproducibility pin. Mismatch on next install means the underlying
   *  package contents changed. */
  readonly contentSha256: string;
}

export interface LockFile {
  /** Version of the lock format itself. Bumped on incompatible change. */
  readonly lockfileVersion: 1;
  /** Entries keyed by package name. */
  readonly entries: Record<string, LockEntry>;
}

/** Tolerant lock read — also consumed by `browxai doctor` for lock-health checks. */
export function readLock(paths: PluginPaths): LockFile {
  if (!existsSync(paths.lockFile)) return { lockfileVersion: 1, entries: {} };
  try {
    const raw = JSON.parse(readFileSync(paths.lockFile, "utf8")) as Partial<LockFile>;
    if (raw && raw.lockfileVersion === 1 && raw.entries) {
      return { lockfileVersion: 1, entries: raw.entries };
    }
  } catch {
    /* fall through */
  }
  return { lockfileVersion: 1, entries: {} };
}

export function writeLock(paths: PluginPaths, data: LockFile): void {
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.lockFile, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** Content pin over an installed package — the same hash `plugins-lock.json`
 *  stores as `contentSha256`. Exported so `browxai doctor` can recompute it
 *  and detect drift against the pinned value. */
export function sha256OfPackage(pkgRoot: string): string {
  const hash = createHash("sha256");
  // Hash package.json verbatim + every file referenced by `files`/`main`/
  // `browxai.register`. Falls back to walking package.json + main entry
  // when the field isn't there. Keep small + deterministic.
  const pkgJsonPath = join(pkgRoot, "package.json");
  if (!existsSync(pkgJsonPath)) return "";
  const pkgJson = readFileSync(pkgJsonPath);
  hash.update(pkgJson);
  try {
    const parsed = JSON.parse(pkgJson.toString("utf8")) as {
      browxai?: { register?: string };
      main?: string;
      files?: string[];
    };
    const targets = new Set<string>();
    if (parsed.browxai?.register) targets.add(parsed.browxai.register);
    if (parsed.main) targets.add(parsed.main);
    for (const f of parsed.files ?? []) targets.add(f);
    for (const rel of [...targets].sort()) {
      const abs = join(pkgRoot, rel);
      if (!existsSync(abs)) continue;
      const st = statSync(abs);
      if (st.isFile()) {
        hash.update(rel);
        hash.update(readFileSync(abs));
      } else if (st.isDirectory()) {
        for (const sub of walkDir(abs)) {
          const subRel = relative(pkgRoot, sub).split(sep).join("/");
          hash.update(subRel);
          hash.update(readFileSync(sub));
        }
      }
    }
  } catch {
    /* fall through — partial hash is still meaningful for drift detection */
  }
  return hash.digest("hex");
}

function* walkDir(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile()) yield p;
    else if (entry.isDirectory()) yield* walkDir(p);
  }
}
