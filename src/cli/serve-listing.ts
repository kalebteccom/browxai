// What the daemon's `tools/list` says about each tool: the full description, the real
// input schema and the capability the tool needs. An MCP client behind `browxai bridge`
// reads the description and the schema as it would from the stdio server, and
// `browxai tools` prints the name, the capability and the first sentence. All three
// come from the tool's registration record, and the capability is the one the call-time
// gate reads. A tool with no registration record is a plugin tool: its own description,
// schema and capability stay inside the plugin runtime, so it is listed with a fixed
// line, an open schema and the `plugin` label.

import { z } from "zod";
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

/** The schema listed when a tool has none to show: any object. */
const OPEN_SCHEMA = { type: "object" as const, additionalProperties: true };

/** A tool's input schema as JSON Schema, or undefined when it cannot be converted. */
export function inputSchemaOf(reg: ToolRegistration): Record<string, unknown> | undefined {
  try {
    const shape = reg.inputSchema ?? {};
    const schema: Record<string, unknown> = {
      ...z.toJSONSchema(z.object(shape), { unrepresentable: "any", io: "input" }),
    };
    delete schema.$schema;
    return schema;
  } catch {
    return undefined;
  }
}

/** The `tools/list` entry for one tool: its full description, its input schema and its
 *  capability in `_meta`. The schema describes the arguments and does not filter them:
 *  the daemon's `tools/call` handler passes the arguments through as sent, and the
 *  tool's own handler validates. A plugin tool, or a schema that cannot be converted,
 *  is listed with an open schema. */
export function listedTool(name: string, reg: ToolRegistration | undefined) {
  const schema = reg === undefined ? undefined : inputSchemaOf(reg);
  return {
    name,
    description: reg === undefined ? PLUGIN_TOOL_SUMMARY : reg.description,
    inputSchema: schema === undefined ? OPEN_SCHEMA : { ...schema, type: "object" as const },
    _meta: { [CAPABILITY_META_KEY]: toolRow(name, reg).capability },
  };
}
