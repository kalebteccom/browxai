// MCP server wiring. Tools are registered here; their implementations live in
// page/* and helper/*. stdout is the MCP channel — all logging goes via util/logging.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type EngineKind } from "./engine/index.js";
import { type SessionMode } from "./session/registry.js";
import { RefRegistry } from "./page/refs.js";
import { resolveCredentialsProvider } from "./util/credentials.js";
import { resolveConfig } from "./util/config.js";
import { resolveWorkspace } from "./util/workspace.js";
import {
  DiagnosticsRecorder,
  ensureDiagnosticsRoot,
  resolveRetentionDays,
  sweepRetention,
} from "./util/diagnostics.js";
import { ConfigStore, resolvedToEnv } from "./util/config-store.js";
import { resolveCapabilities, resolveConfirmHooks } from "./util/capabilities.js";
import type { PluginRecord } from "./plugin/types.js";
import { resolveOriginPolicy, describePolicy } from "./policy/origin.js";
import { ApprovalStore } from "./policy/confirm.js";
import { log } from "./util/logging.js";
import { PACKAGE_VERSION } from "./util/version.js";
import type { ToolResponse } from "./tools/host.js";
import { buildHost } from "./tools/host-build.js";
import { registerActionTools } from "./tools/action-tools.js";
import { registerReadObserveDomTools } from "./tools/read-observe-dom-tools.js";
import { registerReadObserveExtractTools } from "./tools/read-observe-extract-tools.js";
import { registerReadObserveVerifyTools } from "./tools/read-observe-verify-tools.js";
import { registerReadObserveCaptureTools } from "./tools/read-observe-capture-tools.js";
import { registerReadObserveBufferTools } from "./tools/read-observe-buffer-tools.js";
import { registerGestureNetworkTools } from "./tools/gesture-network-tools.js";
import { registerDeepPerfTools } from "./tools/deep-perf-tools.js";
import { registerDeepCoverageTools } from "./tools/deep-coverage-tools.js";
import { registerDeepDeterminismTools } from "./tools/deep-determinism-tools.js";
import { registerCaptureReportMarksTools } from "./tools/capture-report-marks-tools.js";
import { registerCaptureReportDiagnosticsTools } from "./tools/capture-report-diagnostics-tools.js";
import { registerCaptureReportUploadTools } from "./tools/capture-report-upload-tools.js";
import { registerCaptureReportExportTools } from "./tools/capture-report-export-tools.js";
import { registerCaptureReportElementExportTools } from "./tools/capture-report-element-export-tools.js";
import { registerCanvasTools } from "./tools/canvas-tools.js";
import { registerStorageTools } from "./tools/storage-tools.js";
import { registerFormsRecordingTools } from "./tools/forms-recording-tools.js";
import { registerSessionPolicyTools } from "./tools/session-policy-tools.js";
import { registerDeviceEmulationTools } from "./tools/device-emulation-tools.js";
import { registerLiveEmulationTools } from "./tools/live-emulation-tools.js";
import { registerConfigApprovalTools } from "./tools/config-approval-tools.js";
import { registerSecretsCaptchaTools } from "./tools/secrets-captcha-tools.js";
import { registerInputTools } from "./tools/input-tools.js";
import { registerExtensionsBatchTools } from "./tools/extensions-batch-tools.js";
import { wirePluginRuntime } from "./tools/plugin-runtime.js";
import { buildSessionRegistry } from "./tools/session-registry.js";
// RFC 0004 P2 / D1 (SECURITY-CRITICAL): importing the tool-metadata bootstrap is a
// side effect that EAGERLY populates the derived `TOOL_CAPABILITY` / `DEEP_TOOLS`
// maps. `createServer` calls `resolveCapabilities` BEFORE its own tool
// registrations run; this import guarantees the maps are already populated at that
// point (and that the gate's fail-safe never trips for a server-built process),
// independent of whether the consumer reached us via the package entry.
import "./tools/tool-metadata.js";
// Shared input-schema fragments live in a leaf module so the per-family tool
// modules and this composition root depend on them without an import cycle.
import { SESSION_ARG, TIMEOUT_ARG, ACTION_OPTS, REF_OR_SELECTOR } from "./tools/schemas.js";

export const NAME = "browxai";
// Derived from package.json — see src/util/version.ts. Never hand-bump.
export const VERSION = PACKAGE_VERSION;

export interface StartOptions {
  attachCdp?: string;
  headless?: boolean;
  /** Browser engine for sessions this server launches. Defaults to
   *  `"chromium"`. chromium, firefox, and webkit are all wired today (see
   *  src/engine/); a future-declared engine without an adapter is rejected at
   *  the launch path with a clear `engine-not-yet-supported` error. */
  browserType?: EngineKind;
}

// Re-exported (imported at the top with the other tool modules) to preserve the
// existing public surface — the definitions now live in `tools/schemas`.
export { SESSION_ARG, TIMEOUT_ARG, ACTION_OPTS, REF_OR_SELECTOR };

/** structured one-liner alongside an element screenshot. Skips
 *  vision-reading when the agent only needs to confirm "yes the button is there." */
async function describeTarget(
  loc: import("playwright-core").Locator,
  refs: RefRegistry,
  target: { ref: string } | { selector: string } | { coords: { x: number; y: number } },
): Promise<string> {
  const bits: string[] = [];
  let inputs: import("./page/refs.js").RefLocatorInputs | undefined;
  if ("ref" in target && target.ref) {
    inputs = refs.locatorOf(target.ref);
    if (inputs) {
      bits.push(inputs.role);
      if (inputs.name) bits.push(`"${inputs.name}"`);
      if (inputs.testId) bits.push(`[${inputs.testIdAttr ?? "data-testid"}="${inputs.testId}"]`);
    } else {
      bits.push(`ref=${target.ref}`);
    }
  } else if ("selector" in target && target.selector) {
    bits.push(`selector=${target.selector}`);
  } else if ("coords" in target && target.coords) {
    bits.push(`coords=${target.coords.x},${target.coords.y}`);
    return bits.join(" "); // no Locator to probe further for coords targets
  }
  try {
    const box = await loc.boundingBox();
    if (box)
      bits.push(
        `bbox=${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`,
      );
    const visible = await loc.isVisible().catch(() => undefined);
    if (visible === false) bits.push("not-visible");
    const enabled = await loc.isEnabled().catch(() => undefined);
    if (enabled === false) bits.push("disabled");
  } catch {
    /* skip — fall back to whatever we have */
  }
  return bits.join(" ");
}

function asTarget(
  args: {
    ref?: string;
    selector?: string;
    named?: string;
    contextRef?: string;
    coords?: { x: number; y: number };
  },
  toolName: string,
  refs: RefRegistry,
):
  | { ref: string }
  | { selector: string; contextRef?: string }
  | { coords: { x: number; y: number } } {
  const provided = [args.ref, args.selector, args.named, args.coords].filter(Boolean).length;
  if (provided > 1)
    throw new Error(
      `${toolName}: pass exactly one of \`ref\` / \`selector\` / \`named\` / \`coords\``,
    );
  if (args.ref) return { ref: args.ref };
  if (args.named) {
    const resolved = refs.refByNameLookup(args.named);
    if (!resolved)
      throw new Error(
        `${toolName}: name "${args.named}" not bound. Call name_ref({name, ref}) first.`,
      );
    return { ref: resolved };
  }
  if (args.selector) {
    return args.contextRef
      ? { selector: args.selector, contextRef: args.contextRef }
      : { selector: args.selector };
  }
  if (args.coords) return { coords: args.coords };
  throw new Error(
    `${toolName}: requires one of \`ref\` (from find/snapshot), \`selector\`, \`named\`, or \`coords\``,
  );
}

export async function createServer(opts: StartOptions = {}): Promise<{
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
  /** Programmatic in-process driving seam: the registered MCP tool handlers,
   *  keyed by tool name, each returning the same `{ content: [...] }` shape an
   *  MCP call would. Used by the headless-CI keystone (and any embedder that
   *  wants to drive the surface without the stdio transport). */
  handlers: Record<
    string,
    (args: unknown) => Promise<{
      content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      >;
    }>
  >;
}> {
  // config flows through the browxai-managed ConfigStore (precedence
  // defaults < env(legacy) < user < project < session). The existing env-driven
  // resolvers consume the *resolved* chain re-expressed as an env shape, so
  // precedence is centralised in the store without rewriting each resolver.
  const workspace = resolveWorkspace();
  const configStore = new ConfigStore(workspace.root);
  const resolvedConfig = configStore.resolve();
  const cfgEnv = resolvedToEnv(resolvedConfig);
  const config = resolveConfig(cfgEnv);
  // approvals are session-independent policy state — server-level.
  const approvals = new ApprovalStore();
  //  policy: capabilities, confirm-required hooks, origin allow/blocklist.
  const caps = resolveCapabilities(cfgEnv);
  const confirmHooks = resolveConfirmHooks(cfgEnv);
  const originPolicy = resolveOriginPolicy(cfgEnv);
  const isByob = !!opts.attachCdp;
  log.info("browxai: policy", {
    capabilities: [...caps.enabled],
    confirmHooks: [...confirmHooks],
    origins: describePolicy(originPolicy),
  });
  for (const w of caps.warnings) log.warn(`browxai: ${w}`);
  if (caps.enabled.has("eval"))
    log.warn(
      "browxai: eval capability is ENABLED — `eval_js` will execute page-side JS. Return values are page-controlled.",
    );
  if (caps.enabled.has("network-body"))
    log.warn(
      "browxai: network-body capability is ENABLED — `network_body` returns full response bodies, which can carry PII / auth tokens. Off by default for a reason.",
    );
  if (caps.enabled.has("secrets"))
    log.warn(
      "browxai: secrets capability is ENABLED — `register_secret` accepts sensitive values; once a secret is registered the egress masking layer engages on every sink (ActionResult.network, network_read, network_body, ws_read, console_read, snapshot, find). `screenshot` is a partial sink — see docs/tool-reference.md.",
    );
  // Credentials provider: resolved once at server start. The provider object
  // is constructed even when the capability is off so per-deployment config
  // validation (unknown provider name → warn) happens up front. Per-call
  // failures (missing CLI binary, missing seed, etc.) surface as structured
  // refusals on the tool result — never crash startup.
  const credentialsResolved = resolveCredentialsProvider(cfgEnv);
  for (const w of credentialsResolved.config.warnings) log.warn(`browxai: ${w}`);
  if (caps.enabled.has("credentials")) {
    log.warn(
      `browxai: credentials capability is ENABLED — \`get_totp\` / \`get_credential\` will shell out to the configured "${credentialsResolved.config.provider}" backend per call. NEVER bundled, NEVER auto-installed — the operator supplies the CLI / seeds out-of-band. \`get_credential\` ADDITIONALLY requires the \`secrets\` capability so the looked-up password is auto-registered into the per-session secrets registry under \`<PASSWORD_<account>>\` and masked across every egress sink (without \`secrets\`, the lookup refuses rather than leak cleartext). Same posture class as \`eval\` / \`network-body\` / \`secrets\`. See docs/threat-model.md.`,
    );
  }
  if (caps.enabled.has("extensions"))
    log.warn(
      "browxai: extensions capability is ENABLED — `extensions_install` loads unpacked Chromium extensions into managed (headed, persistent) sessions. Loaded extensions can READ every page the session visits and make ARBITRARY network requests; treat the extension code itself as in-scope trust. Headed + persistent only — incognito / attached sessions refuse. install/reload/uninstall REBUILD the underlying browser context, invalidating refs + console/network buffers (profile state on disk survives). Same posture class as `eval` / `network-body` / `secrets` — see docs/threat-model.md.",
    );
  if (caps.enabled.has("stealth"))
    log.warn(
      "browxai: stealth capability is ENABLED — every session's context loads init-script patches that override `navigator.webdriver` / `navigator.plugins` / `navigator.languages` / `window.chrome` to defeat the common Playwright fingerprint surface. CIRCUMVENTING AUTOMATION DETECTION MAY VIOLATE A SITE'S TERMS OF SERVICE; the operator carries the legal exposure. browxai does NOT bundle a full anti-fingerprinting library — only the four well-known patches above. Same posture class as `eval` / `network-body` / `secrets` / `extensions` — see docs/threat-model.md.",
    );
  if (caps.enabled.has("device-emulation"))
    log.warn(
      "browxai: device-emulation capability is ENABLED — `emulate_bluetooth` / `emulate_usb` / `emulate_hid` install init-script wrappers around `navigator.bluetooth.requestDevice` / `navigator.usb.requestDevice` / `navigator.hid.requestDevice` so the page resolves with synthetic device objects the agent staged. THE PAGE WILL BELIEVE IT HAS ACCESS TO PHYSICAL DEVICES THAT DON'T EXIST. v1 covers the picker-clear path only — GATT service emulation (Bluetooth), USB transfer endpoints, and HID input/output reports are stubs (resolve with empty/zero-byte results). Same posture class as `eval` / `network-body` / `secrets` / `extensions` / `stealth` / `captcha` — see docs/threat-model.md.",
    );
  if (caps.enabled.has("canvas"))
    log.warn(
      "browxai: canvas capability is ENABLED — `canvas_capture` reads framebuffer / 2D ImageData pixel bytes off `<canvas>` elements (subject to the platform's canvas-taint rules for cross-origin sources); `gesture_chain` dispatches multi-step pointer programs (custom paint strokes, lasso paths); `canvas_world_to_screen` / `canvas_screen_to_world` probe common app-side globals heuristically (Figma / Tldraw / Excalidraw shapes) when no explicit transform is supplied — confirm on a known landmark before relying on the result. `canvas_query` dispatches to canvas-app adapter plugins; the inner plugin tool's capability is enforced via the plugin call-graph gate. browxai is BYO-vision — `canvas_capture` is the pixel source, not a vision call; composition with the host agent's own multimodal vision is the loop. Same posture class as `eval` / `network-body` / `secrets` / `extensions` / `device-emulation` / `diagnostics` — see docs/threat-model.md.",
    );
  if (caps.enabled.has("captcha"))
    log.warn(
      "browxai: captcha capability is ENABLED — `solve_captcha` will delegate challenges to the provider configured via BROWX_CAPTCHA_PROVIDER + BROWX_CAPTCHA_API_KEY. SOLVING CAPTCHAS MAY VIOLATE THE TARGET SITE'S TERMS OF SERVICE and (depending on jurisdiction) computer-misuse / unauthorised-access law; the operator carries the legal exposure. browxai does NOT bundle a solver and does NOT auto-purchase credits — the operator chooses a provider, funds the account, configures the server. Same posture class as `eval` / `network-body` / `secrets` / `extensions` / `stealth` — see docs/threat-model.md.",
    );
  // diagnostics recorder. Constructed eagerly so the dispatch
  // wrapper can reference it; the `enabled` flag is what gates every
  // actual side-effect. OFF → zero allocations beyond a gate check on
  // every tool call.
  const diagnosticsEnabled = caps.enabled.has("diagnostics");
  const diagRetentionDays = resolveRetentionDays(cfgEnv);
  if (diagnosticsEnabled) {
    log.warn(
      "browxai: diagnostics capability is ENABLED — every MCP tool call is " +
        `recorded as a JSONL line under $BROWX_WORKSPACE/diagnostics/<sessionId>/<ISO>.jsonl ` +
        `(retention: ${diagRetentionDays} days; configure via BROWX_DIAGNOSTICS_RETENTION_DAYS). ` +
        "Args are structurally redacted (large/sensitive payload fields → sha256 + byteLength); " +
        "the recorder runs DOWNSTREAM of the URL sanitiser + secrets-masking egress " +
        "chokepoint, so registered secret values never reach the store raw. The agent " +
        "self-feedback tool `diagnostics_note` ALSO requires this capability; read-side " +
        "queries (`diagnostics_search`, `diagnostics_report`) ride the `read` capability " +
        "so a report can be pulled even when no further notes are being filed. Same posture " +
        "class as `eval` / `network-body` / `secrets` / `extensions` / `stealth` / `captcha` / " +
        "`device-emulation`. See docs/threat-model.md.",
    );
    // Create the diagnostics root + run the retention sweep up-front so a
    // long-idle workspace doesn't keep months of stale JSONL.
    try {
      ensureDiagnosticsRoot(workspace.root);
    } catch {
      /* best-effort */
    }
    try {
      sweepRetention(workspace.root, diagRetentionDays);
    } catch {
      /* best-effort */
    }
  }
  const diagnostics = new DiagnosticsRecorder({
    enabled: diagnosticsEnabled,
    workspaceRoot: workspace.root,
    retentionDays: diagRetentionDays,
  });
  if (resolvedConfig.disableWebSecurity)
    log.warn(
      "browxai: disableWebSecurity is ENABLED — managed/incognito sessions launch with SOP/CORS OFF (--disable-web-security). Use only against test/dev targets.",
    );
  if (process.env.BROWX_EXTRACT_STRICT === "1")
    log.warn(
      "browxai: BROWX_EXTRACT_STRICT=1 — extract() unknown-`x-browx-source`-key warnings are PROMOTED to hard `ok:false` invalid-schema rejections (v0.2.2's partialMisses-only behavior is bypassed). The integer→number coerce and array-`selector`-as-`collection` alias are NOT promoted; only typo-like unknown-key diagnostics are.",
    );
  if (isByob && !caps.enabled.has("byob-attach")) {
    log.warn(
      "browxai: BROWX_ATTACH_CDP is set but `byob-attach` capability is disabled. Add `byob-attach` to BROWX_CAPABILITIES to use it.",
    );
  }

  // per-session state lives in the SessionRegistry. The "default"
  // session is created lazily on the first browser-touching tool call — so
  // list_tools / discovery still don't launch a browser, and every existing
  // caller that omits `session` keeps working unchanged.
  // The engine every session this server opens runs on. Defaults to chromium;
  // firefox + webkit + android are also wired (the launch path drives each via
  // its adapter). A future-declared engine without an adapter is rejected
  // (engine-not-yet-supported) — there is no silent fallback to chromium.
  const serverEngine: EngineKind = opts.browserType ?? "chromium";
  // The server-level launch mode: BYOB when BROWX_ATTACH_CDP is set, else
  // persistent. android is ATTACH-ONLY (the user's real Chrome-on-Android over
  // adb + CDP), so it defaults to "attached" with no BROWX_ATTACH_CDP
  // (the endpoint is DISCOVERED over adb, not configured). This is the default a
  // lazily-created session inherits; an explicit open_session can override per id.
  const serverDefaultMode: SessionMode =
    serverEngine === "android" || opts.attachCdp ? "attached" : "persistent";
  const registry = buildSessionRegistry({
    opts,
    resolvedConfig,
    configStore,
    caps,
    workspace,
    serverEngine,
    serverDefaultMode,
  });

  const server = new McpServer({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

  // Side-table of handler functions, populated as we register each tool. Lets
  // the `batch` tool dispatch a whitelist of inner calls without going through
  // the MCP transport. Each handler accepts the inner tool's args and returns
  // the same `{ content: [...] }` shape an MCP call would. `ToolResponse` is the
  // shared seam type (src/tools/host.ts) so extracted tool modules and the
  // composition root agree on the envelope.
  const toolHandlers: Record<string, (args: unknown) => Promise<ToolResponse>> = {};

  // populated AFTER every core tool registration when the plugin
  // runtime fires. Declared here so `get_config({scope:"resolved"})` can
  // reference it via closure (registered before plugin loading runs).
  let pluginRecords: ReadonlyArray<PluginRecord> = [];

  // The composition seam: bundle the shared state + helper closures into one
  // host and hand it to each per-family tool module. createServer stays the
  // registry composition root; the closures + host literal live in buildHost.
  const host = buildHost({
    server,
    toolHandlers,
    registry,
    config,
    configStore,
    resolvedConfig,
    caps,
    confirmHooks,
    originPolicy,
    approvals,
    isByob,
    workspace,
    diagnostics,
    credentialsResolved,
    pluginRecords: () => pluginRecords,
    startOptions: opts,
    describeTarget,
    asTarget,
  });

  registerReadObserveDomTools(host);
  registerReadObserveExtractTools(host);
  registerReadObserveVerifyTools(host);
  registerReadObserveCaptureTools(host);
  registerReadObserveBufferTools(host);
  registerActionTools(host);
  registerGestureNetworkTools(host);
  registerDeepPerfTools(host);
  registerDeepCoverageTools(host);
  registerDeepDeterminismTools(host);
  registerCaptureReportMarksTools(host);
  registerCaptureReportDiagnosticsTools(host);
  registerCaptureReportUploadTools(host);
  registerCaptureReportExportTools(host);
  registerCaptureReportElementExportTools(host);
  registerCanvasTools(host);
  registerStorageTools(host);
  registerFormsRecordingTools(host);
  registerSessionPolicyTools(host);
  registerDeviceEmulationTools(host);
  registerLiveEmulationTools(host);
  registerConfigApprovalTools(host);
  registerSecretsCaptchaTools(host);
  registerInputTools(host);

  // The extensions + batch/compound-primitive family registers through the
  // shared ToolHost seam. It MUST run before the coreToolNames capture below
  // so its tools count as core (plugin runtime loads last).
  registerExtensionsBatchTools(host);

  // Plugin runtime wiring — the LAST registration step, run after every core
  // `register*Tools(host)` call so the `coreToolNames` snapshot taken inside
  // counts the full core surface as "core" and plugins load on top of it.
  // Returns the loaded records; assigning them to the createServer `let`
  // keeps `get_config` reporting the live enabled-plugin set via the host
  // getter.
  pluginRecords = await wirePluginRuntime(host, {
    server,
    noteMetrics: host.noteMetrics,
    noteDiagnostics: host.noteDiagnostics,
  });

  return {
    start: async () => {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      log.info("browxai: MCP server up on stdio");
    },
    shutdown: async () => {
      await registry.closeAll();
      await server.close().catch(() => undefined);
    },
    handlers: toolHandlers,
  };
}
