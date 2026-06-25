// `browxai doctor` — the plugins section's filesystem orphan scan.
//
// Reads `<workspace>/plugins/node_modules/` directly off disk to find
// installed browxai plugins (packages whose `package.json` carries a
// `browxai` field). The staged validation pipeline in `doctor-plugins.ts`
// uses this to surface ORPHANS — installed plugins nobody declares — which
// the declaration-driven resolve stages can't see by construction. Kept in
// a leaf so the pipeline and the scan share `PluginPaths` from the resolver
// without a barrel back-import.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginPaths } from "../plugin/resolver.js";

export interface InstalledPlugin {
  /** node_modules-relative name (`pkg` or `@scope/pkg`) — the identity the
   *  declaration + lock files key on. */
  readonly dirName: string;
  /** package.json#name when readable (may differ for file: installs). */
  readonly pkgName?: string;
}

/**
 * Scan `<workspace>/plugins/node_modules/` for installed browxai plugins —
 * packages whose `package.json` carries a `browxai` field. Skips dot-dirs
 * (`.pnpm`, `.bin`) and plain dependencies.
 */
export function installedPluginNames(paths: PluginPaths): InstalledPlugin[] {
  if (!existsSync(paths.nodeModulesDir)) return [];
  const out: InstalledPlugin[] = [];
  const consider = (dirName: string): void => {
    const pkgJsonPath = join(paths.nodeModulesDir, dirName, "package.json");
    if (!existsSync(pkgJsonPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
        name?: string;
        browxai?: unknown;
      };
      if (!parsed.browxai) return;
      out.push({ dirName, ...(parsed.name ? { pkgName: parsed.name } : {}) });
    } catch {
      /* unreadable package.json — not a resolvable plugin, not an orphan */
    }
  };
  for (const entry of readdirSync(paths.nodeModulesDir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = join(paths.nodeModulesDir, entry.name);
      let subs: string[];
      try {
        subs = readdirSync(scopeDir);
      } catch {
        continue;
      }
      for (const sub of subs) consider(`${entry.name}/${sub}`);
    } else {
      consider(entry.name);
    }
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}
