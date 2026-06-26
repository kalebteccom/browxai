// Host-seam contracts for the plugin runtime — the interfaces wiring the
// runtime to the host server: the hooks the host provides (capability
// gate, dispatch, tool registration, owner lookup) plus the start-time
// options + result shapes.
//
// These live in a leaf module so the call-graph enforcement and the
// validation pipeline can both depend on `RuntimeHostHooks` without
// importing back through the `runtime.js` barrel (which re-exports them).

import type { z } from "zod";
import type { Capability } from "../util/capabilities.js";
import type { PluginRecord, PluginToolHandler, PluginToolResponse } from "./types.js";

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
