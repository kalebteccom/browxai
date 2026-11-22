// What the daemon's `tools/list` says about each tool: a real one-line description and
// the capability the tool needs, so `browxai tools` can print both without a second
// source. The description is the first sentence of the one the tool registered with,
// and the capability is the one the call-time gate reads. A tool with no registration
// record is a plugin tool: its own description and capability stay inside the plugin
// runtime, so it is listed with a fixed line and the `plugin` label.

import { NO_CAPABILITY, PLUGIN_GROUP, summaryOf } from "../tools/tool-catalog-tools.js";
import type { ToolRegistration } from "../tools/host.js";

/** The `_meta` key that carries a tool's capability in a `tools/list` entry. */
export const CAPABILITY_META_KEY = "browxai/capability";

/** The description shown for a plugin tool. */
export const PLUGIN_TOOL_SUMMARY = "A plugin tool.";

/** One row of a tool listing, as `browxai tools` prints it. */
export interface ToolRow {
  readonly name: string;
  /** A capability name, `none` for a tool that declares none, or `plugin`. */
  readonly capability: string;
  readonly description: string;
}

/** The row for one tool, from its registration record (`undefined` for a plugin tool). */
export function toolRow(name: string, reg: ToolRegistration | undefined): ToolRow {
  return {
    name,
    capability: reg === undefined ? PLUGIN_GROUP : (reg.capability ?? NO_CAPABILITY),
    description: reg === undefined ? PLUGIN_TOOL_SUMMARY : summaryOf(reg.description),
  };
}

/** The `tools/list` entry for one tool. The input schema stays open: the handler
 *  validates, and a closed schema would strip arguments on this path. */
export function listedTool(name: string, reg: ToolRegistration | undefined) {
  const row = toolRow(name, reg);
  return {
    name,
    description: row.description,
    inputSchema: { type: "object" as const, additionalProperties: true },
    _meta: { [CAPABILITY_META_KEY]: row.capability },
  };
}
