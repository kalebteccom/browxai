// `browxai doctor` tool-list row: which tools `tools/list` reports.

import { ConfigStore } from "../util/config-store.js";
import { docsUrl } from "../util/docs-links.js";
import type { ToolListMode } from "../util/tool-list.js";
import { resolveWorkspace } from "../util/workspace.js";
import type { Check } from "./doctor.js";

/** Resolves the setting the way the server does: the env layer, then the saved
 *  user and project layers in `<workspace>/config.json`. */
export function toolListRow(env: NodeJS.ProcessEnv = process.env, workspaceRoot?: string): Check {
  let mode: ToolListMode | undefined;
  let explicit: boolean;
  try {
    // A mistyped BROWX_TOOL_PROFILE or BROWX_CHROMIUM_SANDBOX is that row's error to report.
    const store = new ConfigStore(workspaceRoot ?? resolveWorkspace(env).root, {
      ...env,
      BROWX_TOOL_PROFILE: "",
      BROWX_CHROMIUM_SANDBOX: "",
    });
    mode = store.resolve().toolList;
    explicit =
      !!env.BROWX_TOOL_LIST?.trim() ||
      (["user", "project"] as const).some((scope) => "toolList" in store.getLayer(scope));
  } catch (e) {
    return {
      name: "tool-list",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: `set BROWX_TOOL_LIST or the toolList config key to all or enabled, see ${docsUrl.toolReference}`,
    };
  }
  if (mode === "all") {
    return {
      name: "tool-list",
      ok: true,
      detail: "all: tools/list reports every tool, including the ones whose capability is off",
    };
  }
  return {
    name: "tool-list",
    ok: true,
    detail: `enabled${explicit ? "" : " (default)"}: tools/list shows only the tools this server can run. Set toolList to all to list every tool. A call by name still returns its refusal and hint.`,
  };
}
