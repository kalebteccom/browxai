// THE authoritative tool -> exercise registry. One row per browxai handler:
// 188 capability-gated tools + 10 control-plane tools = 198. Generated against
// the live registry (toolCapabilityMap() + server handler names) at scaffold
// time; keep it in sync if the tool surface changes (the run-report driver
// asserts every manifest tool has an exercise OR is reported `pending`, and
// warns if a live tool is missing from the manifest).

import type { Capability, ManifestRow } from "./types.js";

function rows(
  capability: Capability,
  surface: string | undefined,
  entries: ReadonlyArray<readonly [tool: string, intent: string]>,
): ManifestRow[] {
  return entries.map(([tool, intent]) => ({ tool, capability, surface, intent }));
}

export const MANIFEST: readonly ManifestRow[] = [
  // ---- read (61) ----
  ...rows("read", "/core", [
    ["snapshot", "capture an a11y/DOM snapshot of the core page; assert it contains the greeting"],
    ["find", "find the 'Ping' button by description; assert a ref resolves"],
    ["inspect", "inspect the greeting element; assert geometry/role returned"],
    ["extract", "extract the fruit list as structured data; assert 3 items"],
    ["text_search", "search for 'unique-needle-7f3a'; assert a hit"],
    ["point_probe", "probe a coordinate over the ping button; assert element identified"],
    ["overflow_detect", "scan the core page; assert the overflow-box is flagged"],
    ["generate_locator", "generate a Playwright locator for a named ref"],
    ["list_named_refs", "after name_ref, list named refs; assert the name is present"],
    ["screenshot", "screenshot the core page; assert PNG bytes returned"],
    ["screenshot_region", "screenshot a bbox region; assert PNG bytes"],
    ["screenshot_marks", "mark candidate elements and screenshot; assert index<->ref map"],
    ["verify_visible", "verify the greeting is visible; assert pass"],
    ["verify_text", "verify the lede text matches; assert pass"],
    ["verify_value", "verify the readonly input value is 'prefilled'"],
    ["verify_count", "verify there are 3 .fruit elements"],
    ["verify_attribute", "verify the hidden element has the hidden attribute"],
    ["verify_predicate", "verify a server-evaluated predicate over an element"],
    ["watch", "watch the status region for a change after ping"],
    ["sample", "sample the page state; assert a structured observation"],
    ["plan", "plan an NL action ('click ping') to a bound descriptor without dispatch"],
  ]),
  ...rows("read", "/console", [["console_read", "click emit-logs then read console; assert all 5 levels present"]]),
  ...rows("read", "/workers", [
    ["workers_list", "spawn the dedicated worker then list workers; assert it appears"],
    ["worker_messages_read", "after a worker round-trip, read worker messages; assert the reply frame"],
  ]),
  ...rows("read", "/frames", [["frames_list", "list the frame tree; assert depth-2 (parent>child-a>grandchild)"]]),
  ...rows("read", "/shadow", [["shadow_trees", "walk shadow trees; assert open root visible, closed root warned"]]),
  ...rows("read", "/network", [
    ["network_read", "trigger fetch /api/json then read the network ring; assert the request row"],
    ["ws_read", "connect the echo socket, send, then ws_read; assert frames captured"],
    ["act_and_diff", "click recolor-equivalent and diff before/after observation"],
    ["act_and_sample", "click a button and sample the result in one call"],
    ["act_and_wait_for_network", "click do-json and wait for the /api/json response"],
    ["cross_session_sample", "sample across two sessions; assert both observed"],
  ]),
  ...rows("read", "/storage", [
    ["cookies_get", "after seed, get a cookie; assert ck-value"],
    ["cookies_list", "list cookies; assert ck-key present"],
    ["localstorage_get", "get ls-key; assert ls-value"],
    ["localstorage_list", "list localStorage; assert ls-key present"],
    ["sessionstorage_get", "get ss-key; assert ss-value"],
    ["sessionstorage_list", "list sessionStorage; assert ss-key present"],
    ["idb_get", "get idb-key from testbed-db; assert idb-value"],
    ["idb_list_databases", "list IndexedDB databases; assert testbed-db"],
    ["idb_list_stores", "list stores in testbed-db; assert 'kv'"],
    ["caches_get", "get /cache-item from testbed-cache; assert cache-value"],
    ["caches_list", "list entries in testbed-cache; assert /cache-item"],
    ["caches_list_storages", "list cache storages; assert testbed-cache"],
    ["dump_storage_state", "dump storage state; assert cookies+origins present"],
    ["auth_list", "list saved auth profiles after auth_save; assert the name"],
  ]),
  ...rows("read", undefined, [
    ["artifact_get", "after artifact_save, get it back; assert payload matches"],
    ["artifact_list", "list session artifacts; assert the saved key present"],
    ["diagnostics_report", "pull a diagnostics report; assert structured rows"],
    ["diagnostics_search", "search the diagnostics store; assert a match"],
    ["session_metrics", "read session metrics; assert tool-call counts > 0"],
    ["export_session_report", "export the session report; assert a structured summary"],
    ["export_playwright_script", "export the recorded trace to a Playwright spec string"],
    ["plugins_info", "read plugin runtime info; assert apiVersion present"],
    ["plugins_list", "list loaded plugins; assert an array (0 ok)"],
  ]),
  ...rows("read", "/perf", [
    ["perf_audit", "audit the perf page; assert a structured audit (no false ceiling throw)"],
    ["layout_thrash_trace", "trace the thrash button; assert forced-reflow sites reported"],
    ["memory_diff", "diff two heap snapshots around alloc; assert growth detected"],
    ["coverage_stop", "after coverage_start + interaction, stop; assert coverage ranges"],
  ]),
  ...rows("read", "/permissions", [["permission_state", "read permission states; assert geolocation entry"]]),

  // ---- navigation (6) ----
  ...rows("navigation", "/core", [
    ["navigate", "navigate to /forms; assert URL + title changed"],
    ["go_back", "navigate then go_back; assert returned to /core"],
    ["go_forward", "go_back then go_forward; assert at /forms again"],
    ["set_viewport", "set a mobile viewport; assert width applied"],
    ["tab_visibility", "set the tab hidden; assert visibilityState observed"],
  ]),
  ...rows("navigation", "/scroll", [["scroll", "scroll to the bottom anchor; assert the lazy content loaded"]]),

  // ---- action (76) ----
  ...rows("action", "/forms", [
    ["click", "click submit; assert the result region populated"],
    ["fill", "fill the name input; assert value set"],
    ["press", "focus an input and press Enter/Tab; assert effect"],
    ["shortcut", "press a keyboard shortcut (Ctrl/Cmd+A) in an input"],
    ["hover", "hover the hover-btn; assert hover-out flips to 'hovered'"],
    ["select", "select the 'editor' role option; assert value"],
    ["choose_option", "choose an option by label in the role select"],
    ["fill_form", "fill the whole signup form in one call; assert all values"],
    ["wait_for", "wait for the result region to become visible after submit"],
    ["execute", "execute a previously planned click descriptor; assert dispatch"],
  ]),
  ...rows("action", "/gestures", [
    ["drag", "drag the chip onto the drop target; assert drop-out updated"],
    ["double_click", "double-click the dbl button; assert counter increments"],
    ["mouse_down", "press the mouse button over the touchpad; assert pointer count"],
    ["mouse_move", "move the mouse across the touchpad"],
    ["mouse_up", "release the mouse button; assert pointer count drops"],
    ["mouse_wheel", "wheel-scroll with ctrl over the touchpad; assert pinch-zoom log"],
    ["touch_start", "start a touch on the touchpad; assert touches:1"],
    ["touch_move", "move the touch; assert move-touches updated"],
    ["touch_end", "end the touch; assert release"],
    ["gesture_pinch", "pinch the touchpad; assert a multi-touch gesture dispatched"],
    ["gesture_swipe", "swipe the touchpad; assert a swipe dispatched"],
  ]),
  ...rows("action", "/network", [
    ["route", "route /api/json to a stub body; assert the stub returned"],
    ["route_queue", "queue staged responses for repeated /api/json calls"],
    ["unroute", "remove the route; assert the real body returns"],
    ["network_emulate", "emulate offline/slow; assert a fetch reflects it"],
    ["ws_send", "inject a frame on the echo socket; assert echo received"],
    ["ws_intercept", "rewrite an inbound ws frame before the page sees it"],
    ["ws_unintercept", "remove the ws interception; assert frames pass through"],
    ["start_har", "start HAR recording; assert armed"],
    ["stop_har", "stop HAR; assert a workspace-rooted .har written"],
  ]),
  ...rows("action", "/storage", [
    ["cookies_set", "set a cookie; assert readback"],
    ["cookies_delete", "delete a cookie; assert gone"],
    ["cookies_clear", "clear cookies; assert empty"],
    ["localstorage_set", "set a localStorage key; assert readback"],
    ["localstorage_delete", "delete a localStorage key; assert gone"],
    ["localstorage_clear", "clear localStorage; assert empty"],
    ["sessionstorage_set", "set a sessionStorage key; assert readback"],
    ["sessionstorage_delete", "delete a sessionStorage key; assert gone"],
    ["sessionstorage_clear", "clear sessionStorage; assert empty"],
    ["idb_put", "put an IndexedDB value; assert readback"],
    ["idb_delete", "delete an IndexedDB key; assert gone"],
    ["idb_clear", "clear an IndexedDB store; assert empty"],
    ["caches_put", "put a Cache API entry; assert readback"],
    ["caches_delete", "delete a Cache API entry; assert gone"],
    ["caches_clear", "clear a cache storage's entries; assert empty"],
    ["caches_delete_storage", "delete the whole cache storage; assert gone"],
    ["inject_storage_state", "inject a storage-state blob; assert applied"],
    ["auth_save", "save the current auth/storage state under a name"],
    ["auth_load", "load a saved auth profile; assert applied"],
    ["auth_delete", "delete a saved auth profile; assert gone"],
    ["artifact_save", "save a session artifact; assert id returned"],
  ]),
  ...rows("action", "/dialogs", [
    ["set_dialog_policy", "set accept policy then click confirm; assert confirm:true"],
  ]),
  ...rows("action", "/permissions", [
    ["grant_permissions", "grant geolocation; assert getCurrentPosition resolves"],
    ["set_permission_policy", "set a per-permission policy; assert query reflects it"],
    ["set_notification_policy", "set notification policy; assert Notification ctor governed"],
    ["set_geolocation", "set geolocation coords; assert getCurrentPosition returns them"],
  ]),
  ...rows("action", "/media-files", [
    ["set_fs_picker_policy", "set the FS picker policy to allow; pair with fs_picker_respond"],
    ["pdf_save", "save the page to a workspace PDF; assert bytes written"],
  ]),
  ...rows("action", "/core", [
    ["set_locale", "set locale to fr-FR; assert navigator.language reflects it"],
    ["set_timezone", "set timezone to Asia/Tokyo; assert Date offset reflects it"],
    ["set_color_scheme", "set dark; assert matchMedia(prefers-color-scheme:dark)"],
    ["set_reduced_motion", "set reduce; assert matchMedia(prefers-reduced-motion)"],
    ["set_user_agent", "set a custom UA; assert navigator.userAgent reflects it"],
  ]),
  ...rows("action", "/perf", [
    ["perf_start", "arm performance tracing on the perf page"],
    ["perf_stop", "stop tracing; assert a workspace-rooted trace written"],
    ["perf_insights", "read insights from the written trace; assert structured summary"],
    ["coverage_start", "arm JS/CSS coverage before interaction"],
    ["heap_snapshot", "take a heap snapshot; assert a .heapsnapshot written"],
    ["heap_retainers", "query retainers of __retained; assert holders reported"],
    ["cpu_emulate", "throttle CPU 4x; assert the compute button is slower"],
    ["clock", "install a fake clock; assert page Date is controlled"],
    ["seed_random", "seed Math.random; assert deterministic sequence"],
    ["flake_check", "run a batch N times; assert a stability summary"],
  ]),
  ...rows("action", "/workers", [
    ["worker_message_send", "post a message to the dedicated worker; assert reply"],
    ["sw_intercept_fetch", "intercept a SW fetch for /workers/sw-ping; assert rewritten"],
    ["sw_unintercept_fetch", "remove the SW fetch interception; assert pass-through"],
  ]),

  // ---- human (10) ----
  ...rows("human", "/core", [
    ["name_ref", "name the ping button ref 'pingBtn'; assert stored"],
    ["name_region", "name a bbox region; assert stored"],
    ["region", "resolve a named region back to a bbox"],
    ["start_recording", "start an action recording; assert armed"],
    ["end_recording", "end the recording; assert a trace returned"],
    ["record_annotate", "annotate the recording with a note"],
    ["await_human", "request human input with a short timeout; assert the timeout path"],
    ["find_feedback", "submit find feedback for a prior find; assert accepted"],
    ["profile_snapshot", "snapshot the session profile; assert id"],
    ["profile_restore", "restore the snapshot; assert applied"],
  ]),

  // ---- eval (2) ----
  ...rows("eval", "/core", [
    ["eval_js", "eval `document.title`; assert it equals the core title"],
    ["poll_eval", "poll `window.__counter`; assert it advances"],
  ]),

  // ---- file-io (13) ----
  ...rows("file-io", "/media-files", [
    ["upload_file", "upload a workspace file into the file input; assert file-out shows it"],
    ["drop_files", "drop a file onto the drop zone; assert dropped:name"],
    ["downloads_capture", "arm download capture then click the download link"],
    ["download_get", "fetch the captured download bytes; assert contents"],
    ["fs_picker_respond", "stage a file for the open picker; assert the page received it"],
    ["page_archive", "archive the page to the workspace; assert index.html written"],
    ["element_export", "export the media card element; assert an HTML snippet written"],
    ["dom_export", "dump the full DOM; assert outerHTML/jsonl written"],
    ["asset_export", "filter the network ring and persist a response asset"],
    ["screenshot_schedule", "schedule periodic screenshots into the workspace"],
    ["screenshot_on", "arm event-driven screenshots; assert files written"],
    ["get_video", "after a recorded session, get the .webm; assert bytes"],
    ["stop_video", "signal video finalize; assert finalize path"],
  ]),

  // ---- network-body (1) ----
  ...rows("network-body", "/network", [
    ["network_body", "read the full /api/secret response body; assert token field present (then masked by secrets)"],
  ]),

  // ---- secrets (1) ----
  ...rows("secrets", "/network", [
    ["register_secret", "register the token value; assert it is masked in subsequent egress (network_body/console)"],
  ]),

  // ---- canvas (5) ----
  ...rows("canvas", "/canvas", [
    ["canvas_capture", "capture the canvas framebuffer; assert PNG bytes"],
    ["canvas_diff", "capture, recolor, capture again, diff; assert a non-zero delta"],
    ["canvas_query", "query the canvas via adapter; assert structured no-adapter error (no plugin registered)"],
    ["canvas_world_to_screen", "map a world point via __canvasApp; assert screen coords"],
    ["canvas_screen_to_world", "map a screen point back; assert world coords roundtrip"],
    ["gesture_chain", "dispatch a pointer stroke program; assert __lastStroke recorded"],
  ]),

  // ---- device-emulation (4) ----
  ...rows("device-emulation", "/devices", [
    ["emulate_bluetooth", "register a synthetic BT device; click req-bluetooth; assert bt:<name>"],
    ["emulate_usb", "register a synthetic USB device; click req-usb; assert usb:<product>"],
    ["emulate_hid", "register a synthetic HID device; click req-hid; assert hid:1"],
    ["device_requests", "read the device-request log; assert the page's requestDevice calls"],
  ]),

  // ---- diagnostics (1) ----
  ...rows("diagnostics", "/core", [
    ["diagnostics_note", "file a diagnostics note; assert it is retrievable via diagnostics_search"],
  ]),

  // ---- captcha (1) ----
  ...rows("captcha", "/forms", [
    ["solve_captcha", "call with no provider configured; assert a structured 'no provider' result (correct behavior)"],
  ]),

  // ---- credentials (2) ----
  ...rows("credentials", "/forms", [
    ["get_totp", "call with no provider configured; assert a structured 'no provider' result"],
    ["get_credential", "call with no provider configured; assert a structured 'no provider' result"],
  ]),

  // ---- extensions (5) ----
  ...rows("extensions", "/core", [
    ["extensions_install", "install a tiny test extension; assert id (skip if headless/incognito refuses)"],
    ["extensions_list", "list installed extensions; assert the installed id or empty"],
    ["extensions_reload", "reload the test extension; assert ok or structured refusal"],
    ["extensions_trigger", "trigger the extension's action; assert effect or refusal"],
    ["extensions_uninstall", "uninstall the test extension; assert gone or refusal"],
  ]),

  // ---- control plane (10) ----
  ...rows("control", undefined, [
    ["open_session", "open a fresh session; assert a session id"],
    ["close_session", "close one session; assert closed"],
    ["close_sessions", "close all sessions; assert count"],
    ["list_sessions", "list sessions; assert the bound session present"],
    ["batch", "run a small batch (navigate+find); assert per-step results"],
    ["get_config", "read the resolved config; assert a known key"],
    ["set_config", "patch a config value; assert get reflects it"],
    ["reset_config", "reset config to defaults; assert the patch reverted"],
    ["list_approvals", "list pending approvals; assert an array"],
    ["approve_actions", "approve a queued action (if any); assert accepted or empty"],
  ]),
];

/** All capabilities the harness asks the SDK to enable (everything real; the
 *  synthetic "control" bucket is not a real capability). */
export const HARNESS_CAPABILITIES = [
  "read",
  "navigation",
  "action",
  "human",
  "eval",
  "byob-attach",
  "file-io",
  "network-body",
  "clipboard",
  "secrets",
  "extensions",
  "stealth",
  "captcha",
  "credentials",
  "device-emulation",
  "diagnostics",
  "canvas",
] as const;
