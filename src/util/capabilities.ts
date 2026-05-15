// Capability toggles — Phase-2 security model. See `docs/threat-model.md` for the
// full design. The gist:
//
//   - Tools group into coarse categories (`read`, `navigation`, `action`, `human`,
//     `eval`, `byob-attach`, `file-io`). Each is independently enable/disable-able at
//     server start.
//   - Default set: read + navigation + action + human. `eval` / `byob-attach` /
//     `file-io` are off-by-default — opt in via `BROWX_CAPABILITIES`.
//   - The server's startup log lists the active set; `browxai doctor` warns when
//     dangerous capabilities are on (`eval`, `byob-attach`).
//
// Configuring:
//   BROWX_CAPABILITIES=read,navigation,action,human            # the default
//   BROWX_CAPABILITIES=read                                    # read-only server
//   BROWX_CAPABILITIES=read,navigation,action,human,eval       # opts in to eval_js

export type Capability =
  | "read"
  | "navigation"
  | "action"
  | "human"
  | "eval"
  | "byob-attach"
  | "file-io";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "read", "navigation", "action", "human", "eval", "byob-attach", "file-io",
];

export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  "read", "navigation", "action", "human",
];

/**
 * Map each MCP tool name to the capability that governs it. A tool not in this map
 * is treated as `human` (coordination primitive, always safe). The categories match
 * `docs/threat-model.md` "The capability set".
 */
export const TOOL_CAPABILITY: Record<string, Capability> = {
  // read
  snapshot: "read",
  find: "read",
  screenshot: "read",
  console_read: "read",
  network_read: "read",
  list_named_refs: "read",
  // navigation
  navigate: "navigation",
  go_back: "navigation",
  go_forward: "navigation",
  // action
  click: "action",
  fill: "action",
  press: "action",
  hover: "action",
  select: "action",
  wait_for: "action",
  // human
  await_human: "human",
  name_ref: "human",
  start_recording: "human",
  end_recording: "human",
  record_annotate: "human",
  // eval
  eval_js: "eval",
  // byob-attach and file-io are not bound to specific tools — byob-attach gates the
  // BROWX_ATTACH_CDP code path at session creation; file-io will gate future
  // download/upload tools when they ship.
};

export interface CapabilityConfig {
  enabled: ReadonlySet<Capability>;
  /** Names of tools rejected at start because their capability isn't enabled. */
  disabledTools: ReadonlyArray<{ tool: string; capability: Capability }>;
}

export function resolveCapabilities(env: NodeJS.ProcessEnv = process.env): CapabilityConfig {
  const raw = env.BROWX_CAPABILITIES?.trim();
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_CAPABILITIES];
  const unknown = list.filter((c) => !ALL_CAPABILITIES.includes(c as Capability));
  if (unknown.length) {
    throw new Error(
      `BROWX_CAPABILITIES: unknown capability/capabilities ${unknown.map((u) => JSON.stringify(u)).join(", ")}. ` +
      `Valid: ${ALL_CAPABILITIES.join(", ")}.`,
    );
  }
  const enabled = new Set(list as Capability[]);
  const disabledTools: Array<{ tool: string; capability: Capability }> = [];
  for (const [tool, cap] of Object.entries(TOOL_CAPABILITY)) {
    if (!enabled.has(cap)) disabledTools.push({ tool, capability: cap });
  }
  return { enabled, disabledTools };
}

/** Returns true iff the tool is enabled given the active capability set. */
export function isToolEnabled(tool: string, caps: CapabilityConfig): boolean {
  const cap = TOOL_CAPABILITY[tool];
  if (!cap) return true; // unknown tool: pass through (human-coordination default)
  return caps.enabled.has(cap);
}

/** Phase-2 confirm-required policy. Each name corresponds to a runtime hook (see
 *  src/policy/confirm.ts). Default: `navigate_off_allowlist,byob_action` when
 *  `BROWX_ALLOWED_ORIGINS` is set / `BROWX_ATTACH_CDP` is set respectively. */
export type ConfirmHook =
  | "navigate_off_allowlist"
  | "file_download"
  | "file_upload"
  | "byob_action";

const ALL_CONFIRM_HOOKS: readonly ConfirmHook[] = [
  "navigate_off_allowlist", "file_download", "file_upload", "byob_action",
];

const DEFAULT_CONFIRM_HOOKS: readonly ConfirmHook[] = [
  "navigate_off_allowlist", "byob_action",
];

export function resolveConfirmHooks(env: NodeJS.ProcessEnv = process.env): ReadonlySet<ConfirmHook> {
  const raw = env.BROWX_CONFIRM_REQUIRED?.trim();
  if (!raw) return new Set(DEFAULT_CONFIRM_HOOKS);
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = list.filter((h) => !ALL_CONFIRM_HOOKS.includes(h as ConfirmHook));
  if (unknown.length) {
    throw new Error(
      `BROWX_CONFIRM_REQUIRED: unknown hook(s) ${unknown.map((u) => JSON.stringify(u)).join(", ")}. ` +
      `Valid: ${ALL_CONFIRM_HOOKS.join(", ")}.`,
    );
  }
  return new Set(list as ConfirmHook[]);
}
