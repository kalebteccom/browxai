// `browxai doctor` tool-profile row: how many tools `tools/list` reports.

import { ConfigStore } from "../util/config-store.js";
import { docsUrl } from "../util/docs-links.js";
import { CORE_TOOLS, type ToolProfile } from "../util/tool-profile.js";
import { resolveWorkspace } from "../util/workspace.js";
import type { Check } from "./doctor.js";

/** Resolves the setting the way the server does: the env layer, then the saved
 *  user and project layers in `<workspace>/config.json`. */
export function toolProfileRow(
  env: NodeJS.ProcessEnv = process.env,
  workspaceRoot?: string,
): Check {
  let profile: ToolProfile | undefined;
  let explicit: boolean;
  try {
    // A mistyped BROWX_TOOL_LIST is the tool-list row's error to report.
    const store = new ConfigStore(workspaceRoot ?? resolveWorkspace(env).root, {
      ...env,
      BROWX_TOOL_LIST: "",
    });
    profile = store.resolve().toolProfile;
    explicit =
      !!env.BROWX_TOOL_PROFILE?.trim() ||
      (["user", "project"] as const).some((scope) => "toolProfile" in store.getLayer(scope));
  } catch (e) {
    return {
      name: "tool-profile",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: `set BROWX_TOOL_PROFILE or the toolProfile config key to full or core, see ${docsUrl.toolReference}`,
    };
  }
  if (profile === "core") {
    return {
      name: "tool-profile",
      ok: true,
      detail: `core: tools/list reports ${CORE_TOOLS.length} core tools, plugin tools and tool_catalog. Every other tool stays callable by name.`,
    };
  }
  return {
    name: "tool-profile",
    ok: true,
    detail: `full${explicit ? "" : " (default)"}: the profile leaves out no tool, toolList decides what is listed`,
  };
}
