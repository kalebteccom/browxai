// The stable surface, pinned as literals.
//
// AGENTS.md "Stable surface + semver" freezes the tool names and the default
// capability set. The other suites in this lane derive their expectations from the
// registrations or from the constant under test, so a rename, a dropped tool or a
// wider default passes them. Here the expected values are written out. A change to
// either one edits this file in the same commit, where a reviewer sees it.

import { describe, it, expect } from "vitest";
import "../../src/tools/tool-metadata.js";
import {
  DEFAULT_CAPABILITIES,
  resolveCapabilities,
  type Capability,
} from "../../src/util/capabilities.js";
import { registeredToolNames, toolRegistrations } from "./_surface.js";

/** The default capability set, as shipped. */
const PINNED_DEFAULT_CAPABILITIES = ["read", "navigation", "action", "human"];

/** Tools a server with the default capabilities can run: every tool gated by a
 *  default capability, plus the control-plane tools that declare none. Sorted. */
const STABLE_TOOL_NAMES = [
  "act_and_diff",
  "act_and_sample",
  "act_and_wait_for_network",
  "artifact_get",
  "artifact_list",
  "artifact_save",
  "auth_delete",
  "auth_list",
  "auth_load",
  "auth_save",
  "await_human",
  "batch",
  "caches_clear",
  "caches_delete",
  "caches_delete_storage",
  "caches_get",
  "caches_list",
  "caches_list_storages",
  "caches_put",
  "canvas_diff",
  "choose_option",
  "click",
  "clock",
  "close_session",
  "close_sessions",
  "console_read",
  "cookies_clear",
  "cookies_delete",
  "cookies_get",
  "cookies_list",
  "cookies_set",
  "coverage_start",
  "coverage_stop",
  "cpu_emulate",
  "cross_session_sample",
  "diagnostics_report",
  "diagnostics_search",
  "double_click",
  "drag",
  "dump_storage_state",
  "end_recording",
  "execute",
  "export_playwright_script",
  "export_session_report",
  "extract",
  "fill",
  "fill_form",
  "find",
  "find_feedback",
  "flake_check",
  "frames_list",
  "generate_locator",
  "gesture_pinch",
  "gesture_swipe",
  "get_config",
  "go_back",
  "go_forward",
  "grant_permissions",
  "heap_retainers",
  "heap_snapshot",
  "hover",
  "idb_clear",
  "idb_delete",
  "idb_get",
  "idb_list_databases",
  "idb_list_stores",
  "idb_put",
  "inject_storage_state",
  "inspect",
  "layout_thrash_trace",
  "list_approvals",
  "list_named_refs",
  "list_sessions",
  "localstorage_clear",
  "localstorage_delete",
  "localstorage_get",
  "localstorage_list",
  "localstorage_set",
  "memory_diff",
  "mouse_down",
  "mouse_move",
  "mouse_up",
  "mouse_wheel",
  "name_ref",
  "name_region",
  "navigate",
  "network_emulate",
  "network_read",
  "open_session",
  "overflow_detect",
  "pdf_save",
  "perf_audit",
  "perf_insights",
  "perf_start",
  "perf_stop",
  "permission_state",
  "plan",
  "plugins_info",
  "plugins_list",
  "point_probe",
  "press",
  "profile_restore",
  "profile_snapshot",
  "profile_status",
  "record_annotate",
  "region",
  "reset_config",
  "route",
  "route_queue",
  "sample",
  "screenshot",
  "screenshot_marks",
  "screenshot_region",
  "scroll",
  "seed_random",
  "select",
  "session_metrics",
  "sessionstorage_clear",
  "sessionstorage_delete",
  "sessionstorage_get",
  "sessionstorage_list",
  "sessionstorage_set",
  "set_color_scheme",
  "set_config",
  "set_dialog_policy",
  "set_fs_picker_policy",
  "set_geolocation",
  "set_locale",
  "set_notification_policy",
  "set_permission_policy",
  "set_reduced_motion",
  "set_timezone",
  "set_user_agent",
  "set_viewport",
  "shadow_trees",
  "shortcut",
  "snapshot",
  "start_har",
  "start_recording",
  "stop_har",
  "sw_intercept_fetch",
  "sw_unintercept_fetch",
  "tab_visibility",
  "text_search",
  "touch_end",
  "touch_move",
  "touch_start",
  "unroute",
  "verify_attribute",
  "verify_count",
  "verify_predicate",
  "verify_text",
  "verify_value",
  "verify_visible",
  "wait_for",
  "watch",
  "worker_message_send",
  "worker_messages_read",
  "workers_list",
  "ws_intercept",
  "ws_read",
  "ws_send",
  "ws_unintercept",
];

/** Tools behind an off-by-default capability. Experimental under the semver rule,
 *  and pinned so that a tool moving onto the default surface shows up here. Sorted. */
const GATED_TOOL_NAMES = [
  "app_foreground",
  "app_install",
  "app_launch",
  "app_list",
  "app_reset",
  "app_terminate",
  "app_uninstall",
  "approve_actions",
  "asset_export",
  "canvas_capture",
  "canvas_query",
  "canvas_screen_to_world",
  "canvas_world_to_screen",
  "device_boot",
  "device_list",
  "device_requests",
  "device_shutdown",
  "diagnostics_note",
  "dom_export",
  "download_get",
  "downloads_capture",
  "drop_files",
  "element_export",
  "emulate_bluetooth",
  "emulate_hid",
  "emulate_usb",
  "eval_js",
  "extensions_install",
  "extensions_list",
  "extensions_reload",
  "extensions_trigger",
  "extensions_uninstall",
  "fs_picker_respond",
  "gesture_chain",
  "get_credential",
  "get_totp",
  "get_video",
  "network_body",
  "page_archive",
  "poll_eval",
  "register_secret",
  "screenshot_on",
  "screenshot_schedule",
  "solve_captcha",
  "stop_video",
  "upload_file",
];

const SEMVER_RULE =
  'Tool names and the default capability set are frozen (AGENTS.md "Stable surface + semver"). ' +
  "Removing or renaming a stable tool, or widening the defaults, is a breaking change. " +
  "A new tool is additive: add its name to the list in the same commit.";

function difference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return a.filter((x) => !other.has(x));
}

describe("stable surface: default capability set", () => {
  it("DEFAULT_CAPABILITIES is exactly read, navigation, action, human", () => {
    expect([...DEFAULT_CAPABILITIES], SEMVER_RULE).toEqual(PINNED_DEFAULT_CAPABILITIES);
  });

  it("an unset BROWX_CAPABILITIES resolves to the same four", () => {
    const enabled = [...resolveCapabilities({}).enabled].sort();
    expect(enabled, SEMVER_RULE).toEqual([...PINNED_DEFAULT_CAPABILITIES].sort());
  });
});

describe("stable surface: tool names", () => {
  it("the pinned lists are sorted, with no name in both", () => {
    expect(STABLE_TOOL_NAMES).toEqual([...STABLE_TOOL_NAMES].sort());
    expect(GATED_TOOL_NAMES).toEqual([...GATED_TOOL_NAMES].sort());
    const all = [...STABLE_TOOL_NAMES, ...GATED_TOOL_NAMES];
    expect(new Set(all).size).toBe(all.length);
  });

  it("every pinned stable tool is still registered on the default surface", async () => {
    const actual = await defaultSurfaceNames();
    const gone = difference(STABLE_TOOL_NAMES, actual);
    expect(gone, `stable tools removed, renamed or moved behind a gate. ${SEMVER_RULE}`).toEqual(
      [],
    );
  });

  it("no tool is on the default surface without being pinned", async () => {
    const actual = await defaultSurfaceNames();
    const unpinned = difference(actual, STABLE_TOOL_NAMES);
    expect(unpinned, `tools new to the default surface. ${SEMVER_RULE}`).toEqual([]);
  });

  it("the gated tools are exactly the pinned gated list", async () => {
    const actual = await gatedNames();
    expect(difference(GATED_TOOL_NAMES, actual), "gated tools no longer registered").toEqual([]);
    expect(difference(actual, GATED_TOOL_NAMES), "gated tools not in the pinned list").toEqual([]);
  });

  it("the registered handler table is the two lists together", async () => {
    const handlers = (await registeredToolNames()).sort();
    expect(handlers).toEqual([...STABLE_TOOL_NAMES, ...GATED_TOOL_NAMES].sort());
  });
});

const isDefault = (capability: Capability | undefined): boolean =>
  capability === undefined || PINNED_DEFAULT_CAPABILITIES.includes(capability);

async function defaultSurfaceNames(): Promise<string[]> {
  const table = await toolRegistrations();
  return [...table].filter(([, m]) => isDefault(m.capability)).map(([name]) => name);
}

async function gatedNames(): Promise<string[]> {
  const table = await toolRegistrations();
  return [...table].filter(([, m]) => !isDefault(m.capability)).map(([name]) => name);
}
