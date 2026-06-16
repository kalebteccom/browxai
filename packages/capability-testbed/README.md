# @browxai/capability-testbed

A **large, self-contained web app + an agentic harness** that exercises **every
browxai capability** against it. It is the substrate for the agentic test-suite
workflow:

```
Full Report (Codex)  ->  Diagnose (Claude + Codex)  ->  Fix (Claude)  ->  loop
```

It is **NOT part of CI** (`pnpm test`, the quality gates, and the keystone job
all exclude it). It is heavy by design — real browsers, every off-by-default
capability enabled, all 198 tools driven — and is run on demand.

## Why it exists

browxai exposes **198 MCP tools** across **16 capabilities** plus a 10-tool
control plane. After the RFC 0004 architecture hardening we want a single place
that drives _every_ tool against a page surface built to trigger it, so a full
report tells us — empirically, against real engines — what is release-ready and
what regressed.

## Layout

```
src/
  server/                zero-dependency HTTP + WebSocket app (Node built-ins only)
    main.ts              CLI entry: `pnpm --filter @browxai/capability-testbed serve`
    http.ts              static + route + ws-upgrade server
    ws.ts                minimal RFC6455 text-frame server (no deps)
    registry.ts          surface registry (collects pages + their routes/sockets)
    types.ts             Surface / Route / SocketRoute contracts
    pages/               one module per capability surface (HTML + APIs)
      index.ts           registers every surface (the ONLY file that imports them all)
      <surface>.ts       core, forms, dialogs, frames, shadow, scroll, network,
                         workers, storage, media-files, permissions, canvas,
                         gestures, devices, perf, console, ...
  harness/
    manifest.ts          THE authoritative tool->exercise registry (all 198 rows)
    types.ts             Exercise / ExerciseCtx / ExerciseResult contracts
    driver.ts            createBrowxai(ALL caps) wrapper + per-exercise session helpers
    run-report.ts        entry: serve in-proc, run every exercise, write reports/
    exercises/           per-capability exercise maps (Record<tool, Exercise>)
      index.ts           aggregates every map into one lookup
      <capability>.ts    read, navigation, action, human, eval, file-io, network,
                         storage, workers, emulation, canvas, diagnostics, secrets,
                         extensions, perf, control
reports/                 generated reports (report-<stamp>.json + .md) — tracked
```

## The contract (how to add coverage)

The harness is **manifest-driven**. `harness/manifest.ts` has one row per tool:

```ts
{ tool: "click", capability: "action", surface: "/forms", intent: "click a button and assert the page reacted" }
```

For each row the driver looks up an `Exercise` in `exercises/index.ts` (keyed by
tool name). An exercise:

1. receives an `ExerciseCtx` (a browxai `client` with **all capabilities**, a
   bound `session`, the testbed `baseUrl`, a `workspace` dir for file-io tools,
   and `goto()` / `call()` / `log()` helpers),
2. drives the tool against the relevant surface,
3. returns `{ outcome: "pass" | "fail" | "error" | "skip" | "pending", detail, evidence }`.

A tool with **no** registered exercise is reported `pending` (honest coverage
gap, never a silent skip). The driver enforces a per-exercise timeout and
isolates failures so one wedged tool never aborts the report.

### Outcome semantics

- **pass** — the tool did the right thing against the surface (assertion held).
- **fail** — the tool ran but produced a wrong/unexpected result (a real finding).
- **error** — the tool threw / the call rejected unexpectedly (a real finding).
- **skip** — not exercisable in this environment by design (e.g. `extensions_*`
  needs headed non-incognito Chromium; `solve_captcha`/`get_credential` need an
  external provider — the _correct_ behavior is a structured "no provider"
  result, which the exercise asserts rather than skips where possible).
- **pending** — no exercise written yet.

## Capability coverage map (all 16 + control plane)

Every capability MUST have a surface that triggers it and an exercise per tool:

| Capability         | Tools | Surface(s) driving it                                            |
| ------------------ | ----- | --------------------------------------------------------------- |
| read (61)          | snapshot, find, inspect, extract, screenshot\*, verify\_\*, text_search, shadow_trees, overflow_detect, point_probe, frames_list, console_read, network_read, ws_read, watch, sample, plan, generate_locator, list_named_refs, perf_audit, session_metrics, export\_\*, … | core, console, frames, shadow, scroll |
| navigation (6)     | navigate, go_back, go_forward, scroll, set_viewport, tab_visibility | core, scroll |
| action (76)        | click, fill, press, shortcut, hover, select, choose_option, fill_form, wait_for, drag, double_click, mouse\_\*, touch\_\*, gesture\_\*, route\*, ws_send/intercept, set\_\*\_policy, set_locale/timezone/geolocation/color_scheme/reduced_motion/user_agent, grant_permissions, storage writes, auth\_\*, perf_start/stop, coverage_start, heap\_\*, clock, seed_random, cpu_emulate, network_emulate, pdf_save, start_har/stop_har, sw_intercept_fetch, worker_message_send, flake_check, execute | forms, gestures, network, storage, perf, permissions |
| human (10)         | await_human, name_ref, name_region, region, start_recording, end_recording, record_annotate, find_feedback, profile_snapshot, profile_restore | core, forms |
| eval (2)           | eval_js, poll_eval                                              | core |
| file-io (13)       | upload_file, drop_files, downloads_capture, download_get, fs_picker_respond, page_archive, element_export, dom_export, asset_export, screenshot_schedule, screenshot_on, get_video, stop_video | media-files |
| network-body (1)   | network_body                                                   | network |
| clipboard          | (behaviour-gated: `shortcut` copy/cut/paste)                   | forms |
| secrets (1)        | register_secret                                               | forms, network |
| extensions (5)     | extensions_install/list/reload/trigger/uninstall              | core (headed only) |
| stealth            | (behaviour-gated: init-script patches)                        | core |
| captcha (1)        | solve_captcha                                                 | forms (asserts no-provider result) |
| credentials (2)    | get_totp, get_credential                                     | forms (asserts no-provider result) |
| device-emulation (4) | emulate_bluetooth, emulate_usb, emulate_hid, device_requests | devices |
| diagnostics (1)    | diagnostics_note (+ read-side search/report)                 | any |
| canvas (5)         | canvas_capture, canvas_diff, canvas_query, canvas_world_to_screen, canvas_screen_to_world, gesture_chain | canvas |
| control plane (10) | open_session, close_session, close_sessions, list_sessions, batch, get_config, set_config, reset_config, list_approvals, approve_actions | n/a |

\* screenshot/screenshot_region/screenshot_marks are `read`; the file-writing
schedule/on variants are `file-io`.

## Running

```bash
# from the repo root, once:
pnpm install
pnpm build                      # the testbed imports the built `browxai` package
pnpm exec playwright-core install chromium

# serve the app for manual inspection:
pnpm --filter @browxai/capability-testbed serve     # http://localhost:5187

# run the full capability report:
pnpm --filter @browxai/capability-testbed report    # writes reports/report-<stamp>.{json,md}
```

Env knobs: `TESTBED_PORT` (default 5187), `TESTBED_ENGINE` (chromium\|firefox\|webkit,
default chromium), `TESTBED_HEADLESS` (default `1`), `TESTBED_ONLY` (comma-list of
capabilities or tools to run), `TESTBED_REPORT_DIR` (default `./reports`).
