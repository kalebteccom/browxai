// MCP server wiring. Tools are registered here; their implementations live in
// page/* and helper/*. stdout is the MCP channel — all logging goes via util/logging.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type EngineKind } from "./engine/index.js";
import { type SessionMode } from "./session/registry.js";
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
import {
  resolveCapabilities,
  resolveConfirmHooks,
  CAPABILITY_WARNINGS,
} from "./util/capabilities.js";
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
// Target-resolution domain helpers extracted to a leaf module so this file stays
// pure composition/wiring; `buildHost` threads them onto the shared ToolHost.
import { describeTarget, asTarget } from "./tools/target-resolve.js";

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
  // Credentials provider: resolved once at server start. The provider object
  // is constructed even when the capability is off so per-deployment config
  // validation (unknown provider name → warn) happens up front. Per-call
  // failures (missing CLI binary, missing seed, etc.) surface as structured
  // refusals on the tool result — never crash startup.
  const credentialsResolved = resolveCredentialsProvider(cfgEnv);
  for (const w of credentialsResolved.config.warnings) log.warn(`browxai: ${w}`);
  // diagnostics recorder gate + retention window. Resolved up front so both the
  // loud one-time warning (rendered from the table below) and the recorder
  // construction read the same values; the `enabled` flag gates every actual
  // side-effect. OFF → zero allocations beyond a gate check on every tool call.
  const diagnosticsEnabled = caps.enabled.has("diagnostics");
  const diagRetentionDays = resolveRetentionDays(cfgEnv);
  // Loud one-time warnings for every ENABLED off-by-default capability, driven
  // by the CAPABILITY_WARNINGS data table (src/util/capabilities.ts) so this
  // composition root stays wiring-only. The table is ordered; iterating it
  // preserves the exact emission order, text, and the set of capabilities that
  // warn. The two dynamic rows (credentials provider, diagnostics retention)
  // render from the runtime context.
  for (const { capability, message } of CAPABILITY_WARNINGS) {
    if (!caps.enabled.has(capability)) continue;
    const text =
      typeof message === "function"
        ? message({
            credentialsProvider: credentialsResolved.config.provider,
            diagnosticsRetentionDays: diagRetentionDays,
          })
        : message;
    log.warn(`browxai: ${text}`);
  }
  if (diagnosticsEnabled) {
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
