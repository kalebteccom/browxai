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
  | "file-io"
  | "network-body"
  | "clipboard"
  | "unstable";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "read", "navigation", "action", "human", "eval", "byob-attach", "file-io", "network-body", "clipboard", "unstable",
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
  ws_read: "read",
  inspect: "read",
  point_probe: "read",
  watch: "read",
  sample: "read",
  // act_and_sample: the sampler half is `read`; the inner action's own
  // capability is enforced separately via gateCheck(action.tool) at runtime.
  act_and_sample: "read",
  list_named_refs: "read",
  text_search: "read",
  // navigation
  navigate: "navigation",
  go_back: "navigation",
  go_forward: "navigation",
  scroll: "navigation",
  set_viewport: "navigation",
  tab_visibility: "navigation",
  // action
  click: "action",
  fill: "action",
  press: "action",
  shortcut: "action",
  hover: "action",
  select: "action",
  choose_option: "action",
  wait_for: "action",
  // human
  await_human: "human",
  name_ref: "human",
  start_recording: "human",
  end_recording: "human",
  record_annotate: "human",
  find_feedback: "human",
  // eval
  eval_js: "eval",
  // unstable — the explicitly-experimental lane (W-Q7..Q11). Off by default;
  // NOT part of the v0.1.0 frozen stable surface (see docs/tool-reference.md
  // "Stability & semver"). Shapes here may change/vanish in any release.
  drag: "unstable",
  double_click: "unstable",
  mouse_down: "unstable",
  mouse_move: "unstable",
  mouse_up: "unstable",
  route: "unstable",
  route_queue: "unstable",
  unroute: "unstable",
  act_and_diff: "unstable",
  act_and_wait_for_network: "unstable",
  poll_eval: "unstable",
  screenshot_region: "unstable",
  name_region: "unstable",
  export_session_report: "unstable",
  // network-body (off by default — full response bodies can carry PII / tokens)
  network_body: "network-body",
  // byob-attach and file-io are not bound to specific tools — byob-attach gates the
  // BROWX_ATTACH_CDP code path at session creation; file-io will gate future
  // download/upload tools when they ship. `clipboard` is likewise behaviour-gated,
  // not tool-gated: the `shortcut` tool itself needs `action`, but its OS-clipboard
  // side-effect (copy/cut/paste) only engages when `clipboard` is also enabled —
  // off by default; same posture class as `eval` / `network-body`.
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
