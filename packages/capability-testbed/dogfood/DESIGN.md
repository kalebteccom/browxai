# Capability Testbed Dogfood Design

This document designs a host-side dogfood runner for the browxai capability
testbed. The runner starts the existing 16-surface web app, starts a host-owned
browxai MCP server with diagnostics enabled, spawns a real Codex session through
the `codex app-server` JSON-RPC protocol, asks Codex to complete fixed browser
missions through browxai, captures the full Codex plus browxai trace, and
computes coverage and friction reports across repeated runs.

## 1. RUNTIME ARCHITECTURE

### Dependency Decision

Do not depend on published `@remotxai/adapter-codex`. Mirror the minimal
app-server JSON-RPC client inline in `packages/capability-testbed/dogfood/`.

Reasons from the remotxai source:

- `adapters/codex/package.json` marks `@remotxai/adapter-codex` as
  `"private": true`, uses `LicenseRef-Proprietary`, and depends on the
  workspace-only `@remotxai/adapter-contract`. It is not a stable public package
  the browxai repo should depend on.
- The exported `./session` entry contains the useful `CodexAppServerOwn` class,
  but its default `SpawnFn` always spawns `codex app-server` with no additional
  CLI config arguments. This dogfood runner must inject a run-scoped MCP server
  config for browxai before the app-server starts.
- The remotxai `app-server-own.ts` and `app-server.ts` prove the protocol shape
  we should mirror: stdio newline-delimited JSON-RPC for owned app-servers,
  `initialize`, `initialized`, `thread/start`, `turn/start`, `turn/interrupt`,
  server requests for approvals, item notifications, plan updates, reasoning
  items, and `turn/completed` usage.
- `packages/codex-mcp-forwarder` proves an important negative: Codex has no
  dynamic tool-registration channel in `ThreadStartParams`; MCP tools must be
  known from Codex config before `codex app-server` starts. The forwarder itself
  only exposes remotxai-specific `expose_artifact` and `track_process`, so it is
  not part of this runner.

The inline mirror should keep the remotxai names where useful, but not import
them:

- `CodexOwnOptions`: `cwd`, `model`, `effort`, `sandbox`, `approvalPolicy`.
- `CodexChild` and `SpawnFn`: injectable child process boundary for tests.
- `InlineCodexAppServerOwn`: a local class compatible with the useful subset of
  remotxai `CodexAppServerOwn`.
- Methods mirrored from remotxai: `onRaw(handler)`, `events()`, `startTurn()`,
  `interrupt()`, `stop()`, `nativeId()`, `onNativeId(handler)`, `pid()`.
- Event helpers mirrored locally: `buildCodexTurnInput`, `extractCodexUsage`,
  `extractCodexPlanItems`, `extractCodexProse`, and the `mcpToolCall` subset of
  `mapNotification`.

### Process Topology

All browser-owning processes run host-side, outside the model-generated command
sandbox:

```text
haiku wrapper process
  pnpm --filter @browxai/capability-testbed serve
    serves the 16-surface test app on localhost
  pnpm exec browxai serve --socket <runRoot>/browxai.sock
    owns the browser, sessions, diagnostics JSONL, and capability gates
  codex app-server -c mcp_servers.browxai.*
    owns the model thread only
    mcp server command: node dogfood/dist/browxai-socket-proxy.js --socket <sock>
      stdio MCP on Codex side, Unix-socket MCP on browxai side
```

The Codex sandbox is deliberately `read-only`, with
`approvalPolicy: "never"`. That sandbox constrains model-generated shell
commands. It does not launch Chromium. Chromium is launched by the already
running host-owned `browxai serve --socket` process, so browser startup is not
blocked by Codex filesystem or network sandboxing. The only Codex-side MCP
subprocess is a byte-forwarding stdio proxy that connects to the host-owned
Unix socket.

### Host Startup

The wrapper chooses a run id and run root:

```text
runId = <ISO timestamp>-<short random>
runRoot = <repo>/packages/capability-testbed/dogfood/runs/<runId>
BROWX_WORKSPACE = <runRoot>/workspace
browxaiSocket = <runRoot>/browxai.sock
```

The wrapper must not use port `0` for the test app. `startServer(0)` would
listen on an OS-selected port but still report `http://localhost:0`, because
the current implementation builds the URL from the requested port. The wrapper
instead probes a free port in a bounded range, then starts:

```bash
TESTBED_PORT=<freePort> pnpm --filter @browxai/capability-testbed serve
```

It waits for:

```text
GET http://localhost:<freePort>/healthz -> {"ok":true}
```

Then it starts browxai:

```bash
BROWX_WORKSPACE=<runRoot>/workspace \
BROWX_CAPABILITIES=read,navigation,action,human,eval,byob-attach,file-io,network-body,clipboard,secrets,extensions,stealth,captcha,credentials,device-emulation,diagnostics,canvas \
BROWX_HEADLESS=0 \
pnpm exec browxai serve --socket <runRoot>/browxai.sock
```

`BROWX_HEADLESS=0` is the default dogfood posture because extension and headed
browser behavior should be measured. CI and constrained machines may pass
`--headless`, which sets `BROWX_HEADLESS=1`; reports must then preserve
structured extension or media refusals rather than hiding them.

The wrapper preflights that `dist/cli.js` exists and is newer than the source
files relevant to the run. If it is stale, the wrapper fails with a direct
message to run `pnpm build`. It does not silently rebuild, because dogfood
reports must state exactly which git SHA and build output they measured.

### Codex Spawn And MCP Wiring

The inline `InlineCodexAppServerOwn` spawns:

```bash
codex app-server \
  -c 'mcp_servers.browxai.command="node"' \
  -c 'mcp_servers.browxai.args=["<dogfoodDist>/browxai-socket-proxy.js","--socket","<runRoot>/browxai.sock"]' \
  -c 'mcp_servers.browxai.startup_timeout_sec=30' \
  -c 'mcp_servers.browxai.tool_timeout_sec=180'
```

The child uses stdio JSON-RPC frames, matching remotxai `CodexAppServerOwn`.
The inline client sends:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"browxai-dogfood","title":null,"version":"0.0.0"},"capabilities":null}}
```

After the initialize response, it sends:

```json
{"method":"initialized","params":{}}
```

For a fresh mission run it sends `thread/start` with the exact pinned defaults:

```json
{
  "model": "gpt-5.3-codex",
  "reasoningEffort": "xhigh",
  "sandbox": "read-only",
  "approvalPolicy": "never"
}
```

These defaults are runner config, not mission data. They can be overridden by
explicit wrapper flags, but every override is written into the trace and report.

The client captures the native thread id from the `thread/start` result or a
`thread/started` notification, just as remotxai `setThreadId()` does. The
mission `sessionId` used in the report is:

```text
dogfood-<missionId>-r<runIndex>-<codexThreadIdSuffix>
```

The mission prompt asks Codex to use that session id explicitly in browxai MCP
calls. This keeps browxai diagnostics JSONL partitioned by mission run.

### Mission Turn

The runner sends one `turn/start` per mission run:

```json
{
  "threadId": "<nativeCodexThreadId>",
  "input": [
    {
      "type": "text",
      "text": "<mission prompt>"
    }
  ]
}
```

The prompt contains only:

- the test app base URL;
- the browxai session id to use;
- the plain-language mission goal from the catalog;
- a requirement to use the `browxai` MCP server, not shell/browser shortcuts;
- a final machine-readable marker:
  `DOGFOOD_MISSION_DONE {"missionId":"...","status":"done|blocked","reflection":"..."}`.

The prompt never includes `expectedTools`, oracle file names, assertion text, or
coverage targets.

### Structured Events Read Back

The inline client stores every raw JSON-RPC frame through `onRaw()` and also
normalizes the subset needed by dogfood:

- `item/started` and `item/completed` with `params.item.type == "mcpToolCall"`
  become per-tool events. If `item.server` or `item.serverName` is `browxai`,
  the normalized label is exactly `mcp browxai:<tool>`.
- `item/completed` with `params.item.type == "reasoning"` becomes a reasoning
  item using the same extraction as remotxai `extractCodexProse("reasoning")`.
- `turn/plan/updated` and older completed `plan` items become plan item
  snapshots using the same accepted fields as remotxai
  `extractCodexPlanItems`: `step`, `content`, or `text`; status values
  `pending`, `inProgress`/`in_progress`, and `completed`.
- `turn/started` marks the run active; `turn/completed` marks it idle and ends
  the mission turn.
- `turn/completed.params.usage` is captured directly. The runner reads
  `inputTokens`, `outputTokens`, `cachedTokens`, `totalTokens`, and
  `contextWindow`. The `TraceRecord.tokenUsage` fields use
  `input = inputTokens + cachedTokens`, `output = outputTokens`, and
  `total = totalTokens` when present, otherwise `input + output`.

### Mission End And Cleanup

A mission run ends when both are true:

- a root-thread `turn/completed` notification has been received;
- the assistant prose contains the `DOGFOOD_MISSION_DONE` marker.

If `turn/completed` arrives without the marker, the run is complete but the
mission outcome is failed with `failReason: "missing mission done marker"`. If
the wall-clock mission timeout expires first, the runner sends `turn/interrupt`
with `{threadId, turnId}` if a turn id was observed, marks open tool calls as
abandoned, and stops the owned app-server process.

The host-owned test app and browxai server remain up across all K runs in a
single wrapper invocation. Each mission run uses a fresh browxai session id.
At the end of the whole wrapper run, the wrapper closes the Codex app-server
child, browxai socket server, test app server, and any temporary stdio proxy
children.

## 2. MISSION CATALOG FORMAT

The catalog is a git-tracked TypeScript file, `dogfood/src/missions/catalog.ts`.
Each row is data only:

```ts
export interface DogfoodMission {
  id: string;
  capabilityTags: string[];
  surfaces: string[];
  goal: string;
  oracle: {
    exerciseTools: string[];
    sourceFiles: string[];
  };
  expectedTools: string[];
  kRuns: number;
}
```

Field rules:

- `id`: stable kebab-case identifier.
- `capabilityTags`: capability names from `src/harness/types.ts`, including the
  row-backed manifest capabilities and the behavior-only entries in
  `HARNESS_CAPABILITIES`.
- `surfaces`: surface ids from `src/server/pages/index.ts`: `core`, `forms`,
  `dialogs`, `frames`, `shadow`, `scroll`, `network`, `workers`, `storage`,
  `media-files`, `permissions`, `canvas`, `gestures`, `devices`, `console`,
  `perf`.
- `goal`: the exact prompt fragment shown to Codex.
- `oracle.exerciseTools`: tool names whose existing `EXERCISES[tool]` entries
  are run by the host-side verifier after the Codex turn. Oracles run in a
  separate verifier session and are not included in the Codex trace.
- `oracle.sourceFiles`: human-readable source files that own those assertions.
- `expectedTools`: manifest tool names used for coverage scoring. These are
  not included in the mission prompt.
- `kRuns`: independent Codex runs for this mission. Default is `5`; a mission
  may use `3` only when the tool surface is exceptionally expensive.

The catalog is validated at startup:

```ts
const manifestTools = new Set(MANIFEST.map((row) => row.tool));
const manifestCaps = new Set(MANIFEST.map((row) => row.capability));
const surfaceIds = new Set(surfaces().map((surface) => surface.id));

assertEvery(expectedTools, manifestTools);
assertEvery(capabilityTags.filter(rowBacked), manifestCaps);
assertSetEquals(union(CATALOG.surfaces), surfaceIds);
assertSetEquals(union(CATALOG.expectedTools), manifestTools);
assertSetEquals(union(CATALOG.capabilityTags).filter(rowBacked), manifestCaps);
```

Behavior-only capabilities in `HARNESS_CAPABILITIES` that do not have their own
manifest row today are tagged explicitly:

- `clipboard`: forms mission, through clipboard-oriented fields and shortcut
  behavior.
- `stealth`: core mission, through the fingerprint readout surface.
- `byob-attach`: recorded as enabled posture only. This runner intentionally
  uses managed host-owned Chromium, not BYOB attach, so its report marks the
  capability as rowless until a separate BYOB mission is added.

Initial fixed catalog:

```ts
export const CATALOG: DogfoodMission[] = [
  {
    id: "core-read-control",
    capabilityTags: ["read", "navigation", "human", "eval", "action", "control", "diagnostics", "stealth", "byob-attach"],
    surfaces: ["core"],
    goal: "Open the core surface, inspect the greeting, unique needle, fruit list, overflow box, fingerprint panel, and Ping button. Exercise navigation history, named refs or regions, recording, eval-style observation where needed, and finish with a concise report of what changed after Ping.",
    oracle: {
      sourceFiles: ["read-core.ts", "navigation.ts", "human.ts", "eval.ts", "control.ts", "diagnostics.ts", "read-data.ts", "action-policy.ts"],
      exerciseTools: [
        "snapshot", "find", "inspect", "extract", "text_search", "point_probe",
        "overflow_detect", "generate_locator", "list_named_refs", "screenshot",
        "screenshot_region", "screenshot_marks", "verify_visible",
        "verify_text", "verify_value", "verify_count", "verify_attribute",
        "verify_predicate", "watch", "sample", "plan", "navigate", "go_back",
        "go_forward", "set_viewport", "tab_visibility", "name_ref",
        "name_region", "region", "start_recording", "end_recording",
        "record_annotate", "await_human", "find_feedback",
        "profile_snapshot", "profile_restore", "eval_js", "poll_eval",
        "set_locale", "set_timezone", "set_color_scheme",
        "set_reduced_motion", "set_user_agent", "open_session",
        "close_session", "close_sessions", "list_sessions", "batch",
        "get_config", "set_config", "reset_config", "list_approvals",
        "approve_actions", "artifact_save", "artifact_get", "artifact_list",
        "diagnostics_note", "diagnostics_search", "diagnostics_report",
        "session_metrics", "export_session_report",
        "export_playwright_script", "plugins_info", "plugins_list"
      ]
    },
    expectedTools: [
      "snapshot", "find", "inspect", "extract", "text_search", "point_probe",
      "overflow_detect", "generate_locator", "list_named_refs", "screenshot",
      "screenshot_region", "screenshot_marks", "verify_visible",
      "verify_text", "verify_value", "verify_count", "verify_attribute",
      "verify_predicate", "watch", "sample", "plan", "navigate", "go_back",
      "go_forward", "set_viewport", "tab_visibility", "name_ref",
      "name_region", "region", "start_recording", "end_recording",
      "record_annotate", "await_human", "find_feedback",
      "profile_snapshot", "profile_restore", "eval_js", "poll_eval",
      "set_locale", "set_timezone", "set_color_scheme",
      "set_reduced_motion", "set_user_agent", "open_session",
      "close_session", "close_sessions", "list_sessions", "batch",
      "get_config", "set_config", "reset_config", "list_approvals",
      "approve_actions", "artifact_save", "artifact_get", "artifact_list",
      "diagnostics_note", "diagnostics_search", "diagnostics_report",
      "session_metrics", "export_session_report", "export_playwright_script",
      "plugins_info", "plugins_list"
    ],
    kRuns: 5
  },
  {
    id: "forms-input-providers",
    capabilityTags: ["action", "captcha", "credentials", "clipboard"],
    surfaces: ["forms"],
    goal: "Use the forms surface like a real signup workflow: fill several fields, choose a role, submit, verify the reflected JSON, exercise hover or keyboard input, and probe the provider-backed captcha or credential helpers only enough to record their structured availability.",
    oracle: {
      sourceFiles: ["action-input.ts", "credentials-captcha.ts"],
      exerciseTools: ["click", "fill", "press", "shortcut", "hover", "select", "choose_option", "fill_form", "wait_for", "execute", "solve_captcha", "get_totp", "get_credential"]
    },
    expectedTools: ["click", "fill", "press", "shortcut", "hover", "select", "choose_option", "fill_form", "wait_for", "execute", "solve_captcha", "get_totp", "get_credential"],
    kRuns: 5
  },
  {
    id: "dialogs-policy",
    capabilityTags: ["action"],
    surfaces: ["dialogs"],
    goal: "Visit the dialogs surface, set a dialog policy, trigger confirm or prompt behavior, and verify the page records the expected dialog outcome without hanging.",
    oracle: {
      sourceFiles: ["action-policy.ts"],
      exerciseTools: ["set_dialog_policy"]
    },
    expectedTools: ["set_dialog_policy"],
    kRuns: 5
  },
  {
    id: "frames-tree",
    capabilityTags: ["read"],
    surfaces: ["frames"],
    goal: "Inspect the frames surface and report the parent, children, and grandchild frame structure.",
    oracle: {
      sourceFiles: ["read-core.ts"],
      exerciseTools: ["frames_list"]
    },
    expectedTools: ["frames_list"],
    kRuns: 5
  },
  {
    id: "shadow-dom",
    capabilityTags: ["read"],
    surfaces: ["shadow"],
    goal: "Inspect the shadow DOM surface and distinguish open shadow content from closed-shadow limitations.",
    oracle: {
      sourceFiles: ["read-core.ts"],
      exerciseTools: ["shadow_trees"]
    },
    expectedTools: ["shadow_trees"],
    kRuns: 5
  },
  {
    id: "scroll-overflow",
    capabilityTags: ["navigation"],
    surfaces: ["scroll"],
    goal: "Use the scroll surface to reach the bottom sentinel and confirm that lazy content appears.",
    oracle: {
      sourceFiles: ["navigation.ts"],
      exerciseTools: ["scroll"]
    },
    expectedTools: ["scroll"],
    kRuns: 5
  },
  {
    id: "network-http-ws-secrets",
    capabilityTags: ["read", "action", "network-body", "secrets"],
    surfaces: ["network"],
    goal: "Drive the network surface through JSON fetches and the echo WebSocket. Observe network metadata, route or queue a response, send or intercept a WebSocket frame, and verify the secret endpoint body is masked after registering the secret.",
    oracle: {
      sourceFiles: ["read-data.ts", "action-network.ts", "network-body-secrets.ts"],
      exerciseTools: [
        "network_read", "ws_read", "act_and_diff", "act_and_sample",
        "act_and_wait_for_network", "cross_session_sample", "route",
        "route_queue", "unroute", "network_emulate", "ws_send",
        "ws_intercept", "ws_unintercept", "start_har", "stop_har",
        "network_body", "register_secret"
      ]
    },
    expectedTools: [
      "network_read", "ws_read", "act_and_diff", "act_and_sample",
      "act_and_wait_for_network", "cross_session_sample", "route",
      "route_queue", "unroute", "network_emulate", "ws_send",
      "ws_intercept", "ws_unintercept", "start_har", "stop_har",
      "network_body", "register_secret"
    ],
    kRuns: 5
  },
  {
    id: "workers-and-service-worker",
    capabilityTags: ["read", "action"],
    surfaces: ["workers"],
    goal: "Use the workers surface to spawn the dedicated worker, observe its messages, register the service worker, and verify intercepted then pass-through service-worker fetch behavior.",
    oracle: {
      sourceFiles: ["workers.ts"],
      exerciseTools: ["workers_list", "worker_messages_read", "worker_message_send", "sw_intercept_fetch", "sw_unintercept_fetch"]
    },
    expectedTools: ["workers_list", "worker_messages_read", "worker_message_send", "sw_intercept_fetch", "sw_unintercept_fetch"],
    kRuns: 5
  },
  {
    id: "storage-crud-auth",
    capabilityTags: ["read", "action"],
    surfaces: ["storage"],
    goal: "Seed and inspect the storage surface, then perform representative cookie, localStorage, sessionStorage, IndexedDB, Cache API, storage-state, and auth-slot operations. Verify each operation through readback.",
    oracle: {
      sourceFiles: ["read-data.ts", "action-storage.ts"],
      exerciseTools: [
        "cookies_get", "cookies_list", "localstorage_get",
        "localstorage_list", "sessionstorage_get", "sessionstorage_list",
        "idb_get", "idb_list_databases", "idb_list_stores",
        "caches_get", "caches_list", "caches_list_storages",
        "dump_storage_state", "auth_list", "cookies_set",
        "cookies_delete", "cookies_clear", "localstorage_set",
        "localstorage_delete", "localstorage_clear", "sessionstorage_set",
        "sessionstorage_delete", "sessionstorage_clear", "idb_put",
        "idb_delete", "idb_clear", "caches_put", "caches_delete",
        "caches_clear", "caches_delete_storage", "inject_storage_state",
        "auth_save", "auth_load", "auth_delete"
      ]
    },
    expectedTools: [
      "cookies_get", "cookies_list", "localstorage_get",
      "localstorage_list", "sessionstorage_get", "sessionstorage_list",
      "idb_get", "idb_list_databases", "idb_list_stores",
      "caches_get", "caches_list", "caches_list_storages",
      "dump_storage_state", "auth_list", "cookies_set",
      "cookies_delete", "cookies_clear", "localstorage_set",
      "localstorage_delete", "localstorage_clear", "sessionstorage_set",
      "sessionstorage_delete", "sessionstorage_clear", "idb_put",
      "idb_delete", "idb_clear", "caches_put", "caches_delete",
      "caches_clear", "caches_delete_storage", "inject_storage_state",
      "auth_save", "auth_load", "auth_delete"
    ],
    kRuns: 5
  },
  {
    id: "media-files-exports",
    capabilityTags: ["file-io", "action"],
    surfaces: ["media-files"],
    goal: "Use the media and files surface to exercise upload, drop, download capture, file-picker response, page and element export, DOM and asset export, scheduled screenshots, event screenshots, PDF save, and video metadata where available.",
    oracle: {
      sourceFiles: ["file-io.ts", "action-policy.ts"],
      exerciseTools: [
        "upload_file", "drop_files", "downloads_capture", "download_get",
        "fs_picker_respond", "page_archive", "element_export",
        "dom_export", "asset_export", "screenshot_schedule",
        "screenshot_on", "get_video", "stop_video",
        "set_fs_picker_policy", "pdf_save"
      ]
    },
    expectedTools: [
      "upload_file", "drop_files", "downloads_capture", "download_get",
      "fs_picker_respond", "page_archive", "element_export",
      "dom_export", "asset_export", "screenshot_schedule",
      "screenshot_on", "get_video", "stop_video",
      "set_fs_picker_policy", "pdf_save"
    ],
    kRuns: 3
  },
  {
    id: "permissions-and-geolocation",
    capabilityTags: ["read", "action"],
    surfaces: ["permissions"],
    goal: "Use the permissions surface to inspect permission state, grant or deny geolocation and notifications, set synthetic geolocation, and verify the page output reflects the policy.",
    oracle: {
      sourceFiles: ["read-core.ts", "action-policy.ts"],
      exerciseTools: ["permission_state", "grant_permissions", "set_permission_policy", "set_notification_policy", "set_geolocation"]
    },
    expectedTools: ["permission_state", "grant_permissions", "set_permission_policy", "set_notification_policy", "set_geolocation"],
    kRuns: 5
  },
  {
    id: "canvas-automation",
    capabilityTags: ["canvas", "read"],
    surfaces: ["canvas"],
    goal: "Use the canvas surface to capture pixels, recolor and compare the scene, test missing-adapter canvas query behavior, map coordinates through the app transform, and draw a pointer stroke.",
    oracle: {
      sourceFiles: ["canvas.ts"],
      exerciseTools: ["canvas_capture", "canvas_diff", "canvas_query", "canvas_world_to_screen", "canvas_screen_to_world", "gesture_chain"]
    },
    expectedTools: ["canvas_capture", "canvas_diff", "canvas_query", "canvas_world_to_screen", "canvas_screen_to_world", "gesture_chain"],
    kRuns: 5
  },
  {
    id: "gestures-pointer-touch",
    capabilityTags: ["action"],
    surfaces: ["gestures"],
    goal: "Use the gestures surface to drag the chip, double click, dispatch mouse movement and wheel input, and exercise touch, pinch, and swipe paths with page-visible evidence.",
    oracle: {
      sourceFiles: ["action-gestures.ts"],
      exerciseTools: ["drag", "double_click", "mouse_down", "mouse_move", "mouse_up", "mouse_wheel", "touch_start", "touch_move", "touch_end", "gesture_pinch", "gesture_swipe"]
    },
    expectedTools: ["drag", "double_click", "mouse_down", "mouse_move", "mouse_up", "mouse_wheel", "touch_start", "touch_move", "touch_end", "gesture_pinch", "gesture_swipe"],
    kRuns: 5
  },
  {
    id: "devices-synthetic",
    capabilityTags: ["device-emulation"],
    surfaces: ["devices"],
    goal: "Use the devices surface to stage synthetic Bluetooth, USB, and HID devices, trigger each request button, and inspect the captured device request log.",
    oracle: {
      sourceFiles: ["devices.ts"],
      exerciseTools: ["emulate_bluetooth", "emulate_usb", "emulate_hid", "device_requests"]
    },
    expectedTools: ["emulate_bluetooth", "emulate_usb", "emulate_hid", "device_requests"],
    kRuns: 5
  },
  {
    id: "console-observation",
    capabilityTags: ["read"],
    surfaces: ["console"],
    goal: "Use the console surface to emit each console level and verify the console ring captures them.",
    oracle: {
      sourceFiles: ["read-core.ts"],
      exerciseTools: ["console_read"]
    },
    expectedTools: ["console_read"],
    kRuns: 5
  },
  {
    id: "perf-diagnostics",
    capabilityTags: ["read", "action"],
    surfaces: ["perf"],
    goal: "Use the performance surface to trigger layout thrash, allocation, and compute work. Capture audits, traces, coverage, heap data, CPU throttling, clock control, random seeding, and flake checking where supported.",
    oracle: {
      sourceFiles: ["read-core.ts", "action-perf.ts"],
      exerciseTools: [
        "perf_audit", "layout_thrash_trace", "memory_diff",
        "coverage_stop", "perf_start", "perf_stop", "perf_insights",
        "coverage_start", "heap_snapshot", "heap_retainers",
        "cpu_emulate", "clock", "seed_random", "flake_check"
      ]
    },
    expectedTools: [
      "perf_audit", "layout_thrash_trace", "memory_diff",
      "coverage_stop", "perf_start", "perf_stop", "perf_insights",
      "coverage_start", "heap_snapshot", "heap_retainers",
      "cpu_emulate", "clock", "seed_random", "flake_check"
    ],
    kRuns: 3
  }
];
```

## 3. TRACE CAPTURE

The runner writes one replayable JSONL trace per mission run:

```text
<runRoot>/traces/<missionId>/run-<runIndex>.jsonl
```

Each line is either a raw Codex frame, a normalized Codex event, a copied
browxai diagnostics record, or the final `TraceRecord`. The report generator
only requires the final `TraceRecord`, but the earlier lines let a later tool
replay or re-normalize with improved logic.

### Inputs

Codex input streams:

- raw JSON-RPC messages from `InlineCodexAppServerOwn.onRaw()`;
- normalized `CodexEvent` values from `events()`;
- local timestamps recorded when the runner receives each frame.

browxai input streams:

- diagnostics JSONL records written by the diagnostics capability under:
  `$BROWX_WORKSPACE/diagnostics/<sessionId>/<server-start-ISO>.jsonl`;
- only records for the Codex mission session id are merged into the mission
  trace. Verifier oracle sessions use a different `oracle-` prefix and are
  excluded.

### Normalization

For every Codex `mcpToolCall` item:

- On `item/started`, store `{itemId, tool, server, args, startedAtMs}`.
- On `item/completed`, compute `durationMs = completedAtMs - startedAtMs`,
  attach `result`, and mark a tool event complete.
- The normalized tool label is `mcp browxai:<tool>` when the server is
  `browxai`. Non-browxai MCP calls are retained in raw trace lines but excluded
  from browxai coverage scoring.
- If an item starts but never completes before mission end or interrupt, emit a
  tool event with `abandoned: true`.

For browxai diagnostics records:

- Match to Codex tool events by `(sessionId, tool, ordinal)` first.
- If ordinals diverge, match by nearest timestamp within 2 seconds.
- Prefer Codex args and result for `TraceRecord.toolEvents.args/result` because
  diagnostics intentionally redacts args and stores only result metadata.
- Prefer diagnostics `durationMs` when Codex start or completion timestamps are
  missing.
- Preserve diagnostics `resultMeta.failureKind` in the tool event result under
  `result.__diagnostics.failureKind` when the Codex result does not already
  expose the failure.

Retries and abandons:

- `retried: true` when the same mission run contains an earlier completed event
  with the same `tool` and structurally equivalent normalized args, and the
  earlier event had `ok:false`, `isError:true`, or diagnostics
  `failureKind != undefined`.
- `abandoned: true` when a started event has no completion, or when the final
  answer states it could not complete the operation and no later successful
  call for the same tool appears.

Turns:

- The first turn is always the user mission prompt.
- Assistant prose from `agentMessage` items is appended to the current assistant
  turn.
- Tool calls are attached to the nearest assistant turn by event time.
- Reasoning items are stored separately and are not copied into turn content.

The normalized record shape is:

```ts
export interface TraceRecord {
  sessionId: string;
  missionId: string;
  runIndex: number;
  turns: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls: Array<{
      id: string;
      label: string; // "mcp browxai:<tool>"
      tool: string;  // "<tool>"
    }>;
  }>;
  toolEvents: Array<{
    tool: string;
    args: unknown;
    result: unknown;
    durationMs: number;
    retried: boolean;
    abandoned: boolean;
  }>;
  reasoningItems: Array<{
    text: string;
    atMs: number;
  }>;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
}
```

## 4. REPORT SCHEMA

The report generator consumes K `TraceRecord` values per mission plus the
host-side oracle results. Its output is one JSON report and one Markdown
summary:

```text
<runRoot>/reports/dogfood-report.json
<runRoot>/reports/dogfood-report.md
```

Full TypeScript-style schema:

```ts
export interface TraceRecord {
  sessionId: string;
  missionId: string;
  runIndex: number;
  turns: Array<{
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls: Array<{
      id: string;
      label: string;
      tool: string;
    }>;
  }>;
  toolEvents: Array<{
    tool: string;
    args: unknown;
    result: unknown;
    durationMs: number;
    retried: boolean;
    abandoned: boolean;
  }>;
  reasoningItems: Array<{
    text: string;
    atMs: number;
  }>;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
}

export interface DogfoodReport {
  metadata: {
    schemaVersion: 1;
    generatedAt: string;
    repoSha: string;
    repoDirty: boolean;
    testbedBaseUrl: string;
    browxaiCapabilities: string[];
    model: string;
    effort: string;
    sandbox: string;
    approvalPolicy: string;
    kDefault: number;
  };
  coverageMatrix: Record<
    string,
    {
      toolsTouched: string[];
      toolsMissed: string[];
      pct: number;
    }
  >;
  frictionMetrics: Record<
    string,
    {
      errorCount: number;
      retryCount: number;
      abandonCount: number;
      avgDurationMs: number;
      confusionScore: number;
    }
  >;
  missionOutcomes: Record<
    string,
    {
      passed: boolean;
      failReason?: string;
      agentReflection: string;
    }
  >;
  aggregateSummary: {
    totalToolsTouched: number;
    coveragePct: number;
    topFrictionTools: string[];
  };
  traces: Array<{
    missionId: string;
    runIndex: number;
    path: string;
  }>;
}
```

Coverage:

- For each capability, `toolsTouched` is the sorted intersection of:
  `MANIFEST` rows for that capability and tools seen in successful Codex
  `mcp browxai:<tool>` calls.
- `toolsMissed` is the manifest tool set for that capability minus
  `toolsTouched`.
- `pct = toolsTouched.length / (toolsTouched.length + toolsMissed.length) * 100`.
- Rowless behavior-only capabilities have empty tool sets. They are included in
  metadata and mission tags, but excluded from the denominator until the
  manifest grows concrete tool rows for them.

Friction metrics:

- `errorCount`: completed tool events whose result is `ok:false`, `isError:true`,
  or diagnostics `failureKind` is present.
- `retryCount`: number of tool events with `retried: true`.
- `abandonCount`: number of tool events with `abandoned: true`.
- `avgDurationMs`: arithmetic mean across completed events for the tool.
- `confusionScore`:

```ts
const attempts = Math.max(1, totalEventsForTool);
const errorRate = errorCount / attempts;
const retryRate = retryCount / attempts;
const abandonRate = abandonCount / attempts;
const latencyPenalty = Math.min(1, avgDurationMs / 10_000);
confusionScore = Math.round(
  100 * (0.35 * errorRate + 0.25 * retryRate + 0.25 * abandonRate + 0.15 * latencyPenalty)
);
```

Mission outcomes:

- `passed` is true only when the Codex turn ended, the final marker was present,
  and every `oracle.exerciseTools` verifier result is `pass` or an accepted
  environment `skip`.
- `failReason` is one concise reason when `passed` is false: timeout, missing
  final marker, oracle failure, app-server error, or browxai unavailable.
- `agentReflection` is the `reflection` field from the final marker. If the
  marker is absent, it is the final assistant prose truncated to 1000 chars.

Aggregate summary:

- `totalToolsTouched`: unique manifest tools touched by successful Codex calls.
- `coveragePct`: unique tools touched divided by `MANIFEST.length`.
- `topFrictionTools`: top five tool names sorted by `confusionScore`, then by
  `errorCount`, then by `retryCount`.

K-run aggregation:

- K independent runs reduce prompt stochasticity by separating one-off model
  choices from repeated usability problems.
- A tool is considered "covered" if it is touched successfully in any run.
- Friction counts sum across K; duration uses a trimmed mean when K >= 5
  (drop min and max), otherwise an arithmetic mean.
- A mission outcome is stable pass when at least `ceil(0.8 * K)` runs pass.
  It is unstable pass when at least one but fewer than `ceil(0.8 * K)` pass;
  unstable pass still contributes coverage but is listed in the Markdown risk
  section.

## 5. PACKAGE / DIR LAYOUT

Only `DESIGN.md` exists now. The implementation stage should add the following
tree under `packages/capability-testbed/dogfood/`:

```text
packages/capability-testbed/dogfood/
  DESIGN.md
  README.md
  src/
    haiku.ts
      Thin host-side wrapper. Parses flags/env, starts test app and browxai,
      invokes runner, and writes reports.
    runner.ts
      Mission loop. Runs K independent Codex sessions per mission.
    config.ts
      Pinned model, effort, sandbox, approval policy, timeouts, and paths.
    runtime/
      codex-app-server-own.ts
        Inline CodexAppServerOwn-compatible JSON-RPC client.
      codex-events.ts
        Local event types and notification normalization.
      browxai-socket-proxy.ts
        Stdio MCP proxy that connects to `browxai serve --socket`.
      processes.ts
        Host process start/stop, health checks, free-port probing.
    missions/
      schema.ts
        DogfoodMission schema and catalog validation.
      catalog.ts
        Git-tracked fixed mission catalog.
      prompt.ts
        Mission prompt builder that excludes oracle and expectedTools.
    oracle/
      exercise-oracle.ts
        Imports `../src/harness/driver.ts`, `EXERCISES`, and `MANIFEST`.
        Runs verifier sessions against selected `oracle.exerciseTools`.
    trace/
      trace-record.ts
        TraceRecord type and JSONL writer.
      codex-normalizer.ts
        Raw Codex frame plus CodexEvent to trace conversion.
      diagnostics-reader.ts
        Reads `$BROWX_WORKSPACE/diagnostics/<session>/<iso>.jsonl`.
      merge.ts
        Matches Codex mcpToolCall items with diagnostics call records.
    report/
      schema.ts
        DogfoodReport type.
      generator.ts
        Coverage, friction, outcomes, and Markdown generation.
    mock/
      mock-app-server.ts
        Fake `codex app-server` stdio JSON-RPC server for CI tests.
      mock-mcp-server.ts
        Fake MCP server/proxy target for CI validation.
      fixtures.ts
        Representative mcpToolCall, reasoning, plan, and usage frames.
  test/
    codex-app-server-own.test.ts
    trace-normalizer.test.ts
    report-generator.test.ts
    catalog-coverage.test.ts
    haiku-wrapper.test.ts
  runs/
    .gitkeep
```

The implementation should add a package script to
`packages/capability-testbed/package.json`:

```json
{
  "scripts": {
    "dogfood": "tsx dogfood/src/haiku.ts"
  }
}
```

Reuse rules:

- Do not duplicate the test app. Import or start the existing server from
  `src/server/http.ts`, or use the existing `serve` script for the real host
  run.
- Do not duplicate the manifest. Import `MANIFEST` and `HARNESS_CAPABILITIES`
  from `src/harness/manifest.ts`.
- Do not duplicate assertions. `oracle/exercise-oracle.ts` must call
  `buildContext()` and `runExercise()` from `src/harness/driver.ts`, so the
  same `EXERCISES[tool]` map remains the single assertion source.
- Mock app-server and mock MCP are for CI validation of the dogfood runner
  itself. They do not replace real Codex or real browxai in host dogfood runs.

## 6. REPRODUCIBILITY PLAN

Fixed inputs:

- Mission catalog is git-tracked in `dogfood/src/missions/catalog.ts`.
- Driver defaults are pinned in `dogfood/src/config.ts`:
  - model: `gpt-5.3-codex`;
  - effort: `xhigh`;
  - sandbox: `read-only`;
  - approvalPolicy: `never`;
  - default K: `5`.
- The test app version is the repository git SHA. Every report records
  `git rev-parse HEAD` and whether `git status --porcelain` was non-empty.
- The browxai server binary is the local `dist/cli.js`. The wrapper preflights
  that it exists and records its mtime. It fails on stale dist instead of
  silently rebuilding.
- The trace JSONL is the replayable artifact. It stores raw Codex frames,
  normalized events, copied browxai diagnostics records, final TraceRecord, and
  report metadata.

LLM non-determinism is acknowledged, not denied. The measurement remains useful
because:

- The test app, catalog, tool manifest, and oracle assertions are deterministic.
- K independent runs turn a single model choice into a distribution.
- Coverage is unioned across K, while friction is summed and duration is
  averaged or trimmed. Repeated retries, errors, or abandons survive aggregation;
  one-off exploration usually does not.
- Reports include raw traces, so a changed model behavior can be reclassified
  later without rerunning the browser.

Recommended K:

- Default: `K=5`.
- Expensive media/perf missions: default catalog uses `K=3`.
- Smoke mode: `--k 1 --mission <id>` is allowed but reports
  `aggregateStability: "single-run"` and must not be compared to full reports.

## 7. HAIKU RUNNER-WRAPPER

The wrapper is a thin Node entrypoint named `haiku.ts`. It is run by a human on
the host:

```bash
pnpm --filter @browxai/capability-testbed dogfood --mission all --k 5
```

Direct development form before the package script exists:

```bash
pnpm --filter @browxai/capability-testbed exec tsx dogfood/src/haiku.ts --mission all --k 5
```

Flags:

```text
--mission <id|all>             Mission id or all missions. Default: all.
--k <number>                   Override K for every selected mission.
--model <model>                Default: gpt-5.3-codex.
--effort <low|medium|high|xhigh>
                                Default: xhigh.
--sandbox <read-only|workspace-write|danger-full-access>
                                Default: read-only.
--approval-policy <never|on-request|on-failure|untrusted>
                                Default: never.
--workspace <path>             BROWX_WORKSPACE root. Default: <runRoot>/workspace.
--run-root <path>              Output root. Default: dogfood/runs/<runId>.
--testbed-port <number|auto>   Default: auto, implemented by probing free ports.
--browxai-socket <path>        Default: <runRoot>/browxai.sock.
--headless                     Set BROWX_HEADLESS=1.
--headed                       Set BROWX_HEADLESS=0. Default.
--timeout-ms <number>          Per mission turn timeout. Default: 900000.
--oracle-timeout-ms <number>   Per exercise oracle timeout. Default: 30000.
--codex-bin <path>             Default: CODEX_BIN env or codex.
--keep-open                    Leave test app and browxai running for debugging.
--json                         Print final report path as JSON.
```

Environment variables:

```text
BROWX_WORKSPACE                Same as --workspace.
DOGFOOD_CODEX_MODEL            Same as --model.
DOGFOOD_CODEX_EFFORT           Same as --effort.
DOGFOOD_CODEX_SANDBOX          Same as --sandbox.
DOGFOOD_CODEX_APPROVAL_POLICY  Same as --approval-policy.
DOGFOOD_K                      Same as --k.
DOGFOOD_TESTBED_PORT           Same as --testbed-port.
DOGFOOD_RUN_ROOT               Same as --run-root.
DOGFOOD_CODEX_BIN              Same as --codex-bin.
DOGFOOD_HEADLESS               "1" means --headless, "0" means --headed.
```

Wrapper sequence:

1. Resolve repo root, run root, workspace, socket path, selected missions, K,
   model, effort, sandbox, and approval policy.
2. Preflight `pnpm`, `codex`, `dist/cli.js`, and the mission catalog coverage
   validator.
3. Pick a free test-app port unless a port is explicit.
4. Start `pnpm --filter @browxai/capability-testbed serve` with
   `TESTBED_PORT=<port>`.
5. Wait for `/healthz`.
6. Start `pnpm exec browxai serve --socket <socket>` with the all-capabilities
   dogfood environment and the chosen `BROWX_HEADLESS` value.
7. For each selected mission and each run index:
   - spawn `codex app-server` through `InlineCodexAppServerOwn`;
   - inject the run-scoped `mcp_servers.browxai` config through `-c` flags;
   - send the mission prompt through `turn/start`;
   - collect raw Codex frames and normalized events until mission end;
   - copy matching browxai diagnostics JSONL records;
   - write the mission TraceRecord;
   - run oracle exercises in separate verifier sessions.
8. Generate JSON and Markdown reports.
9. Close Codex child processes, browxai, and the test app unless `--keep-open`
   was set.

## 8. OPEN RISKS

Sandbox posture risk:

- Wrong posture can prevent browser launch if browxai is started by Codex as a
  normal MCP command. This design avoids that by starting `browxai serve
  --socket` host-side before Codex starts. Codex only runs a stdio socket proxy.
  The wrapper rejects direct `command = "browxai"` dogfood wiring because that
  would make browser launch depend on Codex subprocess policy.

`@remotxai/adapter-codex` publish lag:

- The package is private and workspace-bound today. Mirroring the minimal
  JSON-RPC client avoids waiting for a public package and avoids pulling in the
  proprietary adapter contract. The risk is protocol drift. Mitigation: keep
  CI fixtures for `initialize`, `thread/start`, `turn/start`, `mcpToolCall`,
  reasoning, plan, and usage frames, and make the inline client intentionally
  small.

LLM-session flakiness:

- Codex may choose different tool paths across runs or fail to finish a long
  mission. K-run aggregation is the mitigation. Reports distinguish coverage
  union from friction frequency, and raw traces make individual failures
  inspectable.

Test-app port collision:

- The current test app cannot use port `0` because it reports the requested
  port, not the actual assigned port. The wrapper must probe a free port before
  starting the app, retry on `EADDRINUSE`, and record the final base URL in the
  report.

Mission-prompt leakage:

- If the agent sees oracle names or expectedTools, it can optimize for the
  measurement instead of the browser task. The prompt builder only receives
  `goal`, base URL, session id, and final marker instructions. `expectedTools`
  and `oracle` stay host-side.

JSONL clock skew between host and agent:

- Codex event times are runner `Date.now()` values. browxai diagnostics times
  are browxai server `Date.now()` values. They are separate host processes, so
  small skew is possible. Correlation uses `(sessionId, tool, ordinal)` first
  and timestamp proximity second. Reports preserve original timestamps and do
  not require perfect wall-clock equality.

Future capability-testbed absorption:

- This dogfood runner belongs under `packages/capability-testbed/dogfood/` while
  it is experimental. If it becomes the canonical agentic measurement lane, move
  `dogfood/src/*` into `src/harness/dogfood/*`, keep imports pointed at
  `MANIFEST` and `EXERCISES`, and leave this design doc as the historical
  architecture record. Do not fork the manifest or exercise assertions during
  that absorption.

