// `browxai doctor` — the plugins section.
//
// Inspects the plugin runtime's declarative surface (`plugins.json`,
// `plugins/node_modules/`, `plugins-lock.json`) with the SAME resolution
// + validation stages the runtime runs at server start (resolver, manifest
// schema, apiVersion, namespace uniqueness, dependsOn graph, capability
// subset) — but it NEVER imports a plugin's register module. Doctor is a
// read-only inspection pass; executing plugin code is the server's job.
//
// Emits doctor `Check` rows named "plugins":
//   ✓ — healthy (declaration parseable, plugin resolved + pinned)
//   ✗ — drift or contract violation (fails doctor overall, fix hint attached)
//   − — informational (nothing declared / declared-but-disabled); never fails

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./doctor.js";
import type { Capability } from "../util/capabilities.js";
import {
  isApiVersionCompatible,
  RUNTIME_API_VERSION,
  satisfiesRange,
  type ResolvedManifest,
} from "../plugin/manifest.js";
import {
  pluginPaths,
  readDeclaration,
  resolveDeclaredPlugin,
  type DeclaredPlugin,
  type PluginPaths,
} from "../plugin/resolver.js";
import { buildDepGraph, DepGraphCycleError } from "../plugin/depgraph.js";
import { readLock, sha256OfPackage } from "../plugin/cli.js";

const CHECK_NAME = "plugins";

export interface PluginChecksOptions {
  /** Workspace root (`resolveWorkspace().root`). */
  readonly workspaceRoot: string;
  /** The capability set doctor resolved (mirrors the server's gate input). */
  readonly enabledCapabilities: ReadonlySet<Capability>;
  /** Extra plugin names declared via the config store
   *  (`set_config({plugins})`) — unioned with `plugins.json` exactly the
   *  way `startPluginRuntime` unions them. File entries win on collision. */
  readonly extraDeclared?: ReadonlyArray<string>;
}

interface Finding {
  readonly detail: string;
  readonly fix: string;
}

/**
 * Build the doctor checks for the plugin surface. Pure inspection — reads
 * the declaration, the lock, and installed `package.json` manifests; never
 * executes plugin code.
 */
export function pluginChecks(opts: PluginChecksOptions): Check[] {
  const checks: Check[] = [];
  const paths = pluginPaths(opts.workspaceRoot);

  // 1. plugins.json present + parseable.
  const fileExists = existsSync(paths.declarationFile);
  if (fileExists) {
    try {
      JSON.parse(readFileSync(paths.declarationFile, "utf8"));
    } catch (e) {
      checks.push({
        name: CHECK_NAME,
        ok: false,
        detail: `plugins.json malformed: ${e instanceof Error ? e.message : String(e)}`,
        fix: `fix the JSON in ${paths.declarationFile} (or remove it and re-run \`browxai plugin install\`)`,
      });
      // Without a readable declaration the rest of the section can't
      // distinguish drift from intent — stop here.
      return checks;
    }
  }
  const fromFile = fileExists ? [...readDeclaration(paths)] : [];

  // Union with config-store-declared plugins (runtime parity).
  const declared: DeclaredPlugin[] = [...fromFile];
  const declaredNames = new Set(fromFile.map((d) => d.name));
  const fromConfigStore = new Set<string>();
  for (const name of opts.extraDeclared ?? []) {
    if (!declaredNames.has(name)) {
      declared.push({ name, enabled: true });
      declaredNames.add(name);
      fromConfigStore.add(name);
    }
  }

  if (declared.length === 0) {
    checks.push({
      name: CHECK_NAME,
      ok: true,
      info: true,
      detail: fileExists
        ? "no plugins declared (plugins.json has no entries)"
        : "no plugins declared (plugins.json absent)",
    });
  } else {
    const extras = fromConfigStore.size;
    checks.push({
      name: CHECK_NAME,
      ok: true,
      detail: fileExists
        ? `plugins.json: ${fromFile.length} declared${extras ? ` (+${extras} via set_config)` : ""}`
        : `plugins.json absent; ${extras} declared via set_config`,
    });
  }

  // 2. Resolve every enabled declaration the way the runtime does —
  //    manifest off disk, NO code execution.
  const enabledDecls = declared.filter((d) => d.enabled);
  const findings = new Map<string, Finding[]>();
  const note = (plugin: string, f: Finding): void => {
    const list = findings.get(plugin) ?? [];
    list.push(f);
    findings.set(plugin, list);
  };

  const resolved = new Map<string, ResolvedManifest>();
  for (const decl of enabledDecls) {
    const r = resolveDeclaredPlugin(paths, decl);
    if (r.kind === "not-installed") {
      note(decl.name, {
        detail: `${decl.name} declared but not installed (expected under ${paths.nodeModulesDir}/${decl.name}/)`,
        fix: "run `browxai plugin sync`",
      });
    } else if (r.kind === "invalid-manifest") {
      note(decl.name, {
        detail: `${decl.name} invalid manifest: ${r.error}`,
        fix: "fix the plugin's package.json#browxai field — see docs/plugin-authoring.md",
      });
    } else {
      resolved.set(decl.name, r.manifest);
    }
  }

  // 3. Manifest sanity — same staging as startPluginRuntime: apiVersion →
  //    namespace uniqueness → dependsOn targets → cycles → capabilities.
  //    `healthy` shrinks as stages disqualify plugins (runtime parity).
  const healthy = new Map(resolved);

  for (const [name, m] of [...healthy]) {
    if (!isApiVersionCompatible(m.browxai.apiVersion, RUNTIME_API_VERSION)) {
      note(name, {
        detail: `${name} apiVersion "${m.browxai.apiVersion}" incompatible with runtime apiVersion "${RUNTIME_API_VERSION}"`,
        fix: "upgrade the plugin (or pin a host browxai version compatible with the plugin's runtime contract)",
      });
      healthy.delete(name);
    }
  }

  const namespaceOwner = new Map<string, string>();
  for (const [name, m] of [...healthy]) {
    const ns = m.browxai.namespace;
    const prior = namespaceOwner.get(ns);
    if (prior) {
      note(name, {
        detail: `${name} namespace "${ns}" already claimed by ${prior}`,
        fix: "rename one — namespaces are globally unique across the loaded set",
      });
      healthy.delete(name);
    } else {
      namespaceOwner.set(ns, name);
    }
  }

  // dependsOn targets checked against the pre-removal set, mirroring the
  // runtime (a dep chain only flags the plugin whose direct dep is bad).
  const depFailed: string[] = [];
  for (const [name, m] of healthy) {
    for (const dep of m.browxai.dependsOn) {
      const target = healthy.get(dep.plugin);
      if (!target) {
        note(name, {
          detail: `${name} dependsOn["${dep.plugin}"] is not resolvable (not declared, not installed, or itself failing)`,
          fix: `run \`browxai plugin install ${dep.plugin}\` (and declare it in plugins.json)`,
        });
        depFailed.push(name);
        break;
      }
      if (!satisfiesRange(target.version, dep.version)) {
        note(name, {
          detail: `${name} dependsOn["${dep.plugin}"] installed version ${target.version} does not satisfy range "${dep.version}"`,
          fix: `run \`browxai plugin upgrade ${dep.plugin}\` (or relax the range in the manifest)`,
        });
        depFailed.push(name);
        break;
      }
    }
  }
  for (const name of depFailed) healthy.delete(name);

  const cycleChecks: Check[] = [];
  const cycleMembers = new Set<string>();
  try {
    const directDeps = new Map<string, ReadonlyArray<string>>();
    for (const [name, m] of healthy) {
      directDeps.set(
        name,
        m.browxai.dependsOn.map((d) => d.plugin),
      );
    }
    buildDepGraph({ directDeps });
  } catch (e) {
    if (!(e instanceof DepGraphCycleError)) throw e;
    for (const cycle of e.cycles) {
      cycleChecks.push({
        name: CHECK_NAME,
        ok: false,
        detail: `dependency cycle: ${cycle.join(" → ")} → ${cycle[0]} — server start ABORTS on cycles (no plugin loads)`,
        fix: "remove one direction of the cycle from the offending plugin manifest(s)",
      });
      for (const member of cycle) {
        cycleMembers.add(member);
        healthy.delete(member);
      }
    }
  }

  for (const [name, m] of healthy) {
    const missing = m.browxai.capabilities.filter(
      (c) => !opts.enabledCapabilities.has(c as Capability),
    );
    if (missing.length > 0) {
      note(name, {
        detail: `${name} declares capability(ies) [${missing.join(", ")}] not enabled on this server`,
        fix: `add ${missing.join(",")} to BROWX_CAPABILITIES (or set_config({capabilities:[...]})) and restart`,
      });
    }
  }

  // 4. Lock health. The lock pins file-declared plugins (the CLI install
  //    flow maintains it); config-store-only declarations carry no pin.
  const lockExists = existsSync(paths.lockFile);
  const lock = readLock(paths);
  const lockChecks: Check[] = [];
  const pinOk = new Set<string>();
  if (fromFile.length > 0 && !lockExists) {
    lockChecks.push({
      name: CHECK_NAME,
      ok: false,
      detail: `plugins-lock.json missing (${fromFile.length} plugin(s) declared — no reproducibility pin)`,
      fix: "run `browxai plugin sync` to regenerate the lock",
    });
  }
  if (lockExists) {
    for (const decl of fromFile) {
      const pkgRoot = join(paths.nodeModulesDir, decl.name);
      if (!existsSync(join(pkgRoot, "package.json"))) continue; // not installed — drift already flagged
      const entry = lock.entries[decl.name];
      if (!entry) {
        note(decl.name, {
          detail: `${decl.name} installed but has no pin in plugins-lock.json`,
          fix: "run `browxai plugin sync` to re-pin",
        });
        continue;
      }
      if (entry.contentSha256 !== sha256OfPackage(pkgRoot)) {
        note(decl.name, {
          detail: `${decl.name} contentSha256 MISMATCH vs plugins-lock.json — installed contents are NOT what was pinned`,
          fix: "do not trust the install until audited; after verifying the package contents, re-pin with `browxai plugin sync`",
        });
        continue;
      }
      pinOk.add(decl.name);
    }
    // Stale pins: lock entries for plugins no longer declared.
    for (const lockName of Object.keys(lock.entries).sort()) {
      if (!declaredNames.has(lockName)) {
        lockChecks.push({
          name: CHECK_NAME,
          ok: false,
          detail: `stale lock entry: ${lockName} pinned in plugins-lock.json but not declared in plugins.json`,
          fix: `\`browxai plugin remove ${lockName}\` clears the pin (or re-declare the plugin), then \`browxai plugin sync\``,
        });
      }
    }
  }

  // 5. Emit per-plugin rows in declaration order: every finding as ✗, a
  //    single ✓ for plugins with none, a − for declared-but-disabled.
  for (const decl of declared) {
    if (!decl.enabled) {
      checks.push({
        name: CHECK_NAME,
        ok: true,
        info: true,
        detail: `${decl.name} declared but disabled (enabled: false) — skipped at server start`,
      });
      continue;
    }
    const issues = findings.get(decl.name) ?? [];
    if (issues.length > 0) {
      for (const f of issues) {
        checks.push({ name: CHECK_NAME, ok: false, detail: f.detail, fix: f.fix });
      }
      continue;
    }
    if (cycleMembers.has(decl.name)) continue; // the cycle ✗ row covers it
    const m = resolved.get(decl.name);
    if (!m) continue; // defensive — every unresolved plugin carries a finding
    const lockNote = pinOk.has(decl.name)
      ? ", lock ok"
      : fromConfigStore.has(decl.name)
        ? ", declared via set_config"
        : "";
    checks.push({
      name: CHECK_NAME,
      ok: true,
      detail: `${m.name}@${m.version} (ns=${m.browxai.namespace}${lockNote})`,
    });
  }

  checks.push(...cycleChecks);

  // 6. Orphans: installed browxai plugins (package.json#browxai present)
  //    nobody declares. Transitive deps of plugins are NOT plugins and are
  //    ignored.
  for (const orphan of installedPluginNames(paths)) {
    if (declaredNames.has(orphan.dirName) || (orphan.pkgName && declaredNames.has(orphan.pkgName)))
      continue;
    checks.push({
      name: CHECK_NAME,
      ok: false,
      detail: `orphan install: ${orphan.dirName} present in ${paths.nodeModulesDir} but not declared in plugins.json`,
      fix: `\`browxai plugin remove ${orphan.dirName}\` (or declare it in plugins.json)`,
    });
  }

  checks.push(...lockChecks);
  return checks;
}

interface InstalledPlugin {
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
function installedPluginNames(paths: PluginPaths): InstalledPlugin[] {
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
