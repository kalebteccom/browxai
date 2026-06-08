// Shared types for the plugin runtime — the surface a plugin author
// codes against (the `register(api)` argument) and the surface the host
// server consumes (registered tool definitions + status records).

import type { z } from "zod";
import type { ResolvedManifest } from "./manifest.js";

/**
 * MCP-style tool response. Same shape as the host's internal
 * `ToolResponse` — plugin tools return this verbatim and the runtime
 * forwards it through the MCP / SDK surface without rewriting.
 */
export interface PluginToolResponse {
  readonly content: ReadonlyArray<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
}

/** Tool handler signature. Plugin authors implement this. */
export type PluginToolHandler = (args: unknown) => Promise<PluginToolResponse>;

/**
 * The runtime API surface a plugin receives in its `register(api)` call.
 * Stable across the runtime's API major version (`apiVersion` in the
 * manifest).
 */
export interface PluginApi {
  /** The plugin's own namespace, as declared in its manifest. */
  readonly namespace: string;

  /** The capabilities the plugin declared. (Already verified subset.) */
  readonly declaredCapabilities: ReadonlyArray<string>;

  /**
   * Register a tool. The name MUST start with `<namespace>.` — passing
   * anything else (or the bare namespace alone) throws synchronously.
   *
   *   - `name`         The full tool name (`figma.move_node`). Will appear
   *                    on MCP `tools/list` exactly as given.
   *   - `def`          Tool description + optional input schema. The
   *                    schema is the same `inputSchema` shape host tools
   *                    use — a `Record<string, z.ZodTypeAny>`. Pass an
   *                    empty object (or omit) for argless tools.
   *   - `handler`      Async function returning the MCP envelope. The
   *                    runtime applies the per-tool capability gate +
   *                    diagnostics + metrics wrapping the same as for
   *                    core tools.
   */
  registerTool(
    name: string,
    def: { description: string; inputSchema?: Record<string, z.ZodTypeAny> | undefined },
    handler: PluginToolHandler,
  ): void;

  /**
   * Call another tool by name (a core browxai tool or a tool registered
   * by a plugin in this plugin's transitively-declared `dependsOn`
   * graph). Calls outside the declared graph fail with a structured
   * error.
   *
   * Capability gates fire as if the call came in from MCP — a plugin
   * cannot call a tool whose capability isn't enabled on the host.
   */
  callTool(name: string, args?: Record<string, unknown>): Promise<PluginToolResponse>;

  /**
   * Plugin-scoped logger. Output is funnelled through the host's
   * structured logger with `plugin=<namespace>` attached. Plugins should
   * NOT write to stdout/stderr directly — stdout is the MCP wire.
   */
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * The function shape a plugin's entry module must export — either as
 * the default export or as a named `register`.
 */
export type PluginRegisterFn = (api: PluginApi) => void | Promise<void>;

/**
 * The post-load status of one plugin. Surfaced verbatim via
 * `plugins_list` so an operator can see why anything didn't load.
 */
export type PluginStatus =
  | "loaded"
  | "disabled-by-capability-mismatch"
  | "disabled-by-cycle"
  | "disabled-by-dep-missing"
  | "disabled-by-namespace-conflict"
  | "load-error";

export interface PluginRecord {
  /** Resolved manifest (npm name, version, etc.). */
  readonly manifest: ResolvedManifest;
  /** Live status. */
  readonly status: PluginStatus;
  /** Tools registered by this plugin (`<namespace>.<tool>` names). */
  readonly tools: ReadonlyArray<string>;
  /** Transitive `dependsOn` closure (plugin names). */
  readonly transitiveDeps: ReadonlyArray<string>;
  /** Status-explainer (only populated for non-`loaded` statuses). */
  readonly statusReason?: string;
  /** Capabilities this plugin DECLARED. */
  readonly declaredCapabilities: ReadonlyArray<string>;
  /** ISO timestamp of when the manifest was read off disk. */
  readonly declaredAt: string;
  /** ISO timestamp of when this plugin loaded. Only set when status === "loaded". */
  readonly enabledAt?: string;
}

/**
 * Per-tool registration record — the runtime keeps one of these per
 * plugin tool so it can route capability gating + call-graph
 * enforcement against the right owner.
 */
export interface PluginToolRecord {
  /** Full tool name (`<namespace>.<tool>`). */
  readonly name: string;
  /** Plugin (npm package name) that registered it. */
  readonly ownerPlugin: string;
  /** Capability gate for this tool (subset of the plugin's declaredCapabilities). */
  readonly capability?: string | undefined;
  /** Description + input schema (passed to MCP tools/list). */
  readonly description: string;
  readonly inputSchema?: Record<string, z.ZodTypeAny> | undefined;
}
