// `browxai doctor` Chromium sandbox row: whether the browsers browxai launches run
// with Chromium's OS sandbox on this host.

import { ConfigStore } from "../util/config-store.js";
import { docsUrl } from "../util/docs-links.js";
import { CHROMIUM_SANDBOX_ENV, type ChromiumSandboxMode } from "../util/chromium-sandbox.js";
import { resolveWorkspace } from "../util/workspace.js";
import {
  decideSandbox,
  sandboxProbe,
  type SandboxDecision,
  type SandboxFacts,
} from "../session/chromium-sandbox-launch.js";
import type { Check } from "./doctor.js";

function describeSandbox(
  mode: ChromiumSandboxMode,
  explicit: boolean,
  decision: SandboxDecision,
): Omit<Check, "name" | "ok"> {
  const label = `${mode}${explicit ? "" : " (default)"}`;
  const turnOn = `to try the sandbox on this host, set ${CHROMIUM_SANDBOX_ENV}=on`;
  const keepOff = `to keep it off and drop the launch warning, set ${CHROMIUM_SANDBOX_ENV}=off`;
  if (mode === "off") {
    return {
      detail: `${label}: browsers browxai launches run without Chromium's OS sandbox. This host: ${decision.sandbox ? "it could run the sandbox" : decision.reason}.`,
    };
  }
  if (mode === "on") {
    if (decision.sandbox) {
      return {
        detail: `${label}: browsers browxai launches ask for Chromium's OS sandbox, and a launch that cannot start it fails. This host looks able to run it.`,
      };
    }
    return {
      detail: `${label}: browsers browxai launches ask for Chromium's OS sandbox, and a launch that cannot start it fails. This host looks unable to run it, because ${decision.reason}.`,
      fix: `${CHROMIUM_SANDBOX_ENV}=off launches without the sandbox, ${CHROMIUM_SANDBOX_ENV}=auto falls back when it cannot start, see ${docsUrl.threatModelTrustBoundary}`,
      warn: true,
    };
  }
  if (decision.sandbox) {
    return {
      detail: `${label}: Chromium's OS sandbox is on for browsers browxai launches on this host. A launch that fails on the sandbox is retried once without it, with a warning.`,
    };
  }
  return {
    detail: `${label}: Chromium's OS sandbox is off on this host, because ${decision.reason}. Page content runs without that boundary.`,
    fix: `${turnOn}; ${keepOff}, see ${docsUrl.threatModelTrustBoundary}`,
    warn: true,
  };
}

/** Resolves the setting the way the server does (the env layer, then the saved user
 *  and project layers in `<workspace>/config.json`) and reads what this host can do. */
export function chromiumSandboxRow(
  env: NodeJS.ProcessEnv = process.env,
  workspaceRoot?: string,
  gather: () => SandboxFacts = sandboxProbe.gather,
): Check {
  let mode: ChromiumSandboxMode;
  let explicit: boolean;
  try {
    // A mistyped BROWX_TOOL_LIST or BROWX_TOOL_PROFILE is that row's error to report.
    const store = new ConfigStore(workspaceRoot ?? resolveWorkspace(env).root, {
      ...env,
      BROWX_TOOL_LIST: "",
      BROWX_TOOL_PROFILE: "",
    });
    mode = store.resolve().chromiumSandbox ?? "auto";
    explicit =
      !!env[CHROMIUM_SANDBOX_ENV]?.trim() ||
      (["user", "project"] as const).some((scope) => "chromiumSandbox" in store.getLayer(scope));
  } catch (e) {
    return {
      name: "chromium-sandbox",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: `set ${CHROMIUM_SANDBOX_ENV} or the chromiumSandbox config key to auto, on or off, see ${docsUrl.toolReference}`,
    };
  }
  return {
    name: "chromium-sandbox",
    ok: true,
    ...describeSandbox(mode, explicit, decideSandbox(gather())),
  };
}
