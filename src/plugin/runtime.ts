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
// Stages 1–8 (the pure manifest-validation pipeline) live in
// `validate.js`; the call-graph enforcement that backs `api.callTool`
// lives in `call-graph.js`. This module keeps the orchestration: wiring
// each plugin's `PluginApi`, dynamic-importing entries, and assembling
// the result records. The original export surface is preserved here via
// the re-exports below.
//
// In-process JS modules only (v1). No out-of-process plugin processes.
// Resolved-once-at-server-start. No hot reload — restart is the contract.

import { pathToFileURL } from "node:url";
import { log } from "../util/logging.js";
import { makeCallTool } from "./call-graph.js";
import { validatePlugins } from "./validate.js";
import type { RuntimeStartOptions, RuntimeStartResult } from "./host-hooks.js";
import type {
  PluginApi,
  PluginRecord,
  PluginRegisterFn,
  PluginStatus,
  PluginToolRecord,
} from "./types.js";

// Re-export the host seam + call-graph + validation symbols so the
// original `./runtime.js` public surface is preserved byte-for-byte for
// importers and colocated tests.
export { PLUGIN_CALL_GRAPH_VIOLATION } from "./call-graph.js";
export type { RuntimeHostHooks, RuntimeStartOptions, RuntimeStartResult } from "./host-hooks.js";

/**
 * Top-level entry point: read the declaration, resolve manifests,
 * validate the graph, load each plugin in dep-order.
 *
 * Throws ONLY on cycle errors (server start aborts — the contract). All
 * other failures (capability mismatch, missing dep, validation error,
 * load-time exception) downgrade the affected plugin to a non-loaded
 * status and continue.
 */
export async function startPluginRuntime(opts: RuntimeStartOptions): Promise<RuntimeStartResult> {
  // Stages 1–8: pure manifest validation (throws only on a dep cycle).
  const plan = validatePlugins(opts);
  if (plan.declaredCount === 0) {
    return { plugins: [], toolCount: 0 };
  }
  const { validResolved, earlyDisabled, depResult, capFail, declaredAt } = plan;

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
    // Call-graph enforcement lives in `call-graph.js`. The gate decides
    // ALLOW vs REFUSE and, on ALLOW, dispatches through `opts.host` —
    // never bypassing the host's own capability gate.
    const callTool = makeCallTool({
      name,
      myDeps,
      host: opts.host,
      ownerOf,
      versionOf: (pluginName) => validResolved.get(pluginName)?.version,
    });

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
