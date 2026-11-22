// The `toolProfile` config key: how many of the registered tools `tools/list` reports.
//
// `full` (default) lists every tool. `core` lists a fixed set of 24 tools that cover
// the observe, locate, act and verify loop, plus every plugin tool, plus one
// discovery tool (`tool_catalog`) that names the tools the listing leaves out.
//
// A profile is a listing choice. It never grants a capability and never removes a
// tool: a tool outside the profile still answers a call by name, through the same
// capability gate, with the same refusal and hint. The profile composes with
// `toolList` (src/util/tool-list.ts): the capability filter runs first, then the
// profile narrows what is left.

export const TOOL_PROFILES = ["full", "core"] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

export function isToolProfile(value: unknown): value is ToolProfile {
  return typeof value === "string" && (TOOL_PROFILES as readonly string[]).includes(value);
}

/** Parse a `BROWX_TOOL_PROFILE` value. Unset or blank gives `undefined`; an unknown
 *  value throws, so a typo stops the server at start. */
export function parseToolProfile(
  raw: string | undefined,
  source = "BROWX_TOOL_PROFILE",
): ToolProfile | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (isToolProfile(value)) return value;
  throw new Error(
    `${source}: unknown value ${JSON.stringify(raw?.trim())}. Valid: ${TOOL_PROFILES.join(", ")}. ` +
      "Fix the spelling or remove the entry, then restart the server.",
  );
}

/** The tools the `core` profile lists. Every one is in a default-on capability or is
 *  session control, so none needs a capability change to be useful. `open_session`
 *  is left out on purpose: any tool with a `session` argument creates that session
 *  on first use. A fitness test checks each name against the registered tools. */
export const CORE_TOOLS = Object.freeze([
  // navigate
  "navigate",
  "go_back",
  // observe
  "snapshot",
  "find",
  "text_search",
  "inspect",
  "extract",
  "screenshot",
  "console_read",
  "network_read",
  // act
  "click",
  "fill",
  "fill_form",
  "select",
  "hover",
  "press",
  "scroll",
  "wait_for",
  // verify
  "verify_text",
  "verify_visible",
  "verify_count",
  // session control
  "close_session",
  "list_sessions",
  // compose
  "batch",
] as const);

const CORE_SET: ReadonlySet<string> = new Set<string>(CORE_TOOLS);

/** True when `tool` is one of the {@link CORE_TOOLS}. */
export function isCoreTool(tool: string): boolean {
  return CORE_SET.has(tool);
}

/** The discovery tool. The `core` profile registers it and always lists it. It
 *  belongs to no capability, so the gate always lets it run. */
export const TOOL_CATALOG_TOOL = "tool_catalog";
