// The `tool_catalog` discovery tool.
//
// Registered only when the `toolProfile` config key is `core`. It names every tool
// the server registers and `tools/list` leaves out, grouped by capability, with a
// one-line summary each, and says how to reach them. The tool belongs to no
// capability, so the capability gate always lets it run. Under the `full` profile
// the profile leaves nothing out, so it is not registered and the default listing
// has no discovery tool.
//
// The omitted set is computed from the same predicate `tools/list` uses
// (`ToolListing.isListed`), at call time, so the two cannot disagree. One optional
// `capability` argument narrows the reply to a single group of that set. A name that
// is not a group of the set throws an error that lists the valid groups with counts.

import { z } from "zod";
import { capabilityMissing, type Capability } from "../util/capabilities.js";
import { TOOL_CATALOG_TOOL } from "../util/tool-profile.js";
import type { ConfigHost, RegisterHost, ServerServicesHost } from "./host.js";
import { jsonResult } from "./json-result.js";

/** Group label for tools that declare no capability (session lifecycle, `batch`, config). */
export const NO_CAPABILITY = "none";
/** Group label for a tool with no registration record: a plugin tool. */
export const PLUGIN_GROUP = "plugin";

/** The first sentence of a tool description, cut to `max` characters. */
export function summaryOf(description: string, max = 140): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end === -1 ? flat : flat.slice(0, end + 1);
  return first.length > max ? `${first.slice(0, max - 3).trimEnd()}...` : first;
}

export function registerToolCatalogTool(
  host: RegisterHost & ConfigHost & ServerServicesHost,
  isListed: (tool: string) => boolean,
): void {
  const { register, registrations, caps, toolHandlers } = host;

  register(
    TOOL_CATALOG_TOOL,
    {
      description:
        "List the tools this server registers but `tools/list` leaves out under the `core` profile, grouped by capability, with a one-line summary each. Every one stays callable by name, through the same capability gate. Takes one optional `capability` to list a single group. Set `toolProfile` to `full` and restart the server to list the ones the server can run.",
      inputSchema: {
        capability: z
          .string()
          .optional()
          .describe("Group to list: a capability name, `none` or `plugin`. Omit for all groups."),
      },
    },
    async ({ capability: only }) => {
      const groups = new Map<string, Array<{ name: string; summary: string }>>();
      let omitted = 0;
      for (const name of Object.keys(toolHandlers).sort()) {
        if (isListed(name)) continue;
        const reg = registrations.get(name);
        const group = reg ? (reg.capability ?? NO_CAPABILITY) : PLUGIN_GROUP;
        const rows = groups.get(group) ?? [];
        rows.push({ name, summary: reg ? summaryOf(reg.description) : "A plugin tool." });
        groups.set(group, rows);
        omitted += 1;
      }
      const ordered = [...groups.keys()].sort((a, b) => {
        const last = (g: string) => (g === NO_CAPABILITY || g === PLUGIN_GROUP ? 1 : 0);
        return last(a) - last(b) || a.localeCompare(b);
      });
      if (only !== undefined && !groups.has(only)) {
        const valid = ordered.map((g) => `${g} (${groups.get(g)?.length ?? 0})`).join(", ");
        throw new Error(
          `tool_catalog: "${only}" is not a group of omitted tools. Valid groups, with tool counts: ${valid}. Omit capability to list every group.`,
        );
      }
      const shown = only === undefined ? ordered : [only];
      const body = {
        profile: "core",
        omitted: only === undefined ? omitted : (groups.get(only)?.length ?? 0),
        ...(only === undefined ? {} : { capability: only }),
        note:
          "These tools are registered and callable by name, through the same capability gate as every listed tool. " +
          "A group with enabled false needs its capability added to BROWX_CAPABILITIES first. " +
          "To list the tools the server can run, set BROWX_TOOL_PROFILE=full (or toolProfile to full with set_config) and restart the browxai server. " +
          "Tools whose capability is off stay out of the listing until BROWX_TOOL_LIST=all is set too.",
        groups: shown.map((capability) => ({
          capability,
          enabled:
            capability === NO_CAPABILITY ||
            (capability !== PLUGIN_GROUP && !capabilityMissing(capability as Capability, caps)),
          tools: groups.get(capability),
        })),
      };
      return jsonResult(body);
    },
  );
}
