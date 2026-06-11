// Stable SDK tool registry — the curated subset of MCP tools exposed on the
// `BrowxaiClient` interface. Each entry binds a method name to its underlying
// MCP tool name AND the capability gate that governs it. The capability
// reference is the SAME map the server's `gateCheck` consults (see
// `src/util/capabilities.ts`), so a method is only exposed when the SDK's
// capability set includes its gate — identical posture to the MCP path.
//
// Adding a method: add an entry here, then add the typed wrapper to
// `src/sdk/client.ts`. Removing/renaming an existing entry is a semver-major
// change for the SDK surface.

import { TOOL_CAPABILITY, type Capability } from "../util/capabilities.js";

/** Tools the SDK exposes as typed methods on `BrowxaiClient`. */
export const SDK_TOOLS = [
  // read
  "snapshot",
  "find",
  "screenshot",
  "console_read",
  "network_read",
  "ws_read",
  "inspect",
  "text_search",
  "extract",
  "verify_visible",
  "verify_text",
  "verify_value",
  "verify_count",
  "verify_attribute",
  "verify_predicate",
  "generate_locator",
  "plan",
  // navigation
  "navigate",
  "go_back",
  "go_forward",
  "scroll",
  "set_viewport",
  // action
  "click",
  "fill",
  "press",
  "shortcut",
  "hover",
  "select",
  "choose_option",
  "fill_form",
  "wait_for",
  "execute",
  // human / coordination
  "await_human",
  "name_ref",
  // session management — needed by every consumer
  "open_session",
  "close_session",
  "close_sessions",
  "list_sessions",
  // capability-gated tools below: present in the registry so the runtime
  // walker can ALSO emit them when the matching capability is opted in.
  // The TS surface for them is intentionally hidden behind a typed escape
  // hatch — see `BrowxaiClient.callTool`.
  "eval_js",
  "network_body",
  "upload_file",
  "register_secret",
  // diagnostics. `diagnostics_note` rides the off-by-default
  // `diagnostics` capability; the two read-side queries ride `read` so an
  // adopter who only enabled diagnostics for a prior run can still pull the
  // report from a fresh SDK client.
  "diagnostics_note",
  "diagnostics_search",
  "diagnostics_report",
] as const;

export type SdkToolName = (typeof SDK_TOOLS)[number];

/**
 * Tool → capability lookup the SDK uses to decide which methods to expose.
 * Pulled from the same `TOOL_CAPABILITY` map the MCP server uses so the two
 * paths cannot drift.
 */
export function capabilityFor(tool: string): Capability | "human" {
  return TOOL_CAPABILITY[tool] ?? "human";
}

/**
 * SDK methods always exposed regardless of capability set — these are the
 * coordination / session-management primitives whose capability is `human`
 * (always-enabled by the server) plus the SDK lifecycle method itself.
 * Used by the registry walker to short-circuit the gate check.
 */
export const ALWAYS_EXPOSED: ReadonlySet<string> = new Set([
  "await_human",
  "name_ref",
  "open_session",
  "close_session",
  "close_sessions",
  "list_sessions",
]);
