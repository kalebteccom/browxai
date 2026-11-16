// The `toolList` config key: which tools `tools/list` reports.
//
// `all` (default) lists every registered tool, including the ones whose capability
// is off. A disabled tool refuses at call time with a hint that says how to enable
// it, so an agent that sees it listed can learn what to ask the operator for.
// `enabled` lists only the tools the server can run. A tool that is left out still
// answers a call by name with the same refusal and hint: this module changes what
// is listed and nothing about what is callable.
//
// The capability behind each tool is the one the call-time gate reads:
// `isToolEnabled` for core tools, and the capability a plugin declared for its own
// tools. Capabilities are read once at server start, so the answer does not change
// while the server runs and no `tools/list_changed` notification is needed.

import {
  capabilityMissing,
  isToolEnabled,
  type Capability,
  type CapabilityConfig,
} from "./capabilities.js";

export const TOOL_LIST_MODES = ["all", "enabled"] as const;
export type ToolListMode = (typeof TOOL_LIST_MODES)[number];

export function isToolListMode(value: unknown): value is ToolListMode {
  return typeof value === "string" && (TOOL_LIST_MODES as readonly string[]).includes(value);
}

/** Parse a `BROWX_TOOL_LIST` value. Unset or blank gives `undefined`; an unknown
 *  value throws, so a typo stops the server at start. */
export function parseToolList(
  raw: string | undefined,
  source = "BROWX_TOOL_LIST",
): ToolListMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (isToolListMode(value)) return value;
  throw new Error(
    `${source}: unknown value ${JSON.stringify(raw?.trim())}. Valid: ${TOOL_LIST_MODES.join(", ")}. ` +
      "Fix the spelling or remove the entry, then restart the server.",
  );
}

export interface ToolListing {
  readonly mode: ToolListMode;
  /** Whether `tools/list` should report this tool. Always true in `all` mode. */
  isListed: (tool: string) => boolean;
  /** Record the capability a plugin declared for one of its tools. */
  notePluginTool: (tool: string, capability: Capability | undefined) => void;
}

export function createToolListing(mode: ToolListMode, caps: CapabilityConfig): ToolListing {
  const pluginTools = new Map<string, Capability | undefined>();
  return {
    mode,
    isListed: (tool) => {
      if (mode === "all") return true;
      if (pluginTools.has(tool)) {
        const capability = pluginTools.get(tool);
        return capability === undefined || !capabilityMissing(capability, caps);
      }
      return isToolEnabled(tool, caps);
    },
    notePluginTool: (tool, capability) => {
      pluginTools.set(tool, capability);
    },
  };
}
