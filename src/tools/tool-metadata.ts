// Tool-metadata bootstrap (RFC 0004 P2 / D2 + D7).
//
// The per-tool gating facts (`capability` / `batchable` / `deep`) and the zod
// input schema are declared inline at each `host.register` call — the single
// source of truth. The three central maps (`TOOL_CAPABILITY`,
// `BATCH_ALLOWED_TOOLS`, `DEEP_TOOLS`) and the SDK tool-types codegen are DERIVED
// from those registrations.
//
// Most consumers read a derived map only AFTER `createServer` has run every
// `registerXxxTools(host)` module, so the maps are already populated. But a few
// read them standalone — `resolveCapabilities` (a unit test, `browxai doctor`),
// the SDK registry's `capabilityFor`, and the SDK tool-types generator. For those
// callers this module exposes `collectToolMetadata()`: it builds a browser-free
// host, runs every registration once, and returns the accumulated table. It also
// installs that collection as the lazy populator behind `TOOL_CAPABILITY` /
// `DEEP_TOOLS` (the inverted dependency the leaf modules `capabilities.ts` /
// `tool-gate.ts` cannot express directly — they can't import the tools layer).
//
// The collection is browser-free and idempotent: the host's session factory is
// lazy (no browser opens), the handlers are never invoked (only their `def`
// metadata is read), and `declareToolCapability` / `declareDeepTool` are no-ops
// on a repeat of the same value.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  installToolMetadataCollector,
  resolveCapabilities,
  resolveConfirmHooks,
} from "../util/capabilities.js";
import { installDeepToolsCollector } from "../engine/tool-gate.js";
import { resolveConfig } from "../util/config.js";
import { resolveWorkspace } from "../util/workspace.js";
import { ConfigStore, resolvedToEnv } from "../util/config-store.js";
import { resolveOriginPolicy } from "../policy/origin.js";
import { ApprovalStore } from "../policy/confirm.js";
import { resolveCredentialsProvider } from "../util/credentials.js";
import { DiagnosticsRecorder } from "../util/diagnostics.js";
import { PACKAGE_VERSION } from "../util/version.js";
import { buildHost, type HostDeps } from "./host-build.js";
import { buildSessionRegistry } from "./session-registry.js";
import type { ToolRegistration, ToolResponse } from "./host.js";

import { registerActionTools } from "./action-tools.js";
import { registerReadObserveDomTools } from "./read-observe-dom-tools.js";
import { registerReadObserveExtractTools } from "./read-observe-extract-tools.js";
import { registerReadObserveVerifyTools } from "./read-observe-verify-tools.js";
import { registerReadObserveCaptureTools } from "./read-observe-capture-tools.js";
import { registerReadObserveBufferTools } from "./read-observe-buffer-tools.js";
import { registerGestureNetworkTools } from "./gesture-network-tools.js";
import { registerDeepPerfTools } from "./deep-perf-tools.js";
import { registerDeepCoverageTools } from "./deep-coverage-tools.js";
import { registerDeepDeterminismTools } from "./deep-determinism-tools.js";
import { registerCaptureReportMarksTools } from "./capture-report-marks-tools.js";
import { registerCaptureReportDiagnosticsTools } from "./capture-report-diagnostics-tools.js";
import { registerCaptureReportUploadTools } from "./capture-report-upload-tools.js";
import { registerCaptureReportExportTools } from "./capture-report-export-tools.js";
import { registerCaptureReportElementExportTools } from "./capture-report-element-export-tools.js";
import { registerCanvasTools } from "./canvas-tools.js";
import { registerStorageTools } from "./storage-tools.js";
import { registerFormsRecordingTools } from "./forms-recording-tools.js";
import { registerSessionPolicyTools } from "./session-policy-tools.js";
import { registerDeviceEmulationTools } from "./device-emulation-tools.js";
import { registerLiveEmulationTools } from "./live-emulation-tools.js";
import { registerConfigApprovalTools } from "./config-approval-tools.js";
import { registerSecretsCaptchaTools } from "./secrets-captcha-tools.js";
import { registerInputTools } from "./input-tools.js";
import { registerExtensionsBatchTools } from "./extensions-batch-tools.js";
import { PLUGIN_INFO_TOOL_CAPABILITY } from "./plugin-runtime.js";

/** Build a browser-free `HostDeps` so `buildHost` runs without opening a browser.
 *  Mirrors the deps `createServer` assembles (server.ts) via the same public
 *  resolvers; the session-registry factory is lazy (no session opens), and the
 *  two per-handler closures (`describeTarget` / `asTarget`) are stubs `buildHost`
 *  only stores and never invokes at construction. */
function makeMetadataHostDeps(): HostDeps {
  const workspace = resolveWorkspace();
  const configStore = new ConfigStore(workspace.root);
  const resolvedConfig = configStore.resolve();
  const cfgEnv = resolvedToEnv(resolvedConfig);
  const config = resolveConfig(cfgEnv);
  const caps = resolveCapabilities(cfgEnv);
  const confirmHooks = resolveConfirmHooks(cfgEnv);
  const originPolicy = resolveOriginPolicy(cfgEnv);
  const approvals = new ApprovalStore();
  const credentialsResolved = resolveCredentialsProvider(cfgEnv);
  const diagnostics = new DiagnosticsRecorder({ enabled: false, workspaceRoot: workspace.root });
  const registry = buildSessionRegistry({
    opts: { headless: true },
    resolvedConfig,
    configStore,
    caps,
    workspace,
    serverEngine: "chromium",
    serverDefaultMode: "persistent",
  });
  // The collection server is throwaway (never served) — name/version are cosmetic.
  const server = new McpServer(
    { name: "browxai", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );
  const toolHandlers: Record<string, (args: unknown) => Promise<ToolResponse>> = {};
  return {
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
    isByob: false,
    workspace,
    diagnostics,
    credentialsResolved,
    pluginRecords: () => [],
    startOptions: { headless: true },
    describeTarget: async () => "",
    asTarget: () => {
      throw new Error("asTarget is a metadata-collection stub — no handler runs here");
    },
  };
}

let cached: ReadonlyMap<string, ToolRegistration> | undefined;

/** Run every core tool registration once against a browser-free host and return
 *  the accumulated metadata table (name → `ToolMeta` + zod schema). The two
 *  plugin-info tools (`plugins_list` / `plugins_info`) are registered inside the
 *  async `wirePluginRuntime` (which loads plugins from disk); their capability is
 *  declared from the shared `PLUGIN_INFO_TOOL_CAPABILITY` source so collection
 *  stays synchronous and IO-free. Cached after the first run. */
export function collectToolMetadata(): ReadonlyMap<string, ToolRegistration> {
  if (cached) return cached;
  const host = buildHost(makeMetadataHostDeps());
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
  registerExtensionsBatchTools(host);
  // The two plugin-info MCP tools register inside the async plugin runtime; their
  // capability (the only metadata that matters for the derived maps) is declared
  // from the shared single source so we don't run the plugin loader to collect it.
  const table = new Map<string, ToolRegistration>(host.registrations);
  for (const [name, capability] of Object.entries(PLUGIN_INFO_TOOL_CAPABILITY)) {
    host.register(name, { description: `${name} (plugin runtime)`, capability }, async () => ({
      content: [],
    }));
  }
  for (const [name, reg] of host.registrations) table.set(name, reg);
  cached = table;
  return cached;
}

// Install the collection as the lazy populator behind the derived maps. A read of
// `TOOL_CAPABILITY` / `DEEP_TOOLS` (or a `resolveCapabilities` call) that happens
// before `createServer` ran will now trigger `collectToolMetadata()` once and see
// the full derived rows — without the standalone caller having to build a server.
installToolMetadataCollector(() => {
  collectToolMetadata();
});
installDeepToolsCollector(() => {
  collectToolMetadata();
});

// D1 (RFC 0004 P2, SECURITY-CRITICAL): EAGERLY populate the derived maps at import
// time — do not wait for the first lazy read. Importing this bootstrap is the
// composition-root install point reached by every real entry point (the package
// entry `src/index.ts`, `createServer` in `src/server.ts`, the SDK client in
// `src/sdk/index.ts`, and the CLI `src/cli.ts`). With the maps populated on import,
// the gate's fail-safe (`assertGateBootstrapped` / `assertEngineGateBootstrapped`)
// never fires on a production read — it stays a backstop against a NEW consumer
// that forgets to reach this bootstrap. The collection is cached, so the eager run
// is paid once. createServer calls `resolveCapabilities` BEFORE its own tool
// registrations; because this eager run already populated the maps, that early
// read sees the full rows rather than an empty (fail-open) map.
collectToolMetadata();
