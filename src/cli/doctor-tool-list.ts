// `browxai doctor` tool-list row: which tools `tools/list` reports.

import { parseToolList, type ToolListMode } from "../util/tool-list.js";
import { docsUrl } from "../util/docs-links.js";
import type { Check } from "./doctor.js";

export function toolListRow(env: NodeJS.ProcessEnv = process.env): Check {
  let mode: ToolListMode | undefined;
  try {
    mode = parseToolList(env.BROWX_TOOL_LIST);
  } catch (e) {
    return {
      name: "tool-list",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: `set BROWX_TOOL_LIST to all or enabled, see ${docsUrl.toolReference}`,
    };
  }
  if (mode === "enabled") {
    return {
      name: "tool-list",
      ok: true,
      detail:
        "enabled: tools/list omits tools whose capability is off. A call by name still returns its refusal and hint.",
    };
  }
  return {
    name: "tool-list",
    ok: true,
    detail: `all${mode === undefined ? " (default)" : ""}: tools/list reports every tool, including the ones whose capability is off`,
  };
}
