// Plugin call-graph enforcement — the SECURITY-RELEVANT gate that
// decides whether one plugin's `api.callTool` may reach a given target.
//
// This is the unit-testable core of the runtime's cross-plugin contract:
//   - Core tools are always callable (implicit-root).
//   - A plugin may always call its OWN tools.
//   - A plugin may call another plugin's tool ONLY if that plugin's
//     owner appears in this plugin's transitively-declared `dependsOn`
//     closure.
// Every refusal returns the structured PLUGIN_CALL_GRAPH_VIOLATION
// envelope below — the shape is part of the security contract and is
// asserted byte-for-byte by callers + tests.
//
// The actual dispatch ALWAYS routes through `host.dispatch`, which is
// where the host re-applies its capability gate / diagnostics / metrics.
// This module decides ALLOW vs REFUSE; it never weakens or bypasses the
// host's own gate — an allowed call is still gated downstream by the host.

import type { RuntimeHostHooks } from "./host-hooks.js";
import type { PluginToolResponse } from "./types.js";

/** Error code emitted when a plugin's `api.callTool` violates the call graph. */
export const PLUGIN_CALL_GRAPH_VIOLATION = "plugin-call-graph-violation";

/** Inputs the call-graph factory needs to enforce one plugin's graph. */
export interface CallToolContext {
  /** npm name of the calling plugin (used in every violation envelope). */
  readonly name: string;
  /** The calling plugin's transitively-declared `dependsOn` closure. */
  readonly myDeps: ReadonlySet<string>;
  /** Host hooks — `isCoreTool` + `dispatch` are routed through unchanged. */
  readonly host: RuntimeHostHooks;
  /**
   * Resolve the owning plugin of a tool name (live plugin tools first,
   * then host-side core/earlier-batch lookup). Returns `undefined` for
   * unknown names.
   */
  readonly ownerOf: (toolName: string) => string | undefined;
  /**
   * Resolve a target plugin's installed version, used to build the
   * remediation `hint` in a declared-graph violation. Returns
   * `undefined` if the version can't be looked up (the hint falls back
   * to `0.0.0`).
   */
  readonly versionOf: (pluginName: string) => string | undefined;
}

/**
 * Build the `api.callTool` implementation for ONE plugin. The returned
 * function enforces the call graph and then — only on ALLOW — dispatches
 * through `host.dispatch`, which re-applies the host's capability gate.
 *
 * SECURITY: the order of checks (core → unknown → owner → declared-graph)
 * and the structured violation envelopes must not change. Any refusal is
 * a `PLUGIN_CALL_GRAPH_VIOLATION` envelope; the only paths that reach
 * `host.dispatch` are core tools, owner-calls, and declared deps.
 */
export function makeCallTool(
  ctx: CallToolContext,
): (targetName: string, args?: Record<string, unknown>) => Promise<PluginToolResponse> {
  const { name, myDeps, host, ownerOf, versionOf } = ctx;
  return async (
    targetName: string,
    args?: Record<string, unknown>,
  ): Promise<PluginToolResponse> => {
    // Core tools: always allowed (implicit-root).
    if (host.isCoreTool(targetName)) {
      return host.dispatch(targetName, args ?? {});
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
      return host.dispatch(targetName, args ?? {});
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
                  `Add { "plugin": "${targetOwner}", "version": "^${versionOf(targetOwner) ?? "0.0.0"}" } to ` +
                  `the "dependsOn" array in this plugin's package.json#browxai field, reinstall (pnpm install in the plugin's repo), and restart the browxai server.`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    return host.dispatch(targetName, args ?? {});
  };
}
