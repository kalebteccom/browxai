// Plugin manifest-validation pipeline — the pure, side-effect-light
// stages the runtime runs BEFORE it dynamic-imports any plugin code.
//
// Given the start options, this resolves every declared manifest off
// disk and runs the staged gauntlet:
//   1. Resolve manifests.
//   2. Filter to fully-resolved + validate apiVersion, namespace
//      uniqueness, and dependsOn targets/ranges. browxaiVersion is an
//      advisory warning (never a rejection).
//   3. Build the dep graph; cycles throw `DepGraphCycleError` (the ONE
//      fatal outcome — server start aborts, by contract).
//   4. Capability subset check (mismatches recorded, not yet disabled).
//
// Everything that fails (other than a cycle) is downgraded to an
// `earlyDisabled` PluginRecord the runtime surfaces verbatim. The output
// is the validated load plan the runtime's orchestration consumes — this
// module never imports or executes plugin entry modules.

import { log } from "../util/logging.js";
import { PACKAGE_VERSION } from "../util/version.js";
import type { Capability } from "../util/capabilities.js";
import { isApiVersionCompatible, RUNTIME_API_VERSION, satisfiesRange } from "./manifest.js";
import type { ResolvedManifest } from "./manifest.js";
import {
  pluginPaths,
  readDeclaration,
  resolveDeclaredPlugin,
  type ResolveResult,
} from "./resolver.js";
import { buildDepGraph, DepGraphCycleError, type DepGraphResult } from "./depgraph.js";
import type { RuntimeStartOptions } from "./host-hooks.js";
import type { PluginRecord } from "./types.js";

/** The validated load plan handed back to the runtime's orchestration. */
export interface ValidatedPlan {
  /** Manifests that survived every non-fatal gate, keyed by npm name. */
  readonly validResolved: Map<string, ResolvedManifest>;
  /** Plugins downgraded to a non-loaded record during validation. */
  readonly earlyDisabled: PluginRecord[];
  /** Topo-sorted load order + transitive-dep closures. */
  readonly depResult: DepGraphResult;
  /** Plugins whose declared capabilities aren't enabled → mismatch reason. */
  readonly capFail: Map<string, string>;
  /** Shared ISO timestamp stamped on every record from this run. */
  readonly declaredAt: string;
  /** Empty when no plugins are declared (runtime short-circuits). */
  readonly declaredCount: number;
}

/**
 * Run the full pre-load validation pipeline.
 *
 * Returns a {@link ValidatedPlan}. Throws ONLY on a dep-graph cycle
 * (`DepGraphCycleError`) — every other failure mode is folded into
 * `earlyDisabled`/`capFail` so the runtime can keep loading the rest.
 */
export function validatePlugins(opts: RuntimeStartOptions): ValidatedPlan {
  const paths = pluginPaths(opts.workspaceRoot);
  const fromFile = readDeclaration(paths).filter((d) => d.enabled);
  // Union with any plugins declared via the config store. The config
  // store entry is a simple `string[]` (npm names) — file entries (which
  // can also carry a per-entry trust override) take precedence on name
  // collision.
  const known = new Set(fromFile.map((d) => d.name));
  const merged = [...fromFile];
  for (const name of opts.extraDeclared ?? []) {
    if (!known.has(name)) {
      merged.push({ name, enabled: true });
      known.add(name);
    }
  }
  const declared = merged;
  if (declared.length === 0) {
    log.info("plugin runtime: no plugins declared", { declarationFile: paths.declarationFile });
    return {
      validResolved: new Map(),
      earlyDisabled: [],
      depResult: { loadOrder: [], transitiveDeps: new Map() },
      capFail: new Map(),
      declaredAt: new Date().toISOString(),
      declaredCount: 0,
    };
  }

  // Stage 1: resolve manifests.
  const resolved: Map<string, ResolveResult> = new Map();
  for (const decl of declared) {
    resolved.set(decl.name, resolveDeclaredPlugin(paths, decl));
  }

  // Stage 2: filter to fully-resolved + validate namespace uniqueness +
  // apiVersion + dep targets. Anything that fails is downgraded to a
  // load-error record we'll surface at the end.
  const earlyDisabled: PluginRecord[] = [];
  const validResolved = new Map<string, ResolvedManifest>();
  const declaredAt = new Date().toISOString();

  for (const [name, res] of resolved) {
    if (res.kind === "not-installed") {
      earlyDisabled.push({
        manifest: {
          name,
          version: "0.0.0",
          path: "",
          entryPath: "",
          trust: "community",
          browxai: {
            apiVersion: "",
            namespace: "",
            register: "",
            capabilities: [],
            dependsOn: [],
          },
        },
        status: "load-error",
        tools: [],
        transitiveDeps: [],
        statusReason: `not installed under ${paths.nodeModulesDir}/${name}/. Run \`browxai plugin install ${name}\` (or \`browxai plugin sync\` if the declaration was hand-edited).`,
        declaredCapabilities: [],
        declaredAt,
      });
      continue;
    }
    if (res.kind === "invalid-manifest") {
      earlyDisabled.push({
        manifest: {
          name,
          version: "0.0.0",
          path: "",
          entryPath: "",
          trust: "community",
          browxai: {
            apiVersion: "",
            namespace: "",
            register: "",
            capabilities: [],
            dependsOn: [],
          },
        },
        status: "load-error",
        tools: [],
        transitiveDeps: [],
        statusReason: `invalid plugin manifest: ${res.error}`,
        declaredCapabilities: [],
        declaredAt,
      });
      continue;
    }
    validResolved.set(name, res.manifest);
  }

  // browxaiVersion advisory. The manifest field is the host range the
  // plugin was tested against — a mismatch NEVER rejects loading (a
  // conservative range must not lock out a known-good host that already
  // shipped), but it warns loudly so the operator knows the combination
  // is untested.
  for (const [name, m] of validResolved) {
    const range = m.browxai.browxaiVersion;
    if (range && !satisfiesRange(PACKAGE_VERSION, range)) {
      log.warn(
        `plugin runtime: ${name} was tested against browxai "${range}" but this host is ${PACKAGE_VERSION} — ` +
          `untested combination (advisory only; the plugin still loads). ` +
          `Upgrade the plugin or widen its browxaiVersion range.`,
      );
    }
  }

  // apiVersion check.
  const apiVersionFail: string[] = [];
  for (const [name, m] of validResolved) {
    if (!isApiVersionCompatible(m.browxai.apiVersion, RUNTIME_API_VERSION)) {
      apiVersionFail.push(name);
      earlyDisabled.push({
        manifest: m,
        status: "load-error",
        tools: [],
        transitiveDeps: [],
        statusReason:
          `plugin apiVersion "${m.browxai.apiVersion}" is incompatible with the host runtime apiVersion "${RUNTIME_API_VERSION}". ` +
          `Upgrade the plugin (or pin a host browxai version compatible with the plugin's runtime contract).`,
        declaredCapabilities: m.browxai.capabilities,
        declaredAt,
      });
    }
  }
  for (const n of apiVersionFail) validResolved.delete(n);

  // Namespace uniqueness.
  const namespaceOwner = new Map<string, string>();
  const namespaceConflicts: string[] = [];
  for (const [name, m] of validResolved) {
    const ns = m.browxai.namespace;
    const prior = namespaceOwner.get(ns);
    if (prior) {
      namespaceConflicts.push(name);
      earlyDisabled.push({
        manifest: m,
        status: "disabled-by-namespace-conflict",
        tools: [],
        transitiveDeps: [],
        statusReason: `namespace "${ns}" is already claimed by plugin "${prior}". Two plugins cannot share a namespace; rename one.`,
        declaredCapabilities: m.browxai.capabilities,
        declaredAt,
      });
    } else {
      namespaceOwner.set(ns, name);
    }
  }
  for (const n of namespaceConflicts) validResolved.delete(n);

  // dependsOn target + version-range check.
  const depFail = new Map<string, string>();
  for (const [name, m] of validResolved) {
    for (const dep of m.browxai.dependsOn) {
      const target = validResolved.get(dep.plugin);
      if (!target) {
        depFail.set(name, `dependsOn["${dep.plugin}"] not loaded — install or enable it.`);
        break;
      }
      if (!satisfiesRange(target.version, dep.version)) {
        depFail.set(
          name,
          `dependsOn["${dep.plugin}"] installed version ${target.version} does not satisfy range "${dep.version}".`,
        );
        break;
      }
    }
  }
  for (const [name, reason] of depFail) {
    const m = validResolved.get(name)!;
    earlyDisabled.push({
      manifest: m,
      status: "disabled-by-dep-missing",
      tools: [],
      transitiveDeps: [],
      statusReason: reason,
      declaredCapabilities: m.browxai.capabilities,
      declaredAt,
    });
    validResolved.delete(name);
  }

  // Stage 3: build dep graph. Cycles abort startup loudly.
  const directDeps = new Map<string, ReadonlyArray<string>>();
  for (const [name, m] of validResolved) {
    directDeps.set(
      name,
      m.browxai.dependsOn.map((d) => d.plugin),
    );
  }
  let depResult: DepGraphResult;
  try {
    depResult = buildDepGraph({ directDeps });
  } catch (e) {
    if (e instanceof DepGraphCycleError) {
      // Surface every cycle plugin explicitly so the operator sees the
      // shape of the cycle, then re-throw with the structured error.
      for (const c of e.cycles) {
        log.error(`plugin runtime: cycle ${c.join(" → ")} → ${c[0]}`);
      }
      throw e;
    }
    throw e;
  }

  // Stage 4: capability subset check. Mismatched plugins get a
  // disabled-by-capability-mismatch record + skipped.
  const capFail = new Map<string, string>();
  for (const [name, m] of validResolved) {
    const missing = m.browxai.capabilities.filter(
      (c) => !opts.enabledCapabilities.has(c as Capability),
    );
    if (missing.length > 0) {
      capFail.set(
        name,
        `plugin declares capabilities [${missing.join(", ")}] not enabled on this server. ` +
          `Add them to BROWX_CAPABILITIES (or set_config({capabilities:[...]})) and RESTART. ` +
          `Capabilities are resolved ONCE at server start — set_config alone won't enable a plugin's gate.`,
      );
    }
  }

  return {
    validResolved,
    earlyDisabled,
    depResult,
    capFail,
    declaredAt,
    declaredCount: declared.length,
  };
}
