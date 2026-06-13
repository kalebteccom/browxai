import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

import { startPluginRuntime } from "../plugin/runtime.js";
import type { PluginRecord, PluginToolHandler, PluginToolResponse } from "../plugin/types.js";
import { RUNTIME_API_VERSION } from "../plugin/manifest.js";
import type { Capability } from "../util/capabilities.js";
import { log } from "../util/logging.js";
import type { ToolHost, ToolResponse } from "./host.js";

/** The createServer-owned pieces the plugin runtime needs that the shared
 *  `ToolHost` doesn't surface: the raw MCP server (for plugin-tool
 *  registration) and the per-dispatch metrics/diagnostics noters (plugin tools
 *  ride the same accounting path as core tools, minus the wedge tracker). */
export interface PluginRuntimeDeps {
  server: McpServer;
  noteMetrics: (toolName: string, args: unknown, res: ToolResponse, startedAt: number) => void;
  noteDiagnostics: (toolName: string, args: unknown, res: ToolResponse, startedAt: number) => void;
}

/**
 * Plugin runtime wiring — the LAST step of `createServer`, run after every core
 * `register*Tools(host)` call so the `coreToolNames` snapshot below counts the
 * full core surface as "core" and plugins load on top of it.
 *
 * Plugins are loaded ONCE here. Cycle detection is fatal; everything else
 * (capability mismatch, missing dep, malformed manifest, load-time exception)
 * downgrades the affected plugin to a non-`loaded` status and surfaces on
 * `plugins_list`. `set_config({plugins})` persists into the config store but
 * takes effect on NEXT server restart — mirroring the capability lifecycle.
 *
 * Returns the loaded `PluginRecord[]`; `createServer` assigns it to the
 * `pluginRecords` local that `get_config` reports the live enabled-plugin set
 * from (via the host getter).
 */
export async function wirePluginRuntime(
  host: ToolHost,
  deps: PluginRuntimeDeps,
): Promise<ReadonlyArray<PluginRecord>> {
  const { register, caps, workspace, resolvedConfig, toolHandlers, z } = host;
  const { server, noteMetrics, noteDiagnostics } = deps;

  let pluginRecords: ReadonlyArray<PluginRecord> = [];

  /** Per-plugin-tool capability map. Populated as the runtime registers
   *  tools; `isToolEnabled` consults this first for namespaced tools and
   *  falls back to the core map otherwise. */
  const pluginToolCapability = new Map<string, Capability | undefined>();
  /** Per-plugin-tool ownership map (tool → plugin npm name). Mirrors the
   *  runtime's internal liveTools registry so the host-side `ownerOf`
   *  hook can answer "who owns tool X" without crossing the runtime
   *  boundary. */
  const pluginToolOwner = new Map<string, string>();
  /** Per-plugin-tool def cache — keeps the description + input schema
   *  so `plugins_info` can dump the registered shape. */
  const pluginToolDef = new Map<
    string,
    { description: string; inputSchema?: Record<string, z.ZodTypeAny> | undefined }
  >();
  // Snapshot of core tool names at this point — anything registered
  // BEFORE plugin loading is a core tool from the plugin runtime's point
  // of view.
  const coreToolNames = new Set(Object.keys(toolHandlers));

  // Wrap `gateCheck` for plugin tools by patching the active gate
  // check pipeline. We can't reuse the core `gateCheck` directly — it
  // consults `TOOL_CAPABILITY` for the core surface only. The wrapper
  // injected on every plugin tool registration does the check inline.
  const pluginGate = (
    toolName: string,
  ): { content: Array<{ type: "text"; text: string }> } | null => {
    const cap = pluginToolCapability.get(toolName);
    if (cap === undefined) return null; // no capability declared → allowed
    if (caps.enabled.has(cap)) return null;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: false,
              error: `plugin tool "${toolName}" is disabled — its declared capability is not in the server's ACTIVE set`,
              requiredCapability: cap,
              activeCapabilities: [...caps.enabled],
              hint:
                "Plugin-declared capabilities are gated the same way as core tools — add the capability to BROWX_CAPABILITIES " +
                "(or set_config({capabilities:[...]})) and RESTART the browxai server.",
            },
            null,
            2,
          ),
        },
      ],
    };
  };

  const registerPluginTool = (
    name: string,
    def: { description: string; inputSchema?: Record<string, z.ZodTypeAny> | undefined },
    handler: PluginToolHandler,
    capability: string | undefined,
    ownerPlugin: string,
  ): void => {
    if (capability !== undefined) {
      pluginToolCapability.set(name, capability as Capability);
    } else {
      pluginToolCapability.set(name, undefined);
    }
    pluginToolOwner.set(name, ownerPlugin);
    pluginToolDef.set(name, def);
    // Plugin tool handler envelope: capability gate → handler → standard
    // metrics + diagnostics wrap. We don't apply the wedge tracker —
    // plugin tools aren't core page-exercising primitives, so the
    // session-wedged stamping path is reserved for browser-touching
    // tools the host owns.
    const wrapped: (args: unknown) => Promise<ToolResponse> = async (args: unknown) => {
      const startedAt = Date.now();
      const gated = pluginGate(name);
      if (gated) return gated;
      let inner: PluginToolResponse;
      try {
        inner = await handler(args);
      } catch (e) {
        inner = {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: `plugin tool "${name}" threw: ${e instanceof Error ? e.message : String(e)}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      // PluginToolResponse content items match ToolResponse exactly — same
      // shape, kept as parallel types only to draw the API boundary.
      const out: ToolResponse = { content: [...inner.content] };
      noteMetrics(name, args, out, startedAt);
      noteDiagnostics(name, args, out, startedAt);
      return out;
    };
    toolHandlers[name] = wrapped;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(name, def, wrapped);
  };

  try {
    const result = await startPluginRuntime({
      workspaceRoot: workspace.root,
      enabledCapabilities: caps.enabled,
      extraDeclared: resolvedConfig.plugins,
      host: {
        isCoreTool: (n) => coreToolNames.has(n),
        dispatch: async (n, args) => {
          const fn = toolHandlers[n];
          if (!fn) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { ok: false, error: `dispatch: unknown tool "${n}"` },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          const res = await fn(args);
          return { content: [...res.content] };
        },
        registerTool: registerPluginTool,
        ownerOf: (n) => {
          if (coreToolNames.has(n)) return undefined;
          return pluginToolOwner.get(n);
        },
      },
    });
    pluginRecords = result.plugins;
    const loaded = pluginRecords.filter((p) => p.status === "loaded");
    log.info("plugin runtime: loaded", {
      apiVersion: RUNTIME_API_VERSION,
      pluginsDeclared: pluginRecords.length,
      pluginsLoaded: loaded.length,
      toolsRegistered: result.toolCount,
    });
    for (const p of pluginRecords) {
      if (p.status !== "loaded") {
        log.warn(`plugin runtime: ${p.manifest.name} status=${p.status} — ${p.statusReason ?? ""}`);
      }
    }
  } catch (e) {
    // Cycle errors and only cycle errors abort startup loudly. All other
    // failures get downgraded inside startPluginRuntime to a per-plugin
    // load-error record.
    log.error(`plugin runtime: fatal — ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }

  // plugins_list / plugins_info MCP tools ( surface).
  register(
    "plugins_list",
    {
      description:
        "List every declared browxai plugin and its load status. Each entry carries `{name, namespace, version, trust, capabilities, dependsOn, status, declaredAt, enabledAt?, statusReason?, tools, transitiveDeps}`. `status` is one of `loaded` (live), `disabled-by-capability-mismatch` (plugin declares a capability not in the server's active set), `disabled-by-cycle` (caught at startup — server start would have aborted, so this status only appears in test surfaces), `disabled-by-dep-missing` (a `dependsOn` target isn't installed or fails the version range), `disabled-by-namespace-conflict` (two plugins claimed the same namespace), or `load-error` (manifest invalid, entry module threw, etc.). Read-only — gates under `read`. The plugin runtime is RESOLVED ONCE AT SERVER START; this tool reports the live state, not what `plugins.json` currently declares (use `get_config({scope:'resolved'}).plugins` for that, plus the `pluginsPendingRestart` flag).",
      inputSchema: {},
    },
    async () => {
      const body = {
        ok: true,
        apiVersion: RUNTIME_API_VERSION,
        plugins: pluginRecords.map((p) => ({
          name: p.manifest.name,
          namespace: p.manifest.browxai.namespace || null,
          version: p.manifest.version,
          trust: p.manifest.trust,
          capabilities: p.declaredCapabilities,
          dependsOn: p.manifest.browxai.dependsOn,
          status: p.status,
          declaredAt: p.declaredAt,
          ...(p.enabledAt ? { enabledAt: p.enabledAt } : {}),
          ...(p.statusReason ? { statusReason: p.statusReason } : {}),
          tools: p.tools,
          transitiveDeps: p.transitiveDeps,
        })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "plugins_info",
    {
      description:
        "Full manifest + tool registry dump for ONE plugin. Returns `{name, version, namespace, trust, capabilities, dependsOn, transitiveDeps, status, tools: [{name, description, inputSchema?}]}` so an operator can audit what a plugin contributes to the running surface. Read-only — gates under `read`.",
      inputSchema: {
        name: z
          .string()
          .describe('npm package name of the plugin (e.g. "@browxai/plugin-example").'),
      },
    },
    async ({ name }: { name: string }) => {
      const p = pluginRecords.find((r) => r.manifest.name === name);
      if (!p) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `plugin "${name}" is not in the declared set`,
                  declared: pluginRecords.map((r) => r.manifest.name),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const tools = p.tools.map((tName) => {
        const def = pluginToolDef.get(tName);
        return {
          name: tName,
          description: def?.description ?? null,
          // Best-effort schema introspection — Zod schemas are runtime
          // objects, but we can surface the field names so the operator
          // sees the input shape. Full JSON-Schema lowering is deferred.
          inputFields: def?.inputSchema ? Object.keys(def.inputSchema).sort() : [],
        };
      });
      const body = {
        ok: true,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description ?? null,
        path: p.manifest.path,
        entryPath: p.manifest.entryPath,
        namespace: p.manifest.browxai.namespace || null,
        trust: p.manifest.trust,
        capabilities: p.declaredCapabilities,
        dependsOn: p.manifest.browxai.dependsOn,
        transitiveDeps: p.transitiveDeps,
        status: p.status,
        statusReason: p.statusReason ?? null,
        declaredAt: p.declaredAt,
        enabledAt: p.enabledAt ?? null,
        apiVersion: p.manifest.browxai.apiVersion,
        browxaiVersion: p.manifest.browxai.browxaiVersion ?? null,
        tools,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  return pluginRecords;
}
