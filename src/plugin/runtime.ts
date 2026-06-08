// Plugin runtime — the orchestrator the server invokes at start.
//
// Flow:
//   1. Read `<workspace>/plugins.json` for the declared set.
//   2. Resolve each declared plugin's manifest off disk.
//   3. Validate namespaces: globally unique + non-reserved.
//   4. Validate apiVersion: each plugin's apiVersion must be compatible
//      with this runtime's RUNTIME_API_VERSION.
//   5. Validate dependsOn target exists + satisfies semver range.
//   6. Build dep graph; reject cycles loudly (server start fails).
//   7. Topo-sort load order.
//   8. For each plugin: check declared capabilities ⊆ enabled set;
//      on mismatch, mark plugin disabled-by-capability-mismatch and
//      skip without aborting server start.
//   9. Dynamic-import the entry module; call register(api).
//   10. Per-tool: gate behind the capability the plugin declared; route
//       through the host's existing capability gate at dispatch.
//
// In-process JS modules only (v1). No out-of-process plugin processes.
// Resolved-once-at-server-start. No hot reload — restart is the contract.

import { pathToFileURL } from "node:url";
import type { z } from "zod";
import { log } from "../util/logging.js";
import type { Capability } from "../util/capabilities.js";
import {
  isApiVersionCompatible,
  RUNTIME_API_VERSION,
  satisfiesRange,
} from "./manifest.js";
import {
  pluginPaths,
  readDeclaration,
  resolveDeclaredPlugin,
  type ResolveResult,
} from "./resolver.js";
import {
  buildDepGraph,
  DepGraphCycleError,
} from "./depgraph.js";
import type {
  PluginApi,
  PluginRecord,
  PluginRegisterFn,
  PluginStatus,
  PluginToolHandler,
  PluginToolRecord,
  PluginToolResponse,
} from "./types.js";

/** Error code emitted when a plugin's `api.callTool` violates the call graph. */
export const PLUGIN_CALL_GRAPH_VIOLATION = "plugin-call-graph-violation";

export interface RuntimeHostHooks {
  /**
   * Tools registered before the runtime engages — i.e. the core browxai
   * surface (and any earlier plugin tools loaded by a previous batch).
   * Used by call-graph enforcement: a plugin may always call a core
   * tool (implicit-root). Core tool names are namespace-less.
   */
  isCoreTool(name: string): boolean;

  /**
   * Dispatch a tool by name. Routes through the host's wrapped handler
   * (capability gate, diagnostics, metrics, secrets masking — all the
   * usual chokepoints). Called by plugin tools through `api.callTool`
   * AFTER the call-graph check passes.
   */
  dispatch(name: string, args: unknown): Promise<PluginToolResponse>;

  /**
   * Register a plugin-emitted tool into the host's MCP server +
   * `toolHandlers` map. The host applies its standard wrapping
   * (capability gate, metrics, diagnostics) so plugin tools behave
   * identically to core tools at the dispatch boundary.
   *
   * `capability` is whatever the plugin declared for itself — passed
   * through so the host's gate can refuse if the capability isn't
   * active. `ownerPlugin` is the npm name of the plugin registering
   * the tool — kept on the host side so `ownerOf` can answer cross-
   * plugin lookups.
   */
  registerTool(
    name: string,
    def: { description: string; inputSchema?: Record<string, z.ZodTypeAny> | undefined },
    handler: PluginToolHandler,
    capability: string | undefined,
    ownerPlugin: string,
  ): void;

  /**
   * Look up the owner of an already-registered plugin tool. Returns
   * `undefined` for core tools or unknown names.
   */
  ownerOf(toolName: string): string | undefined;
}

export interface RuntimeStartOptions {
  /** Absolute path of the workspace root (`resolveWorkspace().root`). */
  readonly workspaceRoot: string;
  /** The capability set the server resolved at boot. */
  readonly enabledCapabilities: ReadonlySet<Capability>;
  /** Host hooks (see {@link RuntimeHostHooks}). */
  readonly host: RuntimeHostHooks;
  /** Optional extra plugin names declared via the config store
   *  (`set_config({plugins})`). Unioned with the `plugins.json`
   *  declaration. */
  readonly extraDeclared?: ReadonlyArray<string>;
}

export interface RuntimeStartResult {
  /** Per-declared-plugin record (loaded OR disabled OR errored). */
  readonly plugins: ReadonlyArray<PluginRecord>;
  /** Total tools registered by loaded plugins. */
  readonly toolCount: number;
}

/**
 * Top-level entry point: read the declaration, resolve manifests,
 * validate the graph, load each plugin in dep-order.
 *
 * Throws ONLY on cycle errors (server start aborts — the contract). All
 * other failures (capability mismatch, missing dep, validation error,
 * load-time exception) downgrade the affected plugin to a non-loaded
 * status and continue.
 */
export async function startPluginRuntime(
  opts: RuntimeStartOptions,
): Promise<RuntimeStartResult> {
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
    return { plugins: [], toolCount: 0 };
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
  const validResolved = new Map<
    string,
    Extract<ResolveResult, { kind: "resolved" }>["manifest"]
  >();
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
  let depResult;
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

  // Stage 5: load each plugin in dep-order.
  // Note: skipped (capability-mismatched) plugins still consume their slot
  // in the order — their dependents will fail later if they actually call
  // a tool the skipped plugin owns, but the LOAD itself doesn't fail.
  const records: PluginRecord[] = [];
  const liveTools = new Map<string, PluginToolRecord>();
  let toolCount = 0;
  const transitiveDeps = depResult.transitiveDeps;
  const ownerOf = (toolName: string): string | undefined => {
    const t = liveTools.get(toolName);
    if (t) return t.ownerPlugin;
    return opts.host.ownerOf(toolName);
  };

  for (const name of depResult.loadOrder) {
    const m = validResolved.get(name)!;
    const reason = capFail.get(name);
    if (reason) {
      records.push({
        manifest: m,
        status: "disabled-by-capability-mismatch",
        tools: [],
        transitiveDeps: [...(transitiveDeps.get(name) ?? new Set())],
        statusReason: reason,
        declaredCapabilities: m.browxai.capabilities,
        declaredAt,
      });
      log.warn(`plugin runtime: ${name} disabled — ${reason}`);
      continue;
    }
    const myToolNames: string[] = [];
    const myDeps = transitiveDeps.get(name) ?? new Set<string>();
    const callTool = async (
      targetName: string,
      args?: Record<string, unknown>,
    ): Promise<PluginToolResponse> => {
      // Core tools: always allowed (implicit-root).
      if (opts.host.isCoreTool(targetName)) {
        return opts.host.dispatch(targetName, args ?? {});
      }
      const targetOwner = ownerOf(targetName);
      if (!targetOwner) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: `plugin "${name}" tried to call unknown tool "${targetName}"`,
                  code: PLUGIN_CALL_GRAPH_VIOLATION,
                  fromPlugin: name,
                  targetTool: targetName,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      // Owner-call: a plugin may always call its own tools.
      if (targetOwner === name) {
        return opts.host.dispatch(targetName, args ?? {});
      }
      // Declared-graph check.
      if (!myDeps.has(targetOwner)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: `plugin call-graph violation: ${name} tried to call ${targetOwner}.${targetName.slice(
                    targetName.indexOf(".") + 1,
                  )} but did not declare ${targetOwner} in dependsOn`,
                  code: PLUGIN_CALL_GRAPH_VIOLATION,
                  fromPlugin: name,
                  targetPlugin: targetOwner,
                  targetTool: targetName,
                  declaredDeps: [...myDeps].sort(),
                  hint:
                    `Add { "plugin": "${targetOwner}", "version": "^${(validResolved.get(targetOwner) ?? { version: "0.0.0" }).version}" } to ` +
                    `the "dependsOn" array in this plugin's package.json#browxai field, reinstall (pnpm install in the plugin's repo), and restart the browxai server.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return opts.host.dispatch(targetName, args ?? {});
    };

    const api: PluginApi = {
      namespace: m.browxai.namespace,
      declaredCapabilities: m.browxai.capabilities,
      registerTool: (toolName, def, handler) => {
        if (!toolName.startsWith(`${m.browxai.namespace}.`)) {
          throw new Error(
            `plugin "${name}": tool "${toolName}" must be prefixed with "${m.browxai.namespace}." — namespace prefix is mandatory. ` +
              `Plugins cannot override or wrap core browxai tools.`,
          );
        }
        if (toolName === `${m.browxai.namespace}.`) {
          throw new Error(
            `plugin "${name}": tool name has empty suffix after the namespace — pass a real tool name like "${m.browxai.namespace}.do_thing".`,
          );
        }
        if (liveTools.has(toolName) || opts.host.isCoreTool(toolName)) {
          throw new Error(
            `plugin "${name}": tool "${toolName}" is already registered. Tool names are globally unique.`,
          );
        }
        // The plugin's capability is the gate for ALL its tools. The
        // simple v1 contract — fine-grained per-tool capabilities can
        // be layered on top later without breaking this signature.
        // If the plugin declared more than one capability, the gate is
        // the FIRST one (semantic: "this tool needs at least these
        // caps"; declaring multiple is an additive claim). We pass it
        // through to the host's gate so an MCP call against the tool
        // refuses cleanly when the capability isn't on.
        const cap = m.browxai.capabilities[0];
        const record: PluginToolRecord = {
          name: toolName,
          ownerPlugin: name,
          ...(cap !== undefined ? { capability: cap } : {}),
          description: def.description,
          ...(def.inputSchema !== undefined ? { inputSchema: def.inputSchema } : {}),
        };
        liveTools.set(toolName, record);
        myToolNames.push(toolName);
        opts.host.registerTool(toolName, def, handler, cap, name);
      },
      callTool,
      log: {
        info: (msg, meta) =>
          log.info(`plugin[${m.browxai.namespace}]: ${msg}`, { plugin: name, ...(meta ?? {}) }),
        warn: (msg, meta) =>
          log.warn(`plugin[${m.browxai.namespace}]: ${msg}`, { plugin: name, ...(meta ?? {}) }),
        error: (msg, meta) =>
          log.error(`plugin[${m.browxai.namespace}]: ${msg}`, { plugin: name, ...(meta ?? {}) }),
      },
    };

    let loaded = false;
    let loadError: string | undefined;
    try {
      const mod = (await import(pathToFileURL(m.entryPath).href)) as {
        default?: PluginRegisterFn;
        register?: PluginRegisterFn;
      };
      const fn = mod.register ?? mod.default;
      if (typeof fn !== "function") {
        throw new Error(
          `entry module ${m.entryPath} must export a \`register(api)\` function (named or default).`,
        );
      }
      await fn(api);
      loaded = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      log.warn(`plugin runtime: ${name} failed to load — ${loadError}`);
    }

    const status: PluginStatus = loaded ? "loaded" : "load-error";
    records.push({
      manifest: m,
      status,
      tools: [...myToolNames],
      transitiveDeps: [...myDeps].sort(),
      ...(status === "loaded" ? {} : { statusReason: loadError ?? "unknown load error" }),
      declaredCapabilities: m.browxai.capabilities,
      declaredAt,
      ...(loaded ? { enabledAt: new Date().toISOString() } : {}),
    });
    if (loaded) toolCount += myToolNames.length;
  }

  return {
    plugins: [...records, ...earlyDisabled].sort((a, b) =>
      a.manifest.name.localeCompare(b.manifest.name),
    ),
    toolCount,
  };
}

/**
 * Lookup table accessor exposed for the `plugins_info` MCP tool. The
 * runtime holds an internal `liveTools` map; the result of
 * {@link startPluginRuntime} is the structured surface — this helper is
 * just for callers wanting the tool registry view on a plugin.
 */
export function toolsForPlugin(
  records: ReadonlyArray<PluginRecord>,
  pluginName: string,
): ReadonlyArray<string> {
  const rec = records.find((r) => r.manifest.name === pluginName);
  return rec?.tools ?? [];
}
