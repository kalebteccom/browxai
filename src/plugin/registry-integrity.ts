// The integrity hash the package manager recorded when it fetched an installed
// plugin from the registry, read from the manager's own lockfile in
// `<workspace>/plugins/`. `browxai plugin` copies it into plugins-lock.json, and
// the first-party trust tier requires it (see `./trust.js`).
//
// Only a registry fetch of the package under its own name and version yields a
// value. An aliased install (`name@npm:other`), a git dependency, a `file:` path
// or a tarball URL yields undefined, because the manager records it under a
// different key, a non-registry resolution, or no integrity at all.
//
// Leaf module: node stdlib only.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface NpmLockPackage {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly resolved?: unknown;
  readonly integrity?: unknown;
}

/** npm: `package-lock.json` (lockfileVersion 2 and 3). An alias carries a
 *  `name` field and resolves to the other package's tarball. */
function fromNpmLock(installDir: string, name: string, version: string): string | undefined {
  const file = join(installDir, "package-lock.json");
  if (!existsSync(file)) return undefined;
  let entry: NpmLockPackage | undefined;
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as {
      packages?: Record<string, NpmLockPackage>;
    };
    entry = lock.packages?.[`node_modules/${name}`];
  } catch {
    return undefined;
  }
  if (!entry || entry.name !== undefined || entry.version !== version) return undefined;
  const bare = name.slice(name.lastIndexOf("/") + 1);
  const tarball = `/${name}/-/${bare}-${version}.tgz`;
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://"))
    return undefined;
  if (!entry.resolved.endsWith(tarball)) return undefined;
  return typeof entry.integrity === "string" && entry.integrity ? entry.integrity : undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** pnpm: `pnpm-lock.yaml` (lockfile format 9, pnpm 9 and 10). The importer
 *  entry must name the plain version (an alias reads `version: other@1.0.0`,
 *  a path `version: file:...`), and the package entry must carry a registry
 *  `integrity`. */
function fromPnpmLock(installDir: string, name: string, version: string): string | undefined {
  const file = join(installDir, "pnpm-lock.yaml");
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch {
    return undefined;
  }
  const n = escapeRe(name);
  const importer = new RegExp(
    `^ {6}'?${n}'?:\\n {8}specifier: [^\\n]*\\n {8}version: ([^\\s(]+)`,
    "m",
  ).exec(text);
  if (!importer || importer[1] !== version) return undefined;
  const pkg = new RegExp(
    `^ {2}'?${n}@${escapeRe(version)}'?:\\n {4}resolution: \\{integrity: (sha\\d+-[A-Za-z0-9+/=]+)[,}]`,
    "m",
  ).exec(text);
  return pkg?.[1];
}

/** The registry integrity recorded for `name@version` in the install dir, or
 *  undefined when the package was not fetched from the registry under that
 *  name. */
export function readRegistryIntegrity(
  installDir: string,
  name: string,
  version: string,
): string | undefined {
  return fromNpmLock(installDir, name, version) ?? fromPnpmLock(installDir, name, version);
}
