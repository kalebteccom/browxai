// The attached-session hold, checked against every registration.
//
// A tool under a capability that changes the browser waits for a human in an
// attached session while `byob_action` is set. The `register` wrapper runs that
// hold from the capability each tool declares, so a new tool is held with no code
// in its handler. A tool opts out with `byobConfirm: false` at its registration,
// and a tool under another capability opts in with `byobConfirm: true`.
//
// The opt-outs and the opt-ins are written out here with the reason for each. A
// new one edits this file in the same commit, where a reviewer sees it.

import { describe, it, expect } from "vitest";
import "../../src/tools/tool-metadata.js";
import { BYOB_HOLD_CAPABILITIES, shouldHold } from "../../src/tools/byob-hold.js";
import { toolRegistrations } from "./_surface.js";

/** Tools under a held capability that are not held, and why. */
const PINNED_NOT_HELD: Record<string, string> = {
  artifact_save: "writes a file in the workspace artifact store",
  asset_export: "reads the page and writes the export to the workspace",
  auth_delete: "deletes a workspace slot file, takes no session and reaches no browser",
  coverage_start: "starts coverage collection, which observes the page",
  dom_export: "reads the page and writes the export to the workspace",
  download_get: "reads a captured download from the workspace",
  downloads_capture: "sets whether this server keeps download files in the workspace",
  element_export: "reads the page and writes the export to the workspace",
  extensions_list: "lists the session's extensions and changes none",
  flake_check: "runs other tools, and each inner call is held on its own",
  get_video: "reads a recorded video file, which an attached session cannot have",
  heap_retainers: "queries a heap snapshot",
  heap_snapshot: "reads the heap and writes a snapshot to the workspace",
  page_archive: "reads the page and writes the archive to the workspace",
  pdf_save: "renders the page to a workspace PDF",
  perf_insights: "reads a trace already recorded",
  perf_start: "starts a trace, which observes the page",
  perf_stop: "ends a trace and writes it to the workspace",
  screenshot_on: "captures screenshots when page events fire",
  screenshot_schedule: "captures screenshots on a timer",
  stop_har: "ends a capture and writes the file, and start_har is the held half",
  stop_video: "ends a recording, which an attached session cannot have",
  sw_unintercept_fetch: "removes a service-worker fetch intercept this server installed",
  unroute: "removes a route this server installed",
  wait_for: "waits for a page condition and changes nothing",
  ws_unintercept: "removes a WebSocket intercept this server installed",
};

/** Tools outside the held capabilities that opt in with `byobConfirm: true`, and
 *  why. Each is a `read` tool whose result carries the attached browser's cookie
 *  values, so the person is asked before they leave it. */
const PINNED_OPTED_IN: Record<string, string> = {
  cookies_get: "returns a cookie value from the attached browser's jar",
  cookies_list: "returns the cookie values in the attached browser's jar",
  dump_storage_state: "returns every cookie value and the localStorage of the attached browser",
};

/** A sample of tools that must be held, written out so a change to the
 *  capability set or to one of these registrations fails by name. */
const MUST_HOLD = [
  "click",
  "double_click",
  "drag",
  "mouse_down",
  "touch_start",
  "gesture_swipe",
  "navigate",
  "go_back",
  "go_forward",
  "set_viewport",
  "route",
  "route_queue",
  "ws_send",
  "sw_intercept_fetch",
  "grant_permissions",
  "set_geolocation",
  "set_dialog_policy",
  "clock",
  "cookies_set",
  "inject_storage_state",
  "execute",
  "eval_js",
  "poll_eval",
  "gesture_chain",
  "upload_file",
  "fs_picker_respond",
  "extensions_install",
  "emulate_usb",
  "cookies_get",
  "cookies_list",
  "dump_storage_state",
];

/** Tools that must never be held: the ones that lift or answer the hold, and
 *  the session and config tools. */
const MUST_NOT_HOLD = [
  "approve_actions",
  "await_human",
  "batch",
  "open_session",
  "close_session",
  "list_sessions",
  "get_config",
  "set_config",
  "snapshot",
  "find",
];

const RULE =
  "A tool under a held capability is held in an attached session. To leave one out, set " +
  "`byobConfirm: false` at its `host.register` call with a one-line reason, and add the " +
  "name and reason to PINNED_NOT_HELD in this file.";

describe("attached-session hold: every registration is held or pinned", () => {
  it("holds every tool under a held capability, except the pinned ones", async () => {
    const table = await toolRegistrations();
    const unpinned: string[] = [];
    for (const [name, reg] of table) {
      if (reg.capability === undefined || !BYOB_HOLD_CAPABILITIES.has(reg.capability)) continue;
      if (shouldHold(reg.capability, reg)) continue;
      if (!(name in PINNED_NOT_HELD)) unpinned.push(name);
    }
    expect(unpinned.sort(), RULE).toEqual([]);
  });

  it("the pinned list is exactly the registrations that opt out", async () => {
    const table = await toolRegistrations();
    const optedOut = [...table]
      .filter(([, reg]) => reg.byobConfirm === false)
      .map(([name]) => name)
      .sort();
    expect(optedOut, RULE).toEqual(Object.keys(PINNED_NOT_HELD).sort());
  });

  it("every pinned tool is under a held capability and has a reason", async () => {
    const table = await toolRegistrations();
    for (const [name, reason] of Object.entries(PINNED_NOT_HELD)) {
      const reg = table.get(name);
      expect(reg, `${name} is pinned but not registered`).toBeDefined();
      expect(BYOB_HOLD_CAPABILITIES.has(reg!.capability!), `${name} needs no opt-out`).toBe(true);
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(10);
    }
  });

  it("the opt-ins are exactly the pinned ones", async () => {
    const table = await toolRegistrations();
    const optedIn = [...table]
      .filter(([, reg]) => reg.byobConfirm === true)
      .map(([name]) => name)
      .sort();
    expect(optedIn).toEqual(Object.keys(PINNED_OPTED_IN).sort());
  });

  it("every opted-in tool is outside the held capabilities and has a reason", async () => {
    const table = await toolRegistrations();
    for (const [name, reason] of Object.entries(PINNED_OPTED_IN)) {
      const reg = table.get(name);
      expect(reg, `${name} is pinned but not registered`).toBeDefined();
      const cap = reg!.capability;
      expect(cap !== undefined && BYOB_HOLD_CAPABILITIES.has(cap), `${name} needs no opt-in`).toBe(
        false,
      );
      expect(shouldHold(cap, reg!), `${name} is held`).toBe(true);
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(10);
    }
  });

  it("holds the named action, navigation, eval, file, device and cookie-read tools", async () => {
    const table = await toolRegistrations();
    const notHeld = MUST_HOLD.filter((name) => {
      const reg = table.get(name);
      return !reg || !shouldHold(reg.capability, reg);
    });
    expect(notHeld).toEqual([]);
  });

  it("never holds the tools that answer the hold, or the session and config tools", async () => {
    const table = await toolRegistrations();
    const held = MUST_NOT_HOLD.filter((name) => {
      const reg = table.get(name);
      return !reg || shouldHold(reg.capability, reg);
    });
    expect(held).toEqual([]);
  });
});
