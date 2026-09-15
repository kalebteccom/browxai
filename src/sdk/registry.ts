// SDK tool registry — the CURATED set of tools that carry a typed method on
// `BrowxaiClient`, and the two lookups the SDK's capability gate needs.
//
// `SDK_TOOLS` is a curation of the TYPED surface only. It is not a ceiling on
// what the SDK can call: `callTool` admits any registered tool whose capability
// is active (see `src/sdk/client.ts`), so the SDK's reach equals the MCP
// server's reach and both paths gate on the same `TOOL_CAPABILITY` rows.
//
// Adding a typed method: add an entry here, the wrapper in `src/sdk/client.ts`,
// and the signature on `BrowxaiClient` (`src/sdk/types.ts`). A fitness test pins
// the three to each other. Removing or renaming an entry is a semver-major
// change for the SDK surface.

import { TOOL_CAPABILITY, type Capability } from "../util/capabilities.js";
// The composition-root bootstrap — the one `src/tools/*` import the SDK layer is
// allowed (see .dependency-cruiser.cjs `no-sdk-to-handler-internals`). It answers
// "is this a name the server registers", which the gate must know BEFORE it
// resolves a capability: without it an unknown name lands on the permissive
// `human` default and a typo becomes an un-gated call.
import { collectToolMetadata } from "../tools/tool-metadata.js";

/** Tools the SDK exposes as typed methods on `BrowxaiClient`. */
export const SDK_TOOLS = [
  // read
  "snapshot",
  "find",
  "frames_list",
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
] as const;

export type SdkToolName = (typeof SDK_TOOLS)[number];

/**
 * Tool → capability lookup the SDK's gate uses. Reads the SAME `TOOL_CAPABILITY`
 * map the server's `gateCheck` consults, so the two paths cannot drift.
 *
 * The `human` fallback covers the ten control-plane primitives (session
 * lifecycle, `batch`, config, approvals) that declare no capability — the same
 * permissive default `isToolEnabled` applies server-side. It is only safe for a
 * name the server actually registers, so every caller MUST clear
 * {@link isRegisteredTool} first.
 */
export function capabilityFor(tool: string): Capability | "human" {
  return TOOL_CAPABILITY[tool] ?? "human";
}

/** Every tool name this build registers, from the same registration table the
 *  server composes its handler map from. */
export function registeredTools(): ReadonlyArray<string> {
  return [...collectToolMetadata().keys()];
}

/** True when `tool` is a name the server registers. The `TOOL_CAPABILITY` arm
 *  additionally catches plugin tools that registered into THIS process after the
 *  metadata table was collected (the in-process transport). */
export function isRegisteredTool(tool: string): boolean {
  return collectToolMetadata().has(tool) || tool in TOOL_CAPABILITY;
}
