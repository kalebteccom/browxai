// `browxai doctor` Chromium sandbox row: whether the browsers browxai launches run
// with Chromium's OS sandbox on this host.

import { ConfigStore } from "../util/config-store.js";
import { docsUrl } from "../util/docs-links.js";
import {
  CHROMIUM_SANDBOX_ENV,
  sandboxRelaxHint,
  type ChromiumSandboxMode,
  type ChromiumSandboxSource,
} from "../util/chromium-sandbox.js";
import { resolveWorkspace } from "../util/workspace.js";
import {
  decideSandbox,
  sandboxProbe,
  type SandboxDecision,
  type SandboxFacts,
} from "../session/chromium-sandbox-launch.js";
import type { Check } from "./doctor.js";

/** What this host would do for each kind of browser. */
interface HostView {
  installed: SandboxDecision;
  bundled: SandboxDecision;
}

function describeOn(label: string, host: HostView, source: ChromiumSandboxSource) {
  const base = `${label}: browsers browxai launches ask for Chromium's OS sandbox, and a launch that cannot start it fails.`;
  if (host.installed.sandbox && host.bundled.sandbox) {
    return { detail: `${base} This host looks able to run it.` };
  }
  const reason = host.installed.sandbox ? host.bundled.reason : host.installed.reason;
  const scope = host.installed.sandbox ? " for the bundled Chromium and the headless shell" : "";
  return {
    detail: `${base} This host looks unable to run it${scope}, because ${reason}.`,
    fix: `${sandboxRelaxHint(source)} See ${docsUrl.threatModelTrustBoundary}`,
    warn: true,
  };
}

function describeAuto(label: string, host: HostView) {
  const turnOn = `to try the sandbox anyway, set ${CHROMIUM_SANDBOX_ENV}=on`;
  const keepOff = `to keep it off and drop the launch warning, set ${CHROMIUM_SANDBOX_ENV}=off`;
  const fix = `${turnOn}; ${keepOff}, see ${docsUrl.threatModelTrustBoundary}`;
  if (host.installed.sandbox && host.bundled.sandbox) {
    return {
      detail: `${label}: Chromium's OS sandbox is on for browsers browxai launches on this host. A launch that fails on the sandbox is retried once without it, with a warning, and later launches skip the sandbox.`,
    };
  }
  if (host.installed.sandbox) {
    return {
      detail: `${label}: the installed Chrome tries Chromium's OS sandbox on this host, and a failed start is retried once without it. The bundled Chromium and the headless shell launch without it, because ${host.bundled.reason}.`,
      fix,
      warn: true,
    };
  }
  return {
    detail: `${label}: Chromium's OS sandbox is off on this host, because ${host.installed.reason}. Page content runs without that boundary.`,
    fix,
    warn: true,
  };
}

function describeSandbox(
  mode: ChromiumSandboxMode,
  source: ChromiumSandboxSource,
  host: HostView,
): Omit<Check, "name" | "ok"> {
  const label = `${mode}${source === "default" ? " (default)" : ""}`;
  if (mode === "off") {
    const state = host.installed.sandbox ? "it could run the sandbox" : host.installed.reason;
    return {
      detail: `${label}: browsers browxai launches run without Chromium's OS sandbox. This host: ${state}.`,
    };
  }
  return mode === "on" ? describeOn(label, host, source) : describeAuto(label, host);
}

/** Resolves the setting the way the server does (the env layer, then the saved user
 *  and project layers in `<workspace>/config.json`) and reads what this host can do. */
export function chromiumSandboxRow(
  env: NodeJS.ProcessEnv = process.env,
  workspaceRoot?: string,
  gather: () => SandboxFacts = sandboxProbe.gather,
): Check {
  let mode: ChromiumSandboxMode;
  let source: ChromiumSandboxSource;
  try {
    // A mistyped BROWX_TOOL_LIST or BROWX_TOOL_PROFILE is that row's error to report.
    const store = new ConfigStore(workspaceRoot ?? resolveWorkspace(env).root, {
      ...env,
      BROWX_TOOL_LIST: "",
      BROWX_TOOL_PROFILE: "",
    });
    mode = store.resolve().chromiumSandbox ?? "auto";
    source = store.chromiumSandboxSource();
  } catch (e) {
    return {
      name: "chromium-sandbox",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: `set ${CHROMIUM_SANDBOX_ENV} or the chromiumSandbox config key to auto, on or off, see ${docsUrl.toolReference}`,
    };
  }
  const facts = gather();
  const host = { installed: decideSandbox(facts, "installed"), bundled: decideSandbox(facts) };
  return { name: "chromium-sandbox", ok: true, ...describeSandbox(mode, source, host) };
}
