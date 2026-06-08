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
  | "secrets"
  | "extensions"
  | "stealth"
  | "captcha"
  | "credentials";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "read", "navigation", "action", "human", "eval", "byob-attach", "file-io", "network-body", "clipboard", "secrets", "extensions", "stealth", "captcha", "credentials",
];

export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  "read", "navigation", "action", "human",
];

/**
 * Capabilities that USED to be valid and have since been retired. A retired
 * capability is still ACCEPTED in `BROWX_CAPABILITIES` (and the `capabilities`
 * config key) — it is ignored with a deprecation warning, never an error — so
 * evolving the capability set can't crash an existing adopter's config.
 * Genuine typos (a name that was never a capability) are still rejected loudly.
 * A retired entry may be dropped entirely only in a major version bump.
 * See the "API evolution" rule in CLAUDE.md.
 *
 * The value is the agent/operator-facing reason + what to do instead.
 */
export const RETIRED_CAPABILITIES: Readonly<Record<string, string>> = {
  unstable:
    "the tools it gated (gestures, route mocking, compound act-and-observe " +
    "tools, visual regions, profile snapshot/restore) were promoted into the " +
    "default stable surface — it no longer gates anything; drop it from " +
    "BROWX_CAPABILITIES",
};

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
  // Bridge from a session-internal `eN` ref to a Playwright-string locator
  // expression an adopter can paste into a `.spec.ts`. Pure-read: looks the
  // ref up in the existing registry, emits a string + structured breakdown.
  generate_locator: "read",
  text_search: "read",
  // Structured schema-driven data extraction. Read-only; no new
  // capability (the deterministic mode is selector-only).
  extract: "read",
  // verify-family — assertive read primitives (fail-emitting siblings of
  // wait_for). Read-only — no `eval` capability gate. `verify_predicate` is
  // intentionally NOT an arbitrary-JS path; its vocabulary is fixed enum +
  // allow-listed accessor keys, server-evaluated. See src/util/predicates.ts.
  verify_visible: "read",
  verify_text: "read",
  verify_value: "read",
  verify_count: "read",
  verify_attribute: "read",
  verify_predicate: "read",
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
  fill_form: "action",
  wait_for: "action",
  // `plan` resolves an NL query to a bound ActionDescriptor without
  // dispatching — semantically a read-then-bind primitive over `find()`.
  // `execute` dispatches a previously-planned descriptor; its handler
  // additionally enforces the underlying verb's capability (so e.g. a
  // descriptor with verb:"click" still requires `action`).
  plan: "read",
  execute: "action",
  // human
  await_human: "human",
  name_ref: "human",
  start_recording: "human",
  end_recording: "human",
  record_annotate: "human",
  find_feedback: "human",
  // eval
  eval_js: "eval",
  poll_eval: "eval", // repeatedly evaluates page JS — same posture as eval_js
  // The tools below were the W-Q7..Q11 experimental lane (formerly the
  // off-by-default `unstable` capability). Promoted into the stable surface:
  // each now sits under its natural capability — gestures/route mocking are
  // `action`, the compound act-and-observe tools are `read` (the inner
  // action's own capability is still gate-checked separately), region
  // bind/resolve + profile snapshot/restore are `human` coordination.
  drag: "action",
  double_click: "action",
  // per-session dialog policy mutator. Registers under `action` (it changes
  // how subsequent actions respond to alert/confirm/prompt fires — a
  // session-state knob, not a capability of its own).
  set_dialog_policy: "action",
  mouse_down: "action",
  mouse_move: "action",
  mouse_up: "action",
  mouse_wheel: "action",
  route: "action",
  route_queue: "action",
  unroute: "action",
  network_emulate: "action",
  cpu_emulate: "action",
  clock: "action",
  seed_random: "action",
  // Performance tracing (CDP `Tracing.start` / `Tracing.end` + structured
  // insights extraction). `perf_start` arms collection on the target;
  // `perf_stop` flushes to a workspace-rooted trace file; `perf_insights`
  // reads a written trace and returns the structured summary. All three are
  // `action` — they mutate target state (tracing on/off) and `perf_stop`
  // writes a file. No new capability is introduced.
  perf_start: "action",
  perf_stop: "action",
  perf_insights: "action",
  // V8 heap snapshots (CDP `HeapProfiler.takeHeapSnapshot` + in-process
  // retainer query over the `.heapsnapshot` JSON). `heap_snapshot` writes
  // a workspace-rooted file; `heap_retainers` reads one and reports who
  // holds objects matching a name/type query. Both are `action` —
  // `heap_snapshot` writes a file, and `heap_retainers` is a sibling
  // tool kept under the same capability so a memory-diagnosis batch
  // doesn't need to juggle two grants.
  heap_snapshot: "action",
  heap_retainers: "action",
  // Per-primitive device emulation (locale, timezone, geolocation, colour
  // scheme, reduced motion, user-agent, permissions). Each mutates one
  // Playwright/CDP emulation knob on the live session; under `action`
  // (mid-session state mutation, sibling to `set_viewport` which is under
  // `navigation`). Splitting them as 7 siblings — not a bundled
  // `emulate({…})` — lets agents set just what they need.
  set_locale: "action",
  set_timezone: "action",
  set_geolocation: "action",
  set_color_scheme: "action",
  set_reduced_motion: "action",
  set_user_agent: "action",
  grant_permissions: "action",
  act_and_diff: "read",
  act_and_wait_for_network: "read",
  // flake-check: dispatches the same batch payload N times to surface
  // intermittent failures + emit a cached-selector artifact. Posture is
  // `action` — unlike the act_and_* siblings (single inner action, sampled),
  // flake-check is purpose-built to repeatedly DISPATCH a sequence (each
  // inner call going through its own per-call gateCheck via the batch
  // handler map). Treating the outer primitive as `action` makes the intent
  // explicit at config-time: a `read`-only server should not be silently
  // re-running fills + clicks N times because someone wrapped them in
  // flake_check.
  flake_check: "action",
  cross_session_sample: "read",
  screenshot_region: "read",
  // Composed screenshot: paint numbered bounding boxes over caller-supplied
  // candidates and return the PNG + an index↔ref mapping. Pure compose on top
  // of existing primitives (no new browser interaction beyond a transient
  // in-page overlay) — `read`.
  screenshot_marks: "read",
  export_session_report: "read",
  // Sibling to `export_session_report`: rolls up the session's cumulative
  // tool-call metrics (counts, latency, tokensEstimate sum, capability denials,
  // per-tool errors). Read-only — accumulates dispatch envelope data the server
  // already has, no new side-effect.
  session_metrics: "read",
  // Trace-export sibling to `export_session_report`: lowers the session's
  // recorded action trace to a runnable `@playwright/test` spec file. Under
  // `read` — exports recorded state, dispatches no new action.
  export_playwright_script: "read",
  name_region: "human",
  region: "human",
  profile_snapshot: "human",
  profile_restore: "human",
  // network-body (off by default — full response bodies can carry PII / tokens)
  network_body: "network-body",
  // file-io
  upload_file: "file-io",
  // Download capture — reverse of `upload_file`. `downloads_capture` toggles
  // per-session interception of Playwright `download` events; `download_get`
  // returns the captured bytes (or workspace-rooted path) for an id surfaced
  // on `ActionResult.downloads[]`. Same posture as `upload_file`: no new
  // capability, workspace-rooted paths only.
  downloads_capture: "file-io",
  download_get: "file-io",
  // Filter the session's network ring and persist matching responses to a
  // workspace-rooted dir. Same posture as `download_get` (read recent
  // session-state, write the resulting bytes under $BROWX_WORKSPACE) — no new
  // capability gate to enable.
  asset_export: "file-io",
  // PDF save — print the current page to a workspace-rooted PDF. Mirror of
  // `upload_file` (file-io OUT instead of IN), but under `action` not
  // `file-io`: the consequential write is to the *workspace* only (no
  // user-filesystem read like `upload_file`'s `path` mode), so it sits with
  // the other DOM-mutating / state-mutating writers. Refused on `attached`
  // sessions at the tool layer — see src/page/pdf.ts.
  pdf_save: "action",
  // Three-layer storage-state (Phase 3.5).
  //   reads  (`*_get`, `*_list`, `dump_storage_state`, `auth_list`) → `read`
  //   writes (`*_set`, `*_delete`, `*_clear`,
  //           `inject_storage_state`, `auth_save`, `auth_load`,
  //           `auth_delete`)                                         → `action`
  // No new capability gate — these reuse the existing read/action posture so
  // an existing capability config doesn't need editing to use them.
  dump_storage_state: "read",
  inject_storage_state: "action",
  cookies_get: "read",
  cookies_list: "read",
  cookies_set: "action",
  cookies_delete: "action",
  cookies_clear: "action",
  localstorage_get: "read",
  localstorage_list: "read",
  localstorage_set: "action",
  localstorage_delete: "action",
  localstorage_clear: "action",
  sessionstorage_get: "read",
  sessionstorage_list: "read",
  sessionstorage_set: "action",
  sessionstorage_delete: "action",
  sessionstorage_clear: "action",
  auth_save: "action",
  auth_load: "action",
  auth_list: "read",
  auth_delete: "action",
  // Per-session artifact KV — save/get/list of session-scoped string/binary
  // payloads (the "build your own library over time" loop). `artifact_save`
  // writes a file → `action`; `artifact_get` / `artifact_list` are read-only.
  // No new capability gate to enable.
  artifact_save: "action",
  artifact_get: "read",
  artifact_list: "read",
  // HAR record/replay — `start_har` / `stop_har` both write/mutate session
  // state and (in the case of start) reserve a workspace-rooted file path
  // the context will write on close. Under `action` (sibling to the storage
  // bulk writers); reuses an existing capability, no new gate to enable.
  start_har: "action",
  stop_har: "action",
  // secrets — per-session sensitive-data registry + egress masking. Off by
  // default; loud-warn one-time when a secret is registered. Mirrors
  // `eval` / `network-body` / `disableWebSecurity` posture. `register_secret`
  // is the only tool the capability gates; the masking layer it installs is
  // behaviour-gated across every egress sink. See docs/tool-reference.md +
  // docs/threat-model.md.
  register_secret: "secrets",
  // extensions — per-session Chrome extension management. Off-by-default
  // capability; loud-warned at boot. Extensions can read every page the
  // session visits and make arbitrary network requests, so same posture
  // class as `eval` / `network-body` / `secrets`. The 5 mutator/read tools
  // all gate behind the same capability; the tool layer additionally
  // refuses on `incognito` / `attached` sessions and on `headless:true`
  // launches (Chromium constraints — see src/session/extensions.ts).
  extensions_install: "extensions",
  extensions_list: "extensions",
  extensions_reload: "extensions",
  extensions_trigger: "extensions",
  extensions_uninstall: "extensions",
  // captcha — per-session delegated captcha solving via a configured external
  // provider (2Captcha / CapMonster / etc; provider config via env). Off-by-
  // default capability; loud-warned at boot. Same posture class as
  // `eval` / `network-body` / `secrets` / `extensions` / `stealth`. Provider
  // config is per-deployment (env vars) — browxai NEVER bundles a solver and
  // NEVER auto-purchases credits. When the capability is on but no provider
  // is configured the tool returns a structured "no provider configured"
  // failure.
  solve_captcha: "captcha",
  // stealth is behaviour-gated (no tool of its own). The capability flips
  // per-context init-script patches at session creation (navigator.webdriver
  // / plugins / languages / window.chrome) — see src/helper/stealth.ts.
  // credentials — off-by-default pluggable hook into an external vault for
  // TOTP / username+password lookup. Same posture class as `eval` /
  // `network-body` / `secrets` — provider is configured per-deployment,
  // never bundled, loud-warned at boot. `get_credential` additionally
  // requires `secrets` to be enabled at the same time (it auto-registers
  // the looked-up password into the W-V12 secrets registry).
  get_totp: "credentials",
  get_credential: "credentials",
  // byob-attach is not bound to a specific tool — it gates the
  // BROWX_ATTACH_CDP code path at session creation. `clipboard` is likewise behaviour-gated,
  // not tool-gated: the `shortcut` tool itself needs `action`, but its OS-clipboard
  // side-effect (copy/cut/paste) only engages when `clipboard` is also enabled —
  // off by default; same posture class as `eval` / `network-body`.
};

export interface CapabilityConfig {
  enabled: ReadonlySet<Capability>;
  /** Names of tools rejected at start because their capability isn't enabled. */
  disabledTools: ReadonlyArray<{ tool: string; capability: Capability }>;
  /** Non-fatal startup warnings — e.g. a retired capability was supplied.
   *  The caller (server.ts) logs these; they never abort startup. */
  warnings: readonly string[];
}

export function resolveCapabilities(env: NodeJS.ProcessEnv = process.env): CapabilityConfig {
  const raw = env.BROWX_CAPABILITIES?.trim();
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_CAPABILITIES];
  const warnings: string[] = [];
  const live: string[] = [];
  const unknown: string[] = [];
  for (const c of list) {
    if (ALL_CAPABILITIES.includes(c as Capability)) {
      live.push(c);
    } else if (Object.prototype.hasOwnProperty.call(RETIRED_CAPABILITIES, c)) {
      // Retired, not unknown — tolerate it so an old config never crashes.
      warnings.push(
        `BROWX_CAPABILITIES: "${c}" is a retired capability — ${RETIRED_CAPABILITIES[c]}. ` +
        `It is ignored (no effect); the rest of your config is honoured.`,
      );
    } else {
      unknown.push(c);
    }
  }
  if (unknown.length) {
    throw new Error(
      `BROWX_CAPABILITIES: unknown capability/capabilities ${unknown.map((u) => JSON.stringify(u)).join(", ")}. ` +
      `Valid: ${ALL_CAPABILITIES.join(", ")}.`,
    );
  }
  const enabled = new Set(live as Capability[]);
  const disabledTools: Array<{ tool: string; capability: Capability }> = [];
  for (const [tool, cap] of Object.entries(TOOL_CAPABILITY)) {
    if (!enabled.has(cap)) disabledTools.push({ tool, capability: cap });
  }
  return { enabled, disabledTools, warnings };
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
