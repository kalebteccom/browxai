// MCP server wiring. Tools are registered here; their implementations live in
// page/* and helper/*. stdout is the MCP channel — all logging goes via util/logging.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { basename as pathBasename } from "node:path";
import { openManagedSession } from "./session/managed.js";
import { openByobSession } from "./session/byob.js";
import { requireCdp, assertEngineSupports, type EngineKind } from "./engine/index.js";
import { openIncognitoSession } from "./session/incognito.js";
import { resolveDevice } from "./session/device.js";
import {
  newEmulationState,
  reapplyAll as reapplyEmulation,
  applyLocaleCdp,
  clearLocaleCdp,
  applyTimezoneCdp,
  clearTimezoneCdp,
  applyUserAgentCdp,
  clearUserAgentCdp,
  applyPermissions,
  clearPermissions,
  BYOB_EMULATION_WARNING,
  type ColorScheme,
  type ReducedMotion,
} from "./session/emulation.js";
import type { BrowserSession } from "./session/types.js";
import {
  SessionRegistry,
  DEFAULT_SESSION_ID,
  type SessionEntry,
  type SessionMode,
} from "./session/registry.js";
import {
  newExtensionRegistry,
  resolveExtensionPath,
  readManifest,
  refuseIfUnsupported as refuseExtensionsIfUnsupported,
  applyInstall as applyExtensionInstall,
  applyUninstall as applyExtensionUninstall,
  applyReload as applyExtensionReload,
  type LoadedExtension,
} from "./session/extensions.js";
import { WedgeTracker } from "./session/wedge.js";
import { SessionMetrics, type DispatchOutcome } from "./session/metrics.js";
import {
  DialogPolicyState,
  attachDialogPolicy,
  parseDialogPolicyArg,
  type DialogPolicy,
} from "./session/dialog.js";
import {
  PermissionPolicyState,
  attachPermissionPolicy,
  applyCdpBaseline as applyPermissionCdpBaseline,
  parsePermissionPolicyArg,
  readPermissionStates,
  SUPPORTED_PERMISSIONS,
  BYOB_PERMISSION_WARNING,
  type PermissionPolicy,
  type SupportedPermission,
} from "./session/permission.js";
import {
  NotificationPolicyState,
  attachNotificationPolicy,
  parseNotificationPolicyArg,
  propagateSyncDecision as propagateNotificationSyncDecision,
  type NotificationPolicy,
} from "./session/notification.js";
import {
  FsPickerPolicyState,
  attachFsPickerPolicy,
  parseFsPickerPolicyArg,
  resolveWorkspaceFsPath,
  SUPPORTED_FS_PICKER_APIS,
  type FsPickerPolicy,
  type FsPickerApi,
  type FsPickerFile,
} from "./session/fs-picker.js";
import {
  DeviceEmulationState as WebDeviceEmulationState,
  attachDeviceEmulation,
  SUPPORTED_DEVICE_APIS,
  BYOB_DEVICE_EMU_WARNING,
  type DeviceApi,
  type SyntheticDevice,
} from "./session/device-emu.js";
import { RefRegistry } from "./page/refs.js";
import { snapshotSubstrateFor } from "./page/snapshot-substrate-select.js";
import { networkSubstrateFor } from "./page/network-substrate-select.js";
import { FrameRegistry } from "./page/frames.js";
import { setTabVisibility } from "./page/visibility.js";
import { mouseAction, touchAction } from "./page/gestures.js";
import { RouteRegistry } from "./page/routes.js";
import { WsInteractiveRegistry } from "./page/ws-interactive.js";
import { WorkersRegistry } from "./page/workers.js";
import { EmulationRegistry } from "./page/emulation.js";
import { ClockRegistry } from "./page/clock.js";
import { SeededRandomRegistry } from "./page/seed-random.js";
import { PerfTracingState } from "./page/perf.js";
import { CoverageTrackerState } from "./page/coverage.js";
import { captureDomMap, diffDomMaps } from "./page/dom_diff.js";
import { RegionRegistry } from "./page/regions.js";
import { DownloadsRegistry, attachDownloadCapture } from "./page/downloads.js";
import { ArtifactsRegistry } from "./session/artifacts.js";
import { snapshotProfile, restoreProfile } from "./session/profile-snapshot.js";
import { readStorageStateFile, authLoad, type StorageStateBlob } from "./session/storage.js";
import { SecretRegistry } from "./util/secrets.js";
import {
  resolveCredentialsProvider,
  applyCredentialToRegistry,
  type ProviderCredentialInternal,
} from "./util/credentials.js";
import { ClipboardBuffer } from "./page/clipboard.js";
import { sampleMetric, ELEMENT_METRICS } from "./page/sample.js";
import { resolveConfig } from "./util/config.js";
import { clampTimeout, withDeadline, DEFAULT_ACTION_TIMEOUT_MS } from "./util/deadline.js";
import { estimateTokens } from "./util/tokens.js";
import { resolveWorkspace } from "./util/workspace.js";
import {
  DiagnosticsRecorder,
  buildEvalJsCapture,
  ensureDiagnosticsRoot,
  redactArgs,
  resolveRetentionDays,
  sweepRetention,
  type DiagnosticsRecord,
} from "./util/diagnostics.js";
import {
  ConfigStore,
  resolvedToEnv,
  type ConfigScope,
  type PersistentScope,
} from "./util/config-store.js";
import { ConsoleBuffer } from "./page/console.js";
import {
  newHarRecorderState,
  buildRecordHarOption,
  applyHarReplay,
  resolveHarReplayPaths,
  type HarStartConfig,
} from "./page/har.js";
import {
  newVideoRecorderState,
  buildRecordVideoOption,
  finalizeVideoOnClose,
  type VideoStartConfig,
} from "./page/video.js";
import {
  PlaywrightActionSubstrate,
  SafariActionSubstrate,
  type ActionSubstrate,
} from "./page/action-substrate.js";
import {
  PlaywrightCaptureSubstrate,
  SafariCaptureSubstrate,
  type CaptureSubstrate,
} from "./page/capture-substrate.js";
import {
  PlaywrightStorageSubstrate,
  SafariStorageSubstrate,
  type StorageSubstrate,
} from "./page/storage-substrate.js";
import {
  PlaywrightScriptSubstrate,
  SafariScriptSubstrate,
  type ScriptSubstrate,
} from "./page/script-substrate.js";
import {
  PlaywrightEmulationSubstrate,
  SafariEmulationSubstrate,
  type EmulationResult,
  type EmulationSubstrate,
} from "./page/emulation-substrate.js";
import { screenshotSave } from "./page/screenshot-save.js";
import type { ActionContext } from "./page/actionresult.js";
import { BrowxBridge } from "./helper/bridge.js";
import { applyOverlayHide } from "./helper/overlay-hide.js";
import { applyStealth } from "./helper/stealth.js";
import {
  resolveCaptchaProvider,
  submitToProvider,
  unconfiguredFailure,
  type CaptchaType,
} from "./page/solve-captcha.js";
import {
  resolveCapabilities,
  resolveConfirmHooks,
  isToolEnabled,
  TOOL_CAPABILITY,
  type Capability,
} from "./util/capabilities.js";
import { startPluginRuntime } from "./plugin/runtime.js";
import type { PluginRecord, PluginToolHandler, PluginToolResponse } from "./plugin/types.js";
import { RUNTIME_API_VERSION } from "./plugin/manifest.js";
import { resolveOriginPolicy, describePolicy } from "./policy/origin.js";
import { ApprovalStore } from "./policy/confirm.js";
import { Recorder } from "./page/recording.js";
import { FeedbackMemory } from "./page/learning.js";
import { log } from "./util/logging.js";
import { runBatch } from "./util/batch.js";
import { runFlakeCheck } from "./util/flake-check.js";
import { PACKAGE_VERSION } from "./util/version.js";
import type { ToolHost, ToolResponse } from "./tools/host.js";
import { registerActionTools } from "./tools/action-tools.js";
import { registerReadObserveTools } from "./tools/read-observe-tools.js";
import { registerGestureNetworkTools } from "./tools/gesture-network-tools.js";
import { registerDeepTools } from "./tools/deep-tools.js";
import { registerCaptureReportTools } from "./tools/capture-report-tools.js";
import { registerCanvasTools } from "./tools/canvas-tools.js";
import { registerStorageTools } from "./tools/storage-tools.js";
import { registerFormsRecordingTools } from "./tools/forms-recording-tools.js";
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
  const registry = new SessionRegistry(
    async (id, spec): Promise<SessionEntry> => {
      const headless = opts.headless ?? resolvedConfig.headless;
      const mode: SessionMode = spec?.mode ?? serverDefaultMode;
      // resolve the gated web-security flag *fresh* per session so a
      // `set_config({disableWebSecurity})` takes effect on the next
      // open_session without a server restart. Off by default.
      const disableWebSecurity = configStore.resolve().disableWebSecurity === true;
      // resolve device/viewport — spec overrides config-store defaults.
      const device = resolveDevice({
        device: spec?.device ?? resolvedConfig.defaultDevice,
        viewport: spec?.viewport ?? resolvedConfig.defaultViewport,
      });
      // Resolve creation-time storageState (inline blob, workspace path, OR
      // named slot). Mutually exclusive. `attached`/BYOB sessions ignore it
      // (not-owned: we don't seed someone else's Chrome).
      let creationStorageState: StorageStateBlob | undefined;
      if (spec?.storageState !== undefined && spec?.authState !== undefined) {
        throw new Error(
          `session "${id}": pass exactly one of \`storageState\` or \`authState\` (not both)`,
        );
      }
      if (spec?.authState !== undefined) {
        creationStorageState = authLoad(workspace.root, spec.authState);
      } else if (typeof spec?.storageState === "string") {
        creationStorageState = readStorageStateFile(
          workspace.root,
          spec.storageState,
          "open_session",
        );
      } else if (spec?.storageState) {
        creationStorageState = spec.storageState;
      }
      // Resolve HAR recording config (native context-creation primitive). The
      // path is workspace-rooted by construction (resolveWorkspacePath rejects
      // escape) and the parent dir is created up-front. Ignored on attached
      // (we don't mutate the consumer's Chrome).
      let creationRecordHar:
        | {
            path: string;
            mode?: "full" | "minimal";
            content?: "embed" | "attach" | "omit";
            urlFilter?: string | RegExp;
          }
        | undefined;
      let creationRecordHarResolved:
        | { path: string; mode: "full" | "minimal"; content: "embed" | "attach" | "omit" }
        | undefined;
      if (spec?.har) {
        const built = buildRecordHarOption(workspace.root, id, spec.har);
        creationRecordHar = built.recordHar;
        creationRecordHarResolved = { path: built.path, mode: built.mode, content: built.content };
      }
      // Resolve replay HAR paths (workspace-escape rejected; missing file
      // errors loudly so a typo doesn't silently fall back to live network).
      let creationReplayHars: string[] | undefined;
      if (spec?.hars && spec.hars.length) {
        creationReplayHars = resolveHarReplayPaths(workspace.root, spec.hars, "open_session");
      }
      // Resolve video recording config (native context-creation primitive).
      // The target path is workspace-rooted by construction; the staging dir
      // (where Playwright auto-names the file) is also under the workspace.
      // Ignored on attached (we don't mutate the consumer's Chrome).
      let creationRecordVideo:
        | { dir: string; size?: { width: number; height: number } }
        | undefined;
      let creationRecordVideoResolved:
        | { targetPath: string; stagingDir: string; size?: { width: number; height: number } }
        | undefined;
      if (spec?.recordVideo) {
        const built = buildRecordVideoOption(workspace.root, id, spec.recordVideo);
        creationRecordVideo = built.recordVideo;
        creationRecordVideoResolved = {
          targetPath: built.targetPath,
          stagingDir: built.stagingDir,
          size: built.size,
        };
      }
      let sess: BrowserSession;
      if (mode === "attached") {
        // android attach is endpoint-DISCOVERED over adb — it does
        // NOT need BROWX_ATTACH_CDP. The desktop CDP-attach lane still requires it.
        if (serverEngine !== "android" && !opts.attachCdp) {
          throw new Error(
            `session "${id}": mode "attached" requires the server to be started with BROWX_ATTACH_CDP (per-session attach isn't supported yet)`,
          );
        }
        if (creationStorageState) {
          log.warn(
            `session "${id}": ignoring storageState/authState for attached/BYOB session — ` +
              "the consumer's Chrome is not-owned and we don't seed it. Use inject_storage_state " +
              "explicitly if you really mean to overwrite the attached browser's state.",
          );
        }
        if (creationRecordHar) {
          log.warn(
            `session "${id}": ignoring \`har\` recording for attached/BYOB session — ` +
              "the consumer's Chrome is not-owned and we don't wire context-creation primitives on it. " +
              "Use `start_har` post-attach if you really want HAR on a BYOB session " +
              "(it routes via runtime `routeFromHAR`, with the same finalize-on-context-close caveat).",
          );
          creationRecordHar = undefined;
          creationRecordHarResolved = undefined;
        }
        if (creationRecordVideo) {
          // Hard refusal: video has no runtime fallback (Playwright doesn't
          // expose mid-context video start), so a silent ignore would leave
          // the agent expecting a .webm that never lands. Surface it loudly.
          throw new Error(
            `session "${id}": \`recordVideo\` is not supported on attached / BYOB sessions — ` +
              "Playwright's `recordVideo` is a context-creation primitive and we don't " +
              "wire context-creation primitives on the consumer's Chrome (not-owned). " +
              'Open a managed session (open_session({mode:"persistent"}) or {mode:"incognito"}) ' +
              "with {recordVideo:{...}} to record.",
          );
        }
        // Attached Chrome is not-owned: device emulation is best-effort
        // (viewport via Emulation in byob.ts); isMobile/touch/UA can't be
        // retro-applied to an existing context.
        sess = await openByobSession({
          attachCdp: opts.attachCdp,
          headless,
          browserType: serverEngine,
        });
      } else if (mode === "incognito") {
        sess = await openIncognitoSession({
          headless,
          device,
          disableWebSecurity,
          storageState: creationStorageState,
          recordHar: creationRecordHar,
          recordVideo: creationRecordVideo,
          browserType: serverEngine,
        });
      } else {
        // persistent: the default session keeps the legacy single `profile`
        // dir for back-compat; named/explicit profiles get their own dir so
        // sessions don't share a cookie jar on disk.
        const profileDir =
          id === DEFAULT_SESSION_ID && !spec?.profile
            ? workspace.sub("profile")
            : workspace.sub(`profiles/${spec?.profile ?? id}`);
        // first launch — no extensions registered yet (the registry is
        // mutated by the `extensions_*` tools post-creation, and a rebuild
        // path materialises the list into launch flags then).
        sess = await openManagedSession({
          headless,
          profileDir,
          device,
          disableWebSecurity,
          storageState: creationStorageState,
          recordHar: creationRecordHar,
          recordVideo: creationRecordVideo,
          browserType: serverEngine,
        });
      }
      // Initialise HAR recorder state. If `recordHar` was wired at context
      // creation, mark the recorder `active + nativeRecord:true` so
      // `start_har` / `stop_har` can refuse cleanly (the native path can't be
      // toggled mid-session — Playwright finalizes it on context.close()).
      const harState = newHarRecorderState();
      // safari is the first non-Playwright engine: it has no Playwright Page,
      // so the Playwright-bound bookkeeping below (HAR/video recorders, console/
      // network/bridge/policy attaches, device emulation, the CDP page-event
      // reapply) is guarded `!== "safari"` — always-true for the other engines, so
      // their path is byte-identical. Safari's session context uses the snapshot
      // substrate + the no-op network substrate; the rest of its tools either route
      // through the Safari-native handle or self-gate via the page()-throw.
      if (creationRecordHarResolved && sess.engine !== "safari") {
        harState.active = true;
        harState.nativeRecord = true;
        harState.path = creationRecordHarResolved.path;
        harState.mode = creationRecordHarResolved.mode;
        harState.content = creationRecordHarResolved.content;
        harState.startedAt = Date.now();
      }
      // Initialise video recorder state. If `recordVideo` was wired at
      // context creation, mark the recorder active so `stop_video` /
      // `get_video` can refer to the reserved target path. The .webm is
      // finalized when the context closes (Playwright constraint) —
      // teardown calls `page.video().saveAs(targetPath)`.
      const videoState = newVideoRecorderState();
      if (creationRecordVideoResolved && sess.engine !== "safari") {
        videoState.active = true;
        videoState.targetPath = creationRecordVideoResolved.targetPath;
        videoState.stagingDir = creationRecordVideoResolved.stagingDir;
        videoState.size = creationRecordVideoResolved.size;
        videoState.startedAt = Date.now();
      }
      // Apply HAR replay file(s) post-create. `routeFromHAR` is wired with
      // `notFound:"fallback"` so a request not in the archive falls through
      // to live network — the safer default. Replay is honoured on every
      // session mode (incl. attached: the consumer's Chrome receives the
      // route handler scoped to its context; warning emitted up-stream).
      if (creationReplayHars && creationReplayHars.length && sess.engine !== "safari") {
        await applyHarReplay(sess.page().context(), creationReplayHars);
      }
      const consoleBuf = new ConsoleBuffer();
      // Safari has no Playwright Page, so its console arrives over the BiDi
      // `log.entryAdded` stream — subscribed here at session creation
      // so load-time logs are caught. Strictly optional: when BiDi did not
      // negotiate (no experimental cap), the buffer stays empty (console_read still
      // works, returning nothing). Every other engine attaches to the page.
      if (sess.engine !== "safari") {
        consoleBuf.attach(sess.page());
      } else {
        const safariConsoleHandle = sess.safari?.();
        if (safariConsoleHandle?.bidi) {
          const bidi = safariConsoleHandle.bidi;
          await bidi.subscribe(["log.entryAdded"]).catch(() => undefined);
          bidi.on("log.entryAdded", (p) => {
            const level = typeof p.level === "string" ? p.level : "info";
            const text = typeof p.text === "string" ? p.text : "";
            consoleBuf.ingest(level, text);
          });
        }
      }
      // The network/WS substrate is selected by engine capability:
      // chromium (CDP present) gets the verbatim CDP NetworkBuffer/WsBuffer/tap;
      // firefox/webkit get the Playwright context-event buffers. The session-wide
      // rings attach once here; the action window mints its per-action tap from
      // the substrate and `network_body` fetches through it — so the network tools
      // + the envelope's network slice run on every engine.
      const networkSub = networkSubstrateFor(sess);
      await networkSub.attach();
      const networkBuf = networkSub.http;
      const wsBuf = networkSub.ws;
      // per-session secrets registry. Empty until `register_secret` is
      // called; the egress sinks below all reference this same instance so
      // a later register-call lights up masking globally for the session.
      const secretsReg = new SecretRegistry();
      consoleBuf.setSecrets(secretsReg);
      networkSub.setSecrets(secretsReg);
      const br = new BrowxBridge();
      if (sess.engine !== "safari") await br.attach(sess.page().context());
      // dialog policy — install per-page on current + future pages.
      // Default `raise` (deterministic anti-deadlock). `spec.dialogPolicy`
      // is already a normalised `DialogPolicy` object; the string parsing
      // happens at the open_session tool layer.
      const dialogState = new DialogPolicyState(spec?.dialogPolicy ?? { mode: "raise" });
      if (sess.engine !== "safari") attachDialogPolicy(sess.page().context(), dialogState);
      // permission policy — install per-context binding + init-script wrappers,
      // plus the CDP baseline (Browser.setPermission per supported name).
      // Default `raise` (deterministic anti-deadlock); same posture as
      // `dialogState`. The ask-human handler routes through the bridge —
      // `__browx.confirm(true|false)` from page-side DevTools releases the
      // wait, same mechanism as `await_human({kind:"confirm"})`. Best-effort:
      // attach failures still leave the CDP baseline below in place.
      const permissionState = new PermissionPolicyState(
        spec?.permissionPolicy ?? { mode: "raise" },
      );
      if (sess.engine !== "safari") {
        await attachPermissionPolicy(
          sess.page().context(),
          permissionState,
          async (permission, origin) => {
            log.info(
              `permission ask-human: ${permission}${origin ? ` (${origin})` : ""} → call __browx.confirm(true|false) in DevTools to respond`,
            );
            try {
              const sig = await br.awaitSignal("respond", 300_000);
              const data = sig.data as { kind?: string; value?: unknown } | null;
              if (data && data.kind === "confirm" && data.value === true) return "allow";
              return "deny";
            } catch {
              return "deny";
            }
          },
        );
        await applyPermissionCdpBaseline(sess.page().context(), permissionState).catch(
          () => undefined,
        );
      }
      // Notification-construction policy — install per-context wrapper +
      // binding around `new Notification(...)`. Default `allow` preserves
      // browser default (constructor proceeds; OS displays per its settings)
      // while still surfacing every call on ActionResult.notifications[].
      // Distinct policy from `permissionPolicy.notifications` — that one
      // governs the permission *request* (`Notification.requestPermission`),
      // this one governs the *constructor* (`new Notification()`); they
      // compose. Best-effort: install failures still leave the browser-default
      // path in place (the wrapper falls through when the binding is missing).
      const notificationState = new NotificationPolicyState(
        spec?.notificationPolicy ?? { mode: "allow" },
      );
      if (sess.engine !== "safari")
        await attachNotificationPolicy(sess.page().context(), notificationState, async (n) => {
          log.info(
            `notification ask-human: ${JSON.stringify({ title: n.title, origin: n.origin })} → call __browx.confirm(true|false) in DevTools to respond`,
          );
          try {
            const sig = await br.awaitSignal("respond", 300_000);
            const data = sig.data as { kind?: string; value?: unknown } | null;
            if (data && data.kind === "confirm" && data.value === true) return "allow";
            return "deny";
          } catch {
            return "deny";
          }
        });
      // File System Access picker policy — install per-context binding +
      // init-script stubs. Default `raise` (deterministic anti-deadlock:
      // without a policy installed, modern web editors that call
      // `showSaveFilePicker` etc. block every subsequent browser event on
      // the OS file chooser that headless can't drive). The ask-human
      // handler routes through the bridge — `__browx.respond(<files>)` from
      // page-side DevTools releases the wait; falsy answer → deny. The
      // server-side write target for `createWritable()` is workspace-rooted
      // and the path is validated against `workspace.root` at
      // `fs_picker_respond` time.
      const fsPickerState = new FsPickerPolicyState(spec?.fsPickerPolicy ?? { mode: "raise" });
      if (sess.engine !== "safari")
        await attachFsPickerPolicy(
          sess.page().context(),
          fsPickerState,
          workspace.root,
          async (api, suggestedName) => {
            log.info(
              `fs-picker ask-human: ${api}${suggestedName ? ` (${suggestedName})` : ""} → call __browx.respond({files:[…]}) in DevTools (or fs_picker_respond) to answer`,
            );
            try {
              const sig = await br.awaitSignal("respond", 300_000);
              const data = sig.data as { kind?: string; value?: unknown } | null;
              if (
                data &&
                data.kind === "fs_picker_respond" &&
                Array.isArray((data.value as { files?: unknown })?.files)
              ) {
                return (data.value as { files: FsPickerFile[] }).files;
              }
              return null;
            } catch {
              return null;
            }
          },
        ).catch(() => undefined);
      // Per-session download capture. Storage dir is workspace-rooted +
      // per-session — kept off the public profile dir so cleaning up captured
      // artefacts is a single rmdir without touching the profile. The
      // registry is off by default; the `downloads_capture` MCP tool toggles
      // it. Always attach the context listener — when capture is off it just
      // discards Playwright's temp file.
      const downloadsDir = workspace.sub(`.downloads/${id}`);
      const downloadsReg = new DownloadsRegistry(downloadsDir);
      if (sess.engine !== "safari") attachDownloadCapture(sess.page().context(), downloadsReg);
      // Per-session artifact KV. Storage dir is workspace-rooted +
      // per-session; the dir itself is created lazily on first save, and
      // wiped on session teardown (see `teardown` below). Capacity-bounded
      // — 200 entries / 50 MiB, oldest-write evicted.
      const artifactsDir = workspace.sub(`.artifacts/${id}`);
      const artifactsReg = new ArtifactsRegistry(artifactsDir);
      // resolve overlay selectors fresh per session so a
      // `set_config({hideOverlaySelectors})` applies to the next
      // open_session without a server restart. Empty list → no-op.
      if (sess.engine !== "safari")
        await applyOverlayHide(sess.page().context(), configStore.resolve().hideOverlaySelectors);
      // Per-context stealth init-script patches (capability `stealth`).
      // Off by default; when on, overrides navigator.webdriver / plugins /
      // languages / window.chrome on every page before page scripts run.
      // Loud-warned at boot — see the `stealth` warning above.
      if (caps.enabled.has("stealth") && sess.engine !== "safari") {
        await applyStealth(sess.page().context()).catch((err) => {
          log.warn(
            `stealth: failed to apply init script — ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      // Fresh per-primitive device-emulation state (locale, timezone,
      // geolocation, colour scheme, reduced motion, user-agent, permissions).
      // Re-applied on every new page in this context so a mid-session-opened
      // tab inherits the overrides (locale/timezone/UA via CDP, geolocation/
      // colour-scheme/reduced-motion/permissions via Playwright).
      const deviceEmulation = newEmulationState();
      // Per-session Web Bluetooth / WebUSB / WebHID synthetic-device catalogs
      // (capability `device-emulation`). The init-script wrappers install
      // unconditionally — even capability-off, so a page calling
      // `navigator.bluetooth.requestDevice()` on headless Chromium sees the
      // user-dismissed-picker shape rather than a hung promise — but the
      // check binding short-circuits to `refused` when the capability isn't
      // on. `emulate_bluetooth` / `emulate_usb` / `emulate_hid` populate the
      // catalog at runtime.
      const webDeviceEmulation = new WebDeviceEmulationState(caps.enabled.has("device-emulation"));
      if (sess.engine !== "safari") {
        await attachDeviceEmulation(sess.page().context(), webDeviceEmulation).catch(
          () => undefined,
        );
        sess
          .page()
          .context()
          .on("page", (newPage) => {
            // Best-effort: a new tab fires here. Create its own CDP session to
            // route locale/timezone/UA overrides. Errors swallowed — re-apply
            // never breaks a navigation.
            (async () => {
              try {
                const newCdp = await sess.page().context().newCDPSession(newPage);
                await reapplyEmulation(sess.page().context(), newPage, newCdp, deviceEmulation);
              } catch {
                /* best-effort */
              }
            })().catch(() => undefined);
          });
      }
      return {
        id,
        mode,
        session: sess,
        refs: new RefRegistry(),
        // Engine-agnostic snapshot/a11y substrate. chromium → the
        // verbatim CDP substrate; firefox/webkit → the page-side walker. Selected
        // by the engine's CDP capability, not an engine-name check (the same
        // signal requireCdp keys on). Captured once here so the hot snapshot/find
        // path is a direct delegate, no per-call allocation.
        snapshotSubstrate: snapshotSubstrateFor(sess),
        // Engine-agnostic network substrate. `network` / `ws` below
        // ARE this substrate's session-wide rings; the action window mints its
        // per-action tap from it. Captured once here so the hot envelope path is
        // a captured-handle delegate (no per-call allocation beyond the per-action
        // tap the CDP path already allocated).
        networkSubstrate: networkSub,
        frames: new FrameRegistry(),
        console: consoleBuf,
        network: networkBuf,
        ws: wsBuf,
        bridge: br,
        recorder: new Recorder(),
        feedback: new FeedbackMemory(),
        clipboard: new ClipboardBuffer(),
        routes: new RouteRegistry(),
        wsInteractive: await (async () => {
          // Install the page-side WS wrapper EAGERLY at session creation —
          // before any navigation — so a page that constructs `new WebSocket(...)`
          // during initial document parse hits the wrapped constructor. A
          // lazy install (deferred to first ws_send / ws_intercept) misses
          // sockets opened by the existing document, since `addInitScript`
          // only fires on the next nav. Capability-gated: only install
          // when `action` is on (the gate the three interactive tools sit
          // under) so a read-only server gets zero overhead.
          const reg = new WsInteractiveRegistry();
          if (caps.enabled.has("action") && sess.engine !== "safari") {
            await reg.install(sess.page()).catch(() => undefined);
          }
          return reg;
        })(),
        workers: await (async () => {
          // workers visibility. Same eager-install posture as
          // wsInteractive — `addInitScript` only fires on the NEXT nav, so we
          // need the wrapper live before any document parse. The page-side
          // wrapper is a thin Worker constructor proxy (cheap), so it
          // installs whenever `read` is enabled. SW CDP listener install is
          // deferred to first `workers_list` / `sw_intercept_fetch` to keep
          // workerless sessions zero-overhead.
          const reg = new WorkersRegistry();
          if (caps.enabled.has("read") && sess.engine !== "safari") {
            await reg.installPageWrapper(sess.page()).catch(() => undefined);
          }
          return reg;
        })(),
        regions: new RegionRegistry(),
        emulation: new EmulationRegistry(),
        clock: new ClockRegistry(),
        seededRandom: new SeededRandomRegistry(),
        perf: new PerfTracingState(),
        coverage: new CoverageTrackerState(),
        wedge: new WedgeTracker(),
        metrics: new SessionMetrics(),
        dialog: dialogState,
        permission: permissionState,
        notification: notificationState,
        fsPicker: fsPickerState,
        deviceEmulation,
        webDeviceEmulation,
        har: harState,
        video: videoState,
        secrets: secretsReg,
        extensions: newExtensionRegistry(),
        downloads: downloadsReg,
        artifacts: artifactsReg,
        ...(mode === "persistent" ? { launchProfile: spec?.profile ?? id } : {}),
        openedAt: Date.now(),
        lastActivityAt: Date.now(),
      };
    },
    async (e): Promise<void> => {
      // Stop any in-flight perf trace BEFORE closing CDP — otherwise the
      // attached Chrome (BYOB) keeps the trace buffer pinned. Best-effort:
      // a stuck Tracing.end won't block teardown (perf state bounds the wait).
      if (e.session.engine !== "safari")
        await e.perf.closeIfRunning(requireCdp(e.session)).catch(() => undefined);
      // also release any in-flight Profiler/CSS coverage on
      // the attached target so a BYOB Chrome doesn't keep coverage state
      // pinned past detach.
      if (e.session.engine !== "safari")
        await e.coverage.closeIfRunning(requireCdp(e.session)).catch(() => undefined);
      // workers registry CDP listeners. Detach before CDP closes
      // so we don't race the parent session shutdown.
      try {
        e.workers.dispose();
      } catch {
        /* best-effort */
      }
      await e.bridge.detach().catch(() => undefined);
      // Capture page reference BEFORE close — `page.video()` resolves the
      // Video handle, but the actual .webm is only flushed by the underlying
      // context.close() that `e.session.close()` triggers. `video.saveAs()`
      // (called inside finalizeVideoOnClose) blocks until the page is closed
      // AND the recording is fully written, so the order is: grab page →
      // close context → saveAs to deterministic target path.
      const videoPage = e.video.active ? e.session.page() : undefined;
      await e.session.close().catch(() => undefined);
      if (videoPage) {
        await finalizeVideoOnClose(videoPage, e.video).catch(() => undefined);
      }
      // Clear session-scoped artifacts on teardown. Best-effort: a stuck
      // rm won't block teardown. Sessions that never wrote an artifact
      // never create the dir, so this is a no-op for them.
      try {
        e.artifacts.clear();
      } catch {
        /* best-effort */
      }
    },
  );

  const entryFor = (sessionId?: string): Promise<SessionEntry> =>
    registry.get(sessionId ?? DEFAULT_SESSION_ID);

  const confirmCtxFor = (e: SessionEntry) => ({
    hooks: confirmHooks,
    policy: originPolicy,
    bridge: e.bridge,
    isByob,
    approvals,
  });

  /** Disabled-tool early-return shape. Used at the top of each handler:
   *    const g = gateCheck("foo"); if (g) return g;
   *  Returns null when the tool is enabled (handler proceeds). */
  const gateCheck = (toolName: string) => {
    if (isToolEnabled(toolName, caps)) return null;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: false,
              error: `tool "${toolName}" is disabled — its capability is not in the server's ACTIVE set`,
              requiredCapability: TOOL_CAPABILITY[toolName] ?? null,
              activeCapabilities: [...caps.enabled],
              hint: "This tool's capability (`requiredCapability` above) is not in the server's active set. Fix: add it to `BROWX_CAPABILITIES` (or the `capabilities` config), then RESTART the browxai server — capabilities are resolved ONCE at server start, so `set_config` alone won't enable it. Two gotchas if it still doesn't take after a restart: (1) a persisted `set_config({capabilities})` layer REPLACES the BROWX_CAPABILITIES env value entirely (arrays don't merge), so a patch that omits this capability silently overrides the env var — include every capability you want, not just this one; (2) `get_config({scope:\"resolved\"}).capabilities` is the *live enforced* set (what this gate checks). See docs/threat-model.md.",
            },
            null,
            2,
          ),
        },
      ],
    };
  };

  /** Engine-dimension early-return shape — the headline of the multi-engine
   *  work. Composes with `gateCheck` (capability dimension): after the tool's
   *  capability is confirmed active and the session is resolved, this refuses a
   *  CDP-deep tool (audit class B + the live-CDP class-C tools) on an engine
   *  that declares no `deep` escape hatch (firefox), with a structured hint —
   *  the same refusal-with-hint pattern `pdf_save`-on-BYOB uses. Returns null
   *  when the engine supports the tool (the fast path on chromium and for every
   *  cross-browser tool).
   *
   *    const eg = engineGate("perf_start", e); if (eg) return eg;
   */
  const engineGate = (toolName: string, e: SessionEntry) => {
    const refusal = assertEngineSupports(toolName, e.session.engine);
    if (!refusal) return null;
    const body = {
      ok: false,
      error: refusal.error,
      engine: e.session.engine,
      hint: refusal.hint,
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
            null,
            2,
          ),
        },
      ],
    };
  };

  /** Confirm-hook early-return helper. Returns the rejection content if denied, else null. */
  const denyContent = (toolName: string, decision: { reason: string }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            action: { type: toolName },
            error: `policy: ${decision.reason}`,
            hint: "This is NOT a human-approval wall and NOT a selector failure. As an MCP client, call `approve_actions({ scopes:[…], ttlSeconds })` once at session start to enable action tools for the session (e.g. scopes:[\"byob_action\"]). Alternatives: remove the entry from BROWX_CONFIRM_REQUIRED, or a human responds `true` to the page-side confirm. Don't mark the feature unverified — it's gated, not broken.",
          },
          null,
          2,
        ),
      },
    ],
  });

  /** Reconstruct a `selectorHint` string the recorder can write into a flow file
   *  YAML. Mirrors `buildSelectorHint` for `ref`/`named`; passes through `selector`. */
  const hintFromTarget = (
    e: SessionEntry,
    target: { ref?: string; selector?: string; named?: string; coords?: { x: number; y: number } },
  ): { selectorHint: string; stability?: "high" | "medium" | "low" } | undefined => {
    // Coords targets don't correspond to a stable locator the recorder can replay —
    // skip the hint and let the recording layer omit the step's target metadata.
    if (target.coords) return undefined;
    if (target.selector) return { selectorHint: target.selector };
    let ref = target.ref;
    if (target.named) ref = e.refs.refByNameLookup(target.named);
    if (!ref) return undefined;
    const inputs = e.refs.locatorOf(ref);
    if (!inputs) return undefined;
    if (inputs.testId) {
      const attr = inputs.testIdAttr ?? "data-testid";
      return { selectorHint: `[${attr}="${inputs.testId}"]`, stability: "high" };
    }
    if (inputs.name)
      return { selectorHint: `role=${inputs.role}[name="${inputs.name}"]`, stability: "medium" };
    return { selectorHint: `role=${inputs.role}`, stability: "low" };
  };

  const ctxFor = (e: SessionEntry): ActionContext => ({
    page: e.session.page(),
    // The action window mints its per-action network tap from this substrate
    // by engine capability: chromium → the CDP NetworkTap; firefox/webkit → the
    // Playwright context-event tap. So the envelope's network slice is real on
    // every engine, not just chromium.
    network: e.networkSubstrate,
    snapshot: e.snapshotSubstrate,
    refs: e.refs,
    console: e.console,
    pages: () => e.session.page().context().pages(),
    testAttributes: config.testAttributes,
    originPolicy,
    recorder: e.recorder,
    ws: e.ws,
    dialog: e.dialog,
    permission: e.permission,
    notification: e.notification,
    fsPicker: e.fsPicker,
    // pass the secrets registry only when the capability is on; the
    // registry exists per-session regardless (kept on SessionEntry so
    // setters wired at creation can reference it), but the action layer
    // only consults it when the capability gate is open.
    ...(caps.enabled.has("secrets") ? { secrets: e.secrets } : {}),
    // pass the downloads registry only when `file-io` is on. The registry
    // exists per-session regardless (off-by-default state on SessionEntry),
    // but the action-window only consults it when the capability gate is
    // open so a server without `file-io` can never surface a downloads
    // block.
    ...(caps.enabled.has("file-io") ? { downloads: e.downloads } : {}),
  });

  // The action capability port: selected by the engine's capability,
  // exactly like `snapshotSubstrateFor` / `networkSubstrateFor`. Playwright engines
  // wrap `actions.*` over a fresh ActionContext; safari (no Playwright Page) wraps
  // the WebDriver Classic action path. Handlers call `actionsFor(e).<action>(args)`
  // and never branch on engine.
  const actionsFor = (e: SessionEntry): ActionSubstrate => {
    const safariHandle = e.session.safari?.();
    if (safariHandle) return new SafariActionSubstrate(safariHandle, e.refs);
    return new PlaywrightActionSubstrate(() => ctxFor(e), e.session.engine);
  };

  // The capture capability port: selected by the engine's capability,
  // exactly like `actionsFor` / `snapshotSubstrateFor`. Playwright engines wrap the
  // existing `page.screenshot` / `locator.screenshot` logic (jpeg, scale, fullPage,
  // element-scoped, the `path` disk-write envelope, the `describe` caption); safari
  // (no Playwright Page) wraps `webDriver.screenshot` and refuses the variants it
  // can't honour in the adapter. The `screenshot` handler calls
  // `captureFor(e).screenshot(req)` and never branches on engine.
  const captureFor = (e: SessionEntry): CaptureSubstrate => {
    const safariHandle = e.session.safari?.();
    if (safariHandle) return new SafariCaptureSubstrate(safariHandle);
    return new PlaywrightCaptureSubstrate(() => e.session.page(), e.refs, {
      describeTarget,
      save: (buf, args) => screenshotSave(buf, workspace.root, args),
    });
  };

  // The storage capability port: selected by the engine's capability,
  // exactly like `actionsFor` / `captureFor`. Playwright engines wrap the existing
  // `cookiesList` / `cookiesSet` over the session's BrowserContext and the existing
  // `webStorage*` helpers over the session's Page; safari (no Playwright Page/
  // BrowserContext) wraps the WebDriver Classic cookie endpoints and the
  // `execute/sync` web-storage path, scoping to the current document in the adapter.
  // The cookie + web-storage handlers call `storageFor(e).cookies*(req)` /
  // `storageFor(e).webStorage*(kind, …)` and never branch on engine.
  const storageFor = (e: SessionEntry): StorageSubstrate => {
    const safariHandle = e.session.safari?.();
    if (safariHandle) return new SafariStorageSubstrate(safariHandle);
    return new PlaywrightStorageSubstrate(
      () => e.session.page().context(),
      () => e.session.page(),
      e.session.engine,
    );
  };

  // The script capability port: selected by the engine's capability,
  // exactly like `actionsFor` / `captureFor`. Playwright engines wrap
  // `page.evaluate`; safari (no Playwright Page) wraps the WebDriver Classic
  // `execute/sync` endpoint with the `return (…)` expression wrapping. The
  // `eval_js` handler calls `scriptFor(e).evaluate(expr)` and never branches on
  // engine — the deadline race + error envelope stay in the handler.
  const scriptFor = (e: SessionEntry): ScriptSubstrate => {
    const safariHandle = e.session.safari?.();
    if (safariHandle) return new SafariScriptSubstrate(safariHandle);
    return new PlaywrightScriptSubstrate(() => e.session.page(), e.session.engine);
  };

  // The live-emulation capability port: selected by the engine's
  // capability, exactly like `actionsFor` / `captureFor`. Playwright engines wrap
  // the existing `context.setGeolocation` / `page.emulateMedia` live mutators;
  // safari has no live-emulation surface beyond viewport, so the adapter refuses
  // these three cleanly. Scoped to the three cross-browser live primitives only —
  // the CDP-only `set_locale` / `set_timezone` / `set_user_agent` stay engine-
  // gated, and `set_viewport` lives in the ActionSubstrate. The handlers call
  // `emulationFor(e).set*(…)` and never branch on engine; the `deviceEmulation`
  // state mutation + warnings + envelope stay in the handler.
  const emulationFor = (e: SessionEntry): EmulationSubstrate => {
    const safariHandle = e.session.safari?.();
    if (safariHandle) return new SafariEmulationSubstrate(safariHandle);
    return new PlaywrightEmulationSubstrate(
      () => e.session.page().context(),
      () => e.session.page(),
      e.session.engine,
    );
  };

  // resolve the effective anti-wedge deadline for a call —
  // per-call `timeoutMs` over config `actionTimeoutMs` over the 5000 default,
  // clamped to [1, 3_600_000]. `warning` is non-empty when the caller asked
  // for an over-ceiling (insane) value.
  const cfgActionTimeout = (): number => {
    const v = configStore.resolve().actionTimeoutMs;
    return typeof v === "number" && v > 0 ? v : DEFAULT_ACTION_TIMEOUT_MS;
  };
  const actionTimeout = (args: { timeoutMs?: number }): { ms: number; warning?: string } =>
    clampTimeout(args.timeoutMs, cfgActionTimeout());

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

  // Wedge tracking. Only tools that actually exercise the page can
  // wedge a session; session-management / config / coordination tools are
  // excluded so their (always fast) results don't reset the streak.
  const WEDGE_TRACKED_CAPABILITIES = new Set<string>([
    "read",
    "navigation",
    "action",
    "eval",
    "network-body",
    "file-io",
  ]);
  /** First text item of a result, parsed as a JSON object — or null when the
   *  result has no leading JSON object (a plain-text snapshot, an image). */
  const firstJsonResult = (
    res: ToolResponse,
  ): { obj: Record<string, unknown>; idx: number } | null => {
    for (let i = 0; i < res.content.length; i++) {
      const item = res.content[i];
      if (item && item.type === "text") {
        try {
          const parsed: unknown = JSON.parse(item.text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { obj: parsed as Record<string, unknown>, idx: i };
          }
        } catch {
          /* not JSON — a plain-text result, e.g. a snapshot tree */
        }
        return null;
      }
    }
    return null;
  };
  /** Update the session's wedge counter from a tool result and, once the
   *  session is wedged, splice `sessionWedged` + a recovery hint onto it.
   *  An anti-wedge timeout increments the streak; any responsive result
   *  (success, or a fast non-timeout error) clears it.
   *
   *  Before stamping `sessionWedged: true`, the threshold-trip path probes
   *  the page with a 1s `evaluate(() => 1)` — if the page answers, the
   *  session is alive (the timeouts were action-shaped, not page-shaped:
   *  perpetually-busy SPAs hold WS keepalives / rAF loops that prevent
   *  Playwright actionability from settling, but the page itself responds
   *  fine to evaluate). A successful probe clears the streak instead of
   *  falsely tipping the caller into a session-discard. */
  const noteWedgeOutcome = async (args: unknown, res: ToolResponse): Promise<ToolResponse> => {
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    if (!entry) return res;
    const parsed = firstJsonResult(res);
    const timedOut =
      !!parsed &&
      parsed.obj.ok === false &&
      typeof parsed.obj.error === "string" &&
      /anti-wedge timeout/i.test(parsed.obj.error);
    if (!timedOut || !parsed) {
      entry.wedge.recordResponsive();
      return res;
    }
    entry.wedge.recordTimeout();
    if (!entry.wedge.wedged()) return res;
    // Threshold tripped — confirm before stamping. Cheap liveness probe:
    // if the page answers evaluate() within 1s, the session is alive and
    // the timeouts were action-shaped (e.g. busy SPA blocks click
    // actionability). Clear the streak rather than falsely wedge the
    // caller. If the probe fails or times out, the session genuinely is
    // wedged — stamp the response as before.
    let aliveByProbe = false;
    try {
      const page = entry.session.page();
      await withDeadline(
        page.evaluate(() => 1),
        1_000,
        "wedge_probe",
      );
      aliveByProbe = true;
    } catch {
      aliveByProbe = false;
    }
    if (aliveByProbe) {
      entry.wedge.recordResponsive();
      return res;
    }
    const obj = { ...parsed.obj, sessionWedged: true, sessionWedgedHint: entry.wedge.hint() };
    return {
      content: res.content.map((item, i) =>
        i === parsed.idx ? { type: "text" as const, text: JSON.stringify(obj, null, 2) } : item,
      ),
    };
  };

  // Classify a dispatched tool result for the per-session metrics
  // counter. We piggyback on `firstJsonResult` (already defined above) so we
  // don't pay a second parse. A capability-denied result is the JSON shape the
  // `gateCheck` helper emits (carries `requiredCapability`); any other
  // `ok:false` result is an error; everything else is `ok`. The
  // `tokensEstimate` field is read straight off the envelope when present —
  // most tools surface it via the standard helper, but image-only / non-JSON
  // results legitimately don't and that's fine (treated as 0).
  const classifyOutcome = (
    res: ToolResponse,
  ): { outcome: DispatchOutcome; tokensEstimate?: number } => {
    const parsed = firstJsonResult(res);
    if (!parsed) return { outcome: "ok" };
    const obj = parsed.obj;
    const tokens = typeof obj.tokensEstimate === "number" ? obj.tokensEstimate : undefined;
    if (obj.ok === false) {
      // Capability-denied shape (see `gateCheck`): carries `requiredCapability`.
      // The denial path is a config-shape signal, not a tool-error signal —
      // bucket it separately.
      if (Object.prototype.hasOwnProperty.call(obj, "requiredCapability")) {
        return { outcome: "denied", tokensEstimate: tokens };
      }
      return { outcome: "error", tokensEstimate: tokens };
    }
    return { outcome: "ok", tokensEstimate: tokens };
  };

  /** Record one dispatch on the session's metrics counter — peek-only on the
   *  registry. Calls against a not-yet-open session (e.g. a capability denial
   *  fired before the lazy session creation) are silently skipped: there's no
   *  SessionEntry to accumulate against, and the denial is still visible at the
   *  capability layer. Same posture as `noteWedgeOutcome` above. */
  const noteMetrics = (
    toolName: string,
    args: unknown,
    res: ToolResponse,
    startedAt: number,
  ): void => {
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    if (!entry) return;
    const { outcome, tokensEstimate } = classifyOutcome(res);
    entry.metrics.record(toolName, outcome, Date.now() - startedAt, tokensEstimate);
  };

  /** Record one dispatched call into the diagnostics JSONL store. No-op when
   *  the diagnostics capability is OFF — the caller short-circuits on
   *  `diagnostics.enabled` BEFORE allocating anything. The recorder runs
   *  DOWNSTREAM of the URL sanitiser + secrets-masking chokepoint:
   *  by the time `res` lands here, every egress sink has already rewritten
   *  registered secret values back to `<NAME>` aliases. Args are additionally
   *  walked through `applyMaskDeep` so a secret echoed in the call args
   *  never reaches the JSONL raw. */
  const noteDiagnostics = (
    toolName: string,
    args: unknown,
    res: ToolResponse,
    startedAt: number,
  ): void => {
    if (!diagnostics.enabled) return;
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    // Apply the per-session secrets mask to args BEFORE structural redaction
    // so a registered secret value echoed in the call args never lands raw
    // in the JSONL store.
    const maskedArgsIn = entry?.secrets ? entry.secrets.applyMaskDeep(args) : args;
    const parsed = firstJsonResult(res);
    const sizeBytes = res.content.reduce((n, item) => {
      if (item.type === "text") return n + Buffer.byteLength(item.text, "utf8");
      if (item.type === "image") return n + (typeof item.data === "string" ? item.data.length : 0);
      return n;
    }, 0);
    const obj = parsed?.obj ?? null;
    const ok = obj ? obj.ok !== false : true;
    const warningsCount = obj && Array.isArray(obj.warnings) ? obj.warnings.length : 0;
    let failureKind: string | undefined;
    if (!ok && obj) {
      if (Object.prototype.hasOwnProperty.call(obj, "requiredCapability")) {
        failureKind = "capability-denied";
        diagnostics.noteDenial();
      } else {
        const err = typeof obj.error === "string" ? obj.error : "";
        if (/anti-wedge timeout/i.test(err)) failureKind = "timeout";
        else if (/not found|no element matches|ref not found|locator did not resolve/i.test(err))
          failureKind = "target-not-found";
        else if (/must |invalid |unknown |expected /i.test(err)) failureKind = "bad-arg";
        else failureKind = "internal";
      }
    }
    const record: DiagnosticsRecord = {
      kind: "call",
      ts: new Date(startedAt).toISOString(),
      tool: toolName,
      sessionId,
      argsRedacted: redactArgs(maskedArgsIn),
      resultMeta: {
        ok,
        sizeBytes,
        warningsCount,
        ...(failureKind ? { failureKind } : {}),
      },
      durationMs: Date.now() - startedAt,
      capabilityDenials: diagnostics.denialsCount(),
    };
    const evalCap = buildEvalJsCapture(toolName, maskedArgsIn, obj);
    if (evalCap) record.evalJs = evalCap;
    diagnostics.write(record);
  };

  // Wrapper that preserves the inner handler's parameter type for typechecking
  // (destructuring inside each registration still works) but stores a
  // type-erased copy for `batch` dispatch. Page-exercising tools additionally
  // route their result through the wedge tracker; every tool is timed +
  // counted on the session's per-session metrics rollup. When the
  // `diagnostics` capability is on, each dispatch ALSO lands as a JSONL
  // record under $BROWX_WORKSPACE/diagnostics/<sessionId>/<ISO>.jsonl;
  // when off, the recorder is a zero-overhead gate check (no allocations,
  // no file IO).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = <H extends (...a: any[]) => Promise<ToolResponse>>(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def: { description: string; inputSchema?: any },
    handler: H,
  ): void => {
    const raw = handler as (args: unknown) => Promise<ToolResponse>;
    const tracked = WEDGE_TRACKED_CAPABILITIES.has(TOOL_CAPABILITY[name] ?? "");
    const wrapped: (args: unknown) => Promise<ToolResponse> = async (args: unknown) => {
      const startedAt = Date.now();
      const inner = tracked ? await noteWedgeOutcome(args, await raw(args)) : await raw(args);
      noteMetrics(name, args, inner, startedAt);
      noteDiagnostics(name, args, inner, startedAt);
      return inner;
    };
    toolHandlers[name] = wrapped;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(name, def, wrapped);
  };

  // ---------- action tools ----------

  const asActionResultText = async (p: Promise<unknown>) => {
    const r = await p;
    return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
  };

  /** JSON envelope for the non-action families: stringify with `tokensEstimate`. */
  const okText = (
    body: Record<string, unknown>,
  ): { content: Array<{ type: "text"; text: string }> } => {
    const json = JSON.stringify(body);
    const tokensEstimate = estimateTokens(json);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
      ],
    };
  };
  /** Same shape for an `ok:false` rejection so callers see a uniform envelope. */
  const errText = (
    tool: string,
    err: unknown,
  ): { content: Array<{ type: "text"; text: string }> } =>
    okText({ ok: false, tool, error: err instanceof Error ? err.message : String(err) });

  // Tools that can be invoked inside `batch`. Excludes: `batch` itself (no
  // nesting — keeps semantics simple and avoids combinatorial confusion);
  // `await_human` (blocks indefinitely, defeats batching's point); recording
  // controls (`start_recording`/`end_recording`/`record_annotate` — meant for
  // interactive sessions); CLI-style helpers that mutate session config. Shared
  // with the compound tools through the host, so it is defined before the host
  // literal that exposes it.
  const BATCH_ALLOWED_TOOLS = new Set<string>([
    "navigate",
    "click",
    "fill",
    "fill_form",
    "press",
    "hover",
    "select",
    "choose_option",
    "wait_for",
    "go_back",
    "go_forward",
    "scroll",
    "set_viewport",
    "set_locale",
    "set_timezone",
    "set_geolocation",
    "set_color_scheme",
    "set_reduced_motion",
    "set_user_agent",
    "grant_permissions",
    "plan",
    "execute",
    "snapshot",
    "find",
    "text_search",
    "frames_list",
    "shadow_trees",
    "inspect",
    "overflow_detect",
    "watch",
    "sample",
    "screenshot",
    "screenshot_marks",
    "console_read",
    "network_read",
    "ws_read",
    "network_body",
    "verify_visible",
    "verify_text",
    "verify_value",
    "verify_count",
    "verify_attribute",
    "verify_predicate",
    "eval_js",
    "list_named_refs",
    "name_ref",
    "find_feedback",
    "generate_locator",
    "approve_actions",
    "list_approvals",
    "get_config",
    "list_sessions",
    "session_metrics",
    "network_emulate",
    "cpu_emulate",
    "clock",
    "seed_random",
    "start_har",
    "stop_har",
    "stop_video",
    "get_video",
    "perf_start",
    "perf_stop",
    "perf_insights",
    "perf_audit",
    "coverage_start",
    "coverage_stop",
    "layout_thrash_trace",
    "memory_diff",
    "heap_snapshot",
    "heap_retainers",
  ]);

  // The composition seam: bundle the shared state + helper closures into one
  // host and hand it to each per-family tool module. createServer stays the
  // registry composition root; the register() blocks live under src/tools/.
  const host: ToolHost = {
    register,
    entryFor,
    gateCheck,
    engineGate,
    confirmCtxFor,
    ctxFor,
    workspace,
    denyContent,
    asActionResultText,
    okText,
    errText,
    asTarget,
    hintFromTarget,
    actionTimeout,
    cfgActionTimeout,
    actionsFor,
    captureFor,
    storageFor,
    scriptFor,
    emulationFor,
    caps,
    config,
    configStore,
    z,
    toolHandlers,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
    registry,
    diagnostics,
  };

  registerReadObserveTools(host);
  registerActionTools(host);
  registerGestureNetworkTools(host);
  registerDeepTools(host);
  registerCaptureReportTools(host);
  registerCanvasTools(host);
  registerStorageTools(host);
  registerFormsRecordingTools(host);

  // ---------- gestures, route mocking, compound act-and-observe tools ----------
  // These were promoted from the experimental lane into the stable surface
  // under their natural capabilities (gestures/route = `action`, compound
  // observe tools = `read`, region/profile coordination = `human`).

  // A *factory* — each call returns a fresh schema instance. Reusing one
  // shared instance across `from`/`to`/`target` made zod-to-json-schema emit a
  // `$ref` for the repeats, which some MCP schema viewers render wrong (the
  // reported `drag.to.coords` showing as `string`). Distinct instances → no
  // `$ref` dedup → every field renders identically.
  for (const act of ["mouse_down", "mouse_move", "mouse_up"] as const) {
    register(
      act,
      {
        description: `Low-level ${act.replace("_", " ")} for custom gestures the higher-level tools don't cover (scrub/trim handles). ${act === "mouse_move" ? "Requires `coords`." : "`coords` optional — moves there first when given, else acts at the current pointer position."}`,
        inputSchema: {
          coords: z
            .object({ x: z.number(), y: z.number() })
            .optional()
            .describe("Viewport CSS px."),
          ...SESSION_ARG,
        },
      },
      async ({ coords, session }) => {
        const g = gateCheck(act);
        if (g) return g;
        const e = await entryFor(session);
        try {
          const r = await withDeadline(
            mouseAction(e.session.page(), act.slice(6) as "down" | "move" | "up", coords),
            cfgActionTimeout(),
            act,
          );
          return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ok: false, error: err instanceof Error ? err.message : String(err) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  }

  // ---------- Touch + multi-touch gestures ----------
  //
  // A separate dispatch pipeline from the `mouse_*` family. CDP
  // `Input.dispatchTouchEvent` is the touch sibling of `dispatchMouseEvent`;
  // mobile-default apps and canvas apps wire touch handlers that the mouse
  // pipeline does NOT reach. Touch events do not auto-fire mouse events
  // (browsers MAY synthesize mouse events from touchend, but it's app-policy
  // via `touch-action` / `preventDefault`); an agent that needs both must
  // dispatch both. The `identifier` field is the DOM-side
  // TouchEvent.changedTouches[].identifier — distinct ids for distinct
  // fingers across a multi-touch sequence (default 1).
  for (const act of ["touch_start", "touch_move", "touch_end"] as const) {
    const requiresCoords = act !== "touch_end";
    register(
      act,
      {
        description:
          `Dispatch ${act.replace("_", " ")} via CDP Input.dispatchTouchEvent — a separate pipeline from \`mouse_*\` for mobile-default apps and canvas / map / drawing widgets that listen for \`touchstart\` / \`touchmove\` / \`touchend\`. ${requiresCoords ? "`coords` required (viewport CSS px)." : "`coords` optional — when omitted, dispatches an empty touchPoints[] (the 'all fingers up' form)."} ` +
          "`identifier` (default 1) maps to DOM `TouchEvent.changedTouches[].identifier` — use distinct ids per finger to fan out multi-touch. Touch does NOT synthesise mouse events — dispatch mouse_* explicitly if both pipelines are needed.",
        inputSchema: {
          coords: requiresCoords
            ? z.object({ x: z.number(), y: z.number() }).describe("Viewport CSS px.")
            : z
                .object({ x: z.number(), y: z.number() })
                .optional()
                .describe(
                  "Viewport CSS px. Omit to dispatch empty touchPoints[] (all fingers up).",
                ),
          identifier: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              "Touch identifier (default 1) — distinct values per finger for multi-touch fan-out.",
            ),
          ...SESSION_ARG,
        },
      },
      async ({ coords, identifier, session }) => {
        const g = gateCheck(act);
        if (g) return g;
        const e = await entryFor(session);
        const eg = engineGate(act, e);
        if (eg) return eg;
        try {
          const r = await withDeadline(
            touchAction(requireCdp(e.session), act.slice(6) as "start" | "move" | "end", {
              coords,
              identifier,
            }),
            cfgActionTimeout(),
            act,
          );
          const json = JSON.stringify(r);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
              },
            ],
          };
        } catch (err) {
          const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  }

  for (const action of ["profile_snapshot", "profile_restore"] as const) {
    register(
      action,
      {
        description:
          action === "profile_snapshot"
            ? 'Copy a persistent session\'s profile directory into a named snapshot under `<workspace>/profile-snapshots/` — checkpoint a clean authenticated state before a destructive media-editor test. `profile` defaults to "default". ALL sessions must be closed first (copying a live profile dir corrupts it).'
            : "Restore a named profile snapshot back over a session's profile directory — reset to a clean checkpoint between destructive test runs. ALL sessions must be closed first.",
        inputSchema: {
          snapshot: z.string().describe("Snapshot name (letters/digits/._- only)."),
          profile: z
            .string()
            .optional()
            .describe(
              'Profile to snapshot/restore. Default "default" (the legacy single-profile dir); else a named profile under <workspace>/profiles/.',
            ),
        },
      },
      async ({ snapshot, profile }) => {
        const g = gateCheck(action);
        if (g) return g;
        if (registry.list().length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: `${action}: close all sessions first (close_sessions({all:true})) — copying a profile directory while Chromium has it open corrupts it`,
                    openSessions: registry.list().map((s) => s.id),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        try {
          const r =
            action === "profile_snapshot"
              ? snapshotProfile(workspace.root, profile, snapshot)
              : restoreProfile(workspace.root, profile, snapshot);
          return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ok: false, error: err instanceof Error ? err.message : String(err) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  }

  // ---------- session lifecycle ----------

  register(
    "open_session",
    {
      description:
        "Eagerly create an isolated session (own browser context / cookie jar / refs). Optional — any tool with a `session` arg lazily creates the id on first use (inheriting the server's launch mode); call this to launch up-front, fail fast, or pick a `mode`. Re-opening a live id is an error (close it first). Different ids = full isolation, so two sessions logged in as different users on the same app don't bleed. This is also the second half of wedged-session recovery: after `close_session` discards a dead session, open a fresh one here (a fresh id, or the same id reused) and restart the wedged work in it.\n\n`mode`:\n  - `persistent` (default off-attach) — own profile dir under the workspace; cookies survive across runs. `profile` names the dir (default = the session id).\n  - `incognito` — ephemeral; nothing persisted, all state discarded on close.\n  - `attached` — BYOB; requires the server started with BROWX_ATTACH_CDP.\n\nOptionally seed the new context with a storage state at creation. `storageState` accepts either an inline blob (as returned by `dump_storage_state`) or a workspace-rooted JSON path. `authState` references a named slot from `auth_save`. Mutually exclusive. Native primitive on `incognito`; on `persistent` it post-seeds AND clears the profile's existing cookies/localStorage first (loud-warned). Ignored on `attached`.",
      inputSchema: {
        session: z.string().describe('Session id to create (e.g. "agent-a", "user-2").'),
        mode: z
          .enum(["persistent", "incognito", "attached"])
          .optional()
          .describe(
            "Session mode. Default: the server's launch mode (attached if BROWX_ATTACH_CDP is set, else persistent).",
          ),
        profile: z
          .string()
          .optional()
          .describe(
            "persistent mode only: named profile dir under <workspace>/profiles/. Default = the session id. Lets two ids share a profile, or one id pin a stable profile name.",
          ),
        device: z
          .string()
          .optional()
          .describe(
            'Playwright device-preset name (e.g. "iPhone 14", "Pixel 7", "Desktop Chrome") → viewport + DPR + isMobile + hasTouch + UA. Falls back to config `defaultDevice`. Best-effort on `attached`.',
          ),
        viewport: z
          .object({ width: z.number().int().positive(), height: z.number().int().positive() })
          .optional()
          .describe(
            "explicit viewport; overrides a preset's viewport. Falls back to config `defaultViewport`.",
          ),
        dialogPolicy: z
          .string()
          .optional()
          .describe(
            'How the session handles `alert`/`confirm`/`prompt` dialogs. One of: "accept" (auto-OK), "dismiss" (auto-cancel), "accept-prompt-with:<text>" (prompts answered with `<text>`; alert/confirm accepted), "raise" (DEFAULT — dialog dismissed server-side so the page never deadlocks, but the next action returns ok:false with a structured failure so a dialog never silently changes app state under an unaware caller). Mutate at runtime with `set_dialog_policy`.',
          ),
        permissionPolicy: z
          .union([
            z.string(),
            z.object({
              mode: z.enum(["allow", "deny", "raise", "ask-human"]),
              perPermission: z.record(z.enum(["allow", "deny", "raise", "ask-human"])).optional(),
            }),
          ])
          .optional()
          .describe(
            'How the session handles page-side permission requests (camera, microphone, geolocation, notifications, clipboard, sensors). String form sets the top-level mode ("allow"|"deny"|"raise"|"ask-human"); object form takes `{mode, perPermission?:{<name>:<mode>}}` for per-permission overrides. DEFAULT "raise" — request rejected page-side so the page never deadlocks, but the next action returns ok:false with a structured failure so a permission request never silently changes app state under an unaware caller. Mutate at runtime with `set_permission_policy`. NOTE: governs the *permission check* (`Notification.requestPermission`) only — the `new Notification(...)` constructor surface is governed separately by `notificationPolicy`.',
          ),
        notificationPolicy: z
          .union([z.string(), z.object({ mode: z.enum(["allow", "deny", "raise", "ask-human"]) })])
          .optional()
          .describe(
            'How the session handles `new Notification(title, opts)` constructor calls. String form sets the mode; object form is `{mode}`. Modes mirror permissionPolicy. DEFAULT "allow" (browser default — constructor proceeds, OS displays per its settings) — but every call is still captured on `ActionResult.notifications[]` for observability. Distinct from `permissionPolicy.notifications` (which gates the W3C permission check); the two policies compose. Mutate at runtime with `set_notification_policy`.',
          ),
        fsPickerPolicy: z
          .union([
            z.string(),
            z.object({
              mode: z.enum(["allow", "deny", "raise", "ask-human"]),
              perAPI: z.record(z.enum(["allow", "deny", "raise", "ask-human"])).optional(),
            }),
          ])
          .optional()
          .describe(
            'How the session handles page-side File System Access picker calls (showOpenFilePicker, showSaveFilePicker, showDirectoryPicker). String form sets the top-level mode ("allow"|"deny"|"raise"|"ask-human"); object form takes `{mode, perAPI?:{<api>:<mode>}}` for per-API overrides. DEFAULT "raise" — picker rejected page-side so the page never deadlocks, but the next action returns ok:false with a structured failure so a picker call never silently changes app state under an unaware caller. Pair `allow` with `fs_picker_respond` to stage agent-supplied files. Mutate at runtime with `set_fs_picker_policy`.',
          ),
        storageState: z
          .union([
            z.string(),
            z
              .object({
                cookies: z.array(z.any()),
                origins: z.array(z.any()),
              })
              .passthrough(),
          ])
          .optional()
          .describe(
            "Bulk-seed: inline state blob (`{cookies, origins}` from dump_storage_state) OR a workspace-rooted JSON path. Mutually exclusive with `authState`. Native on incognito; on persistent it post-seeds AND clears the profile (loud-warned); ignored on attached.",
          ),
        authState: z
          .string()
          .optional()
          .describe(
            "Named-state seed: load a slot from `$BROWX_WORKSPACE/.auth-states/<name>.json` (written by `auth_save`). Mutually exclusive with `storageState`.",
          ),
        har: z
          .object({
            path: z
              .string()
              .optional()
              .describe(
                "Workspace-rooted HAR file path. Default: `<workspace>/har/<session-id>-<ISO>.har`. Path traversal outside `$BROWX_WORKSPACE` is rejected.",
              ),
            mode: z
              .enum(["full", "minimal"])
              .optional()
              .describe(
                "`full` (default — full HAR with sizes/timing/cookies) or `minimal` (just enough to replay via `routeFromHAR`).",
              ),
            content: z
              .enum(["embed", "attach", "omit"])
              .optional()
              .describe(
                "Body persistence: `embed` (default for `.har`) inlines bodies, `attach` writes sidecar files (default for `.zip`), `omit` drops bodies.",
              ),
            urlFilter: z
              .string()
              .optional()
              .describe("Optional glob/regex URL filter — only matching requests are stored."),
          })
          .optional()
          .describe(
            "Record HAR for the lifetime of this session via Playwright's native `recordHar` context option. The file is finalized when the session closes (Playwright constraint — there is no mid-session flush on the native path). For runtime start/stop granularity use the `start_har`/`stop_har` tools instead. Honoured on `persistent` + `incognito` (we own the context); ignored on `attached` (consumer's Chrome is not-owned).",
          ),
        hars: z
          .array(z.string())
          .optional()
          .describe(
            'REPLAY HAR file(s) — workspace-rooted paths. Each is wired via `context.routeFromHAR(file, {notFound:"fallback"})` immediately after context creation: requests in the archive are served from it, anything missing falls through to the live network. Path traversal rejected; a missing file errors (no silent fallback on a typo). Compose multiple HARs to layer fixtures.',
          ),
        recordVideo: z
          .object({
            path: z
              .string()
              .optional()
              .describe(
                "Workspace-rooted .webm file path. Default: `<workspace>/videos/<session-id>-<ISO>.webm`. Path traversal outside `$BROWX_WORKSPACE` is rejected.",
              ),
            size: z
              .object({ width: z.number().int().positive(), height: z.number().int().positive() })
              .optional()
              .describe(
                "Recorded video frame size. Defaults to the viewport scaled to fit 800x800 (Playwright default).",
              ),
          })
          .optional()
          .describe(
            "Record session video for the lifetime of this session via Playwright's native `recordVideo` context option. The .webm is finalized when the session closes (Playwright constraint — there is no mid-context flush). `stop_video` signals intent + reserves the target path; `get_video` reads the file after `close_session`. Honoured on `persistent` + `incognito` (we own the context); refused on `attached` (consumer's Chrome is not-owned). Capability `file-io` on the stop/get tools.",
          ),
      },
    },
    async ({
      session,
      mode,
      profile,
      device,
      viewport,
      dialogPolicy,
      permissionPolicy,
      notificationPolicy,
      fsPickerPolicy,
      storageState,
      authState,
      har,
      hars,
      recordVideo,
    }) => {
      if (registry.has(session)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: `session "${session}" already open; close_session first` },
                null,
                2,
              ),
            },
          ],
        };
      }
      let parsedDialogPolicy: DialogPolicy | undefined;
      let parsedPermissionPolicy: PermissionPolicy | undefined;
      let parsedNotificationPolicy: NotificationPolicy | undefined;
      let parsedFsPickerPolicy: FsPickerPolicy | undefined;
      try {
        parsedDialogPolicy = dialogPolicy ? parseDialogPolicyArg(dialogPolicy) : undefined;
        parsedPermissionPolicy = permissionPolicy
          ? parsePermissionPolicyArg(permissionPolicy as string | PermissionPolicy)
          : undefined;
        parsedNotificationPolicy = notificationPolicy
          ? parseNotificationPolicyArg(notificationPolicy as string | NotificationPolicy)
          : undefined;
        parsedFsPickerPolicy = fsPickerPolicy
          ? parseFsPickerPolicyArg(fsPickerPolicy as string | FsPickerPolicy)
          : undefined;
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
      try {
        const e = await registry.get(session, {
          mode,
          profile,
          device,
          viewport,
          dialogPolicy: parsedDialogPolicy,
          permissionPolicy: parsedPermissionPolicy,
          notificationPolicy: parsedNotificationPolicy,
          fsPickerPolicy: parsedFsPickerPolicy,
          storageState,
          authState,
          har: har as HarStartConfig | undefined,
          hars,
          recordVideo: recordVideo as VideoStartConfig | undefined,
        });
        const harField = e.har.path
          ? {
              har: {
                path: e.har.path,
                mode: e.har.mode,
                content: e.har.content,
                nativeRecord: !!e.har.nativeRecord,
                finalizesOn: "close_session" as const,
              },
            }
          : {};
        const replayField = hars && hars.length ? { harsReplay: hars.length } : {};
        const videoField =
          e.video.active && e.video.targetPath
            ? {
                video: {
                  path: e.video.targetPath,
                  size: e.video.size,
                  finalizesOn: "close_session" as const,
                },
              }
            : {};
        // safari has no Playwright Page — read the opened URL from its WebDriver
        // Classic client instead.
        const safariOpened = e.session.safari?.();
        const openedUrl = safariOpened
          ? await safariOpened.webDriver.currentUrl(safariOpened.sessionId).catch(() => "")
          : e.session.page().url();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: true,
                  session: e.id,
                  mode: e.mode,
                  url: openedUrl,
                  openedAt: new Date(e.openedAt).toISOString(),
                  ...harField,
                  ...replayField,
                  ...videoField,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "close_session",
    {
      description:
        "Tear down a session: detaches the bridge and closes the browser context (a BYOB/attached session detaches only — never closes the user's Chrome). The \"default\" session may be closed too; it'll be lazily re-created on the next call. No-op-safe. This is also the RECOVERY path for a wedged session: when calls time out repeatedly (a `sessionWedged` result, or snapshot/navigate/screenshot all timing out), close the session and `open_session` a fresh one — a wedged session is NOT recoverable in place by re-navigating or retrying.",
      inputSchema: { session: z.string().describe("Session id to close.") },
    },
    async ({ session }) => {
      const closed = await registry.close(session);
      // Diagnostics JSONL is intentionally KEPT across close_session — the
      // recovery path for a (real OR falsely-flagged) wedge IS close_session,
      // and the notes / calls filed right before the close are the most
      // valuable feedback the curator gets. Retention sweep (default 30d)
      // handles long-term cleanup; per-session removal is the wrong scope.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, session, wasOpen: closed }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "close_sessions",
    {
      description:
        "Bulk session teardown for multi-agent cleanup. Select by `prefix` (id starts-with — e.g. one agent's `agentA-*`), `all`, and/or `idleMs` (no use in the last N ms). Filters AND together; at least one selector is required (`all:true` to close everything). Returns the closed ids. Use to reclaim memory + state when a sub-agent wedged or was killed and stranded its sessions.",
      inputSchema: {
        prefix: z.string().optional().describe("Close sessions whose id starts with this."),
        all: z
          .boolean()
          .optional()
          .describe("Close every live session. Required if neither prefix nor idleMs is given."),
        idleMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Close sessions with no activity in the last N ms (idle-age reap)."),
      },
    },
    async ({ prefix, all, idleMs }) => {
      if (prefix === undefined && idleMs === undefined && all !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "close_sessions: pass `prefix`, `idleMs`, and/or `all:true` — refusing to close nothing/everything implicitly",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const closed = await registry.closeMatching({ prefix, all, idleMs });
      // Diagnostics JSONL is intentionally KEPT across session teardown —
      // notes filed pre-close are exactly the valuable feedback. Retention
      // sweep (default 30d) handles long-term cleanup.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, closed, count: closed.length }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "list_sessions",
    {
      description:
        "List live sessions: id, mode, engine, current url, page count, openedAt. Audit / coordination helper for multi-session work.",
      inputSchema: {},
    },
    async () => {
      const rows = registry.list().map((e) => ({
        id: e.id,
        mode: e.mode,
        engine: e.session.engine,
        url: (() => {
          try {
            return e.session.page().url();
          } catch {
            return null;
          }
        })(),
        pages: (() => {
          try {
            return e.session.page().context().pages().length;
          } catch {
            return null;
          }
        })(),
        openedAt: new Date(e.openedAt).toISOString(),
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ sessions: rows }, null, 2) }],
      };
    },
  );

  register(
    "set_dialog_policy",
    {
      description:
        "Mutate the session's dialog policy at runtime. Governs how `alert` / `confirm` / `prompt` / `beforeunload` dialogs are handled when fired by the page — without a policy installed, a dialog blocks every subsequent browser event and the session deadlocks. Modes:\n" +
        '  - "accept"               — accept every dialog (confirm/prompt → OK; prompt answers with the empty string).\n' +
        '  - "dismiss"              — dismiss every dialog (confirm/prompt → Cancel).\n' +
        '  - "accept-prompt-with"   — accept; prompts answer with `text` (required). Alert/confirm just accept.\n' +
        '  - "raise"                — DEFAULT. Dialog is dismissed server-side so the page never deadlocks, but the next action returns ok:false with `failure:{source:"app", hint:"unhandled dialog — set dialogPolicy"}` so a dialog can\'t silently change app state under a caller that didn\'t opt in.\n' +
        "Persists across navigation: the handler is re-installed on every new page within the session. The initial policy is set at `open_session({dialogPolicy})`; this tool replaces it. Returns the resolved policy. Fired dialogs surface on `ActionResult.dialogs[]`.",
      inputSchema: {
        mode: z
          .enum(["accept", "dismiss", "raise", "accept-prompt-with"])
          .describe("Policy mode — see tool description."),
        text: z
          .string()
          .optional()
          .describe(
            'Required when mode="accept-prompt-with" — the answer text to send for prompts. Ignored for other modes.',
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_dialog_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: DialogPolicy =
          args.mode === "accept-prompt-with"
            ? { mode: "accept-prompt-with", text: args.text ?? "" }
            : { mode: args.mode };
        if (next.mode === "accept-prompt-with" && args.text === undefined) {
          throw new Error('set_dialog_policy: mode "accept-prompt-with" requires `text`');
        }
        const resolved = e.dialog.set(next);
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: true, session: e.id, policy: resolved, tokensEstimate },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "set_permission_policy",
    {
      description:
        "Mutate the session's permission policy at runtime. Governs how page-side permission requests — `getUserMedia` (camera/microphone), `getCurrentPosition`/`watchPosition` (geolocation), `Notification.requestPermission`, `clipboard.read`/`write`, and the sensor permissions — are handled. Without a policy installed, requests either fire silently (Chromium auto-denies in headless) or — if a prior `grant_permissions` pre-granted — change app behavior under an unaware caller. Modes:\n" +
        '  - "allow"     — pre-grant via CDP `Browser.setPermission`; in-page wrappers call through. The app sees a granted permission.\n' +
        '  - "deny"      — pre-deny via CDP; in-page wrappers reject with `NotAllowedError`. The app sees a denied permission.\n' +
        '  - "raise"     — DEFAULT. Pre-deny + in-page wrappers reject AND RECORD; the next ActionResult flips `ok:false` with `failure:{source:"app", hint:"unhandled permission request — set permissionPolicy"}`. The page never deadlocks (the request is rejected), but a permission request can\'t silently change app state under a caller that didn\'t opt in.\n' +
        '  - "ask-human" — server blocks on `__browx.confirm(true|false)` (the `await_human({kind:"confirm"})` mechanism), then resolves to allow/deny per the human\'s answer.\n' +
        'Per-permission overrides (`perPermission: { camera: "allow", notifications: "deny", … }`) win over the top-level `mode`. Persists across navigation: the init-script is re-injected on every new document within the session. The initial policy is set at `open_session({permissionPolicy})`; this tool replaces it. Returns the resolved policy. Fired requests surface on `ActionResult.permissionRequests[]`. Supported permission names (v1): ' +
        SUPPORTED_PERMISSIONS.join(", ") +
        ". USB / Bluetooth / HID are out of scope for v1.\n" +
        'Sibling to `grant_permissions` — that tool remains as the bulk-grant shortcut for the `mode:"allow"` case; this tool is the full policy surface.',
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe("Top-level policy mode — see tool description."),
        perPermission: z
          .record(z.enum(["allow", "deny", "raise", "ask-human"]))
          .optional()
          .describe(
            "Per-permission overrides. Keys: one of the supported permission names (see tool description). Each value overrides the top-level `mode` for that permission. Unknown names are rejected.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_permission_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: PermissionPolicy = {
          mode: args.mode,
          ...(args.perPermission
            ? {
                perPermission: args.perPermission as Partial<
                  Record<SupportedPermission, "allow" | "deny" | "raise" | "ask-human">
                >,
              }
            : {}),
        };
        const resolved = e.permission.set(next);
        // Re-apply the CDP baseline so the new mapping is in effect for the
        // very next page-side check (the wrapper script reads policy live; CDP
        // baseline must also be refreshed so `navigator.permissions.query`
        // / native code paths see the new state).
        await applyPermissionCdpBaseline(e.session.page().context(), e.permission).catch(
          () => undefined,
        );
        const warnings: string[] = [];
        if (e.mode === "attached") warnings.push(BYOB_PERMISSION_WARNING);
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        const body: Record<string, unknown> = {
          ok: true,
          session: e.id,
          policy: resolved,
          tokensEstimate,
        };
        if (warnings.length) body.warnings = warnings;
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "set_fs_picker_policy",
    {
      description:
        "Mutate the session's File System Access picker policy at runtime. Governs how `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker` calls are handled. Without a policy installed, modern web editors deadlock on the picker dialog the headless session can't drive. Modes:\n" +
        '  - "allow"     — page-side stubs return synthetic FileSystem*Handle objects built from agent-supplied files (call `fs_picker_respond` BEFORE the action that triggers the picker, OR in parallel — the queue is drained per-API on the next matching call). For `showSaveFilePicker`, the agent supplies a workspace-rooted `path` and `createWritable()` writes from the page persist there. For `showOpenFilePicker`, the agent supplies inline `contents` (base64) or a workspace-rooted `path` (server inlines the bytes); the page reads via `getFile()`.\n' +
        '  - "deny"      — stubs throw `NotAllowedError`. The page sees the user-dismissed-picker branch.\n' +
        '  - "raise"     — DEFAULT. Stubs throw `NotAllowedError` AND RECORD; the next ActionResult flips `ok:false` with `failure:{source:"app", hint:"unhandled File System Access picker — set fsPickerPolicy"}`. The page never deadlocks (the picker rejects immediately), but a picker call can\'t silently change app state under a caller that didn\'t opt in.\n' +
        '  - "ask-human" — server blocks on `__browx.respond({kind:"fs_picker_respond", value:{files:[…]}})` (the `await_human` mechanism), then resolves with the human-approved file list or denies.\n' +
        'Per-API overrides (`perAPI: { showSaveFilePicker: "allow", showOpenFilePicker: "deny", … }`) win over the top-level `mode`. Persists across navigation: the init-script is re-injected on every new document within the session. The initial policy is set at `open_session({fsPickerPolicy})`; this tool replaces it. Returns the resolved policy. Fired pickers surface on `ActionResult.fsPickerRequests[]`. Supported APIs (v1): ' +
        SUPPORTED_FS_PICKER_APIS.join(", ") +
        ". Directory picker returns a minimal handle (`.name` set; iteration empty) — most editors will fall back to per-file pickers when iteration yields nothing.",
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe("Top-level policy mode — see tool description."),
        perAPI: z
          .record(z.enum(["allow", "deny", "raise", "ask-human"]))
          .optional()
          .describe(
            "Per-API overrides. Keys: one of " +
              SUPPORTED_FS_PICKER_APIS.join(", ") +
              ". Each value overrides the top-level `mode` for that picker. Unknown keys are rejected.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_fs_picker_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: FsPickerPolicy = {
          mode: args.mode,
          ...(args.perAPI
            ? {
                perAPI: args.perAPI as Partial<
                  Record<FsPickerApi, "allow" | "deny" | "raise" | "ask-human">
                >,
              }
            : {}),
        };
        const resolved = e.fsPicker.set(next);
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: true, session: e.id, policy: resolved, tokensEstimate },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "fs_picker_respond",
    {
      description:
        'Stage agent-supplied files for the next File System Access picker call on this session — paired with `set_fs_picker_policy({mode:"allow"})` (or a `perAPI` override). The queue is per-API: a response staged for `showSaveFilePicker` won\'t satisfy a `showOpenFilePicker` call. Each file is either inline `{contents, name?, mimeType?}` (base64 — no filesystem read) or workspace-rooted `{path}` (resolved inside `$BROWX_WORKSPACE` only; path escape rejected). For `showSaveFilePicker`, the supplied `path` becomes the destination for `createWritable()`-driven writes from the page — `write()` / `truncate()` / `close()` from the page-side stream are persisted there. For `showOpenFilePicker`, the server reads `path` once at respond-time and inlines the bytes (the page reads via `getFile()`). Capability `file-io` — same posture as `upload_file`. Returns `{ok, session, queued:{api, fileCount}, tokensEstimate}`.',
      inputSchema: {
        api: z
          .enum(SUPPORTED_FS_PICKER_APIS)
          .describe(
            "The picker API this response is for. Must match the call the page will make next.",
          ),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .optional()
                .describe(
                  "Workspace-rooted file path. Mutually exclusive with `contents`. For save-pickers: write destination. For open-pickers: source file bytes are inlined at respond-time. For directory-picker: basename becomes the handle's `.name`.",
                ),
              contents: z
                .string()
                .optional()
                .describe(
                  "base64 file content. Mutually exclusive with `path`. Open-picker only — for save-pickers the writable stream needs a destination path, not source bytes.",
                ),
              name: z
                .string()
                .optional()
                .describe(
                  'Filename presented to the page when `contents` is used. Default `"browxai-virtual"`. Ignored when `path` is used (basename of `path` is taken).',
                ),
              mimeType: z
                .string()
                .optional()
                .describe(
                  'MIME type for the synthetic `File` exposed to the page. Default `"application/octet-stream"`.',
                ),
            }),
          )
          .describe(
            "Files to hand back to the page. `showSaveFilePicker` consumes only the first entry; `showOpenFilePicker` consumes all (the page sees an Array<FileSystemFileHandle>); `showDirectoryPicker` consumes only the first entry and reads its basename as the directory `.name`.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("fs_picker_respond");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        for (const f of args.files as FsPickerFile[]) {
          if (f.path !== undefined && f.contents !== undefined) {
            throw new Error(
              "fs_picker_respond: each file must pass exactly one of `path` or `contents`",
            );
          }
          if (f.path === undefined && f.contents === undefined) {
            throw new Error("fs_picker_respond: each file must pass `path` or `contents`");
          }
          if (f.path !== undefined) {
            // Validate workspace-rooted; throws on escape. The actual file
            // I/O for save-picker writes happens later when the page calls
            // `createWritable()`; for open-picker the read happens at the
            // binding layer when the page calls `getFile()` (we inline at
            // respond-time below).
            resolveWorkspaceFsPath(workspace.root, f.path);
          }
        }
        // For open-pickers + showDirectoryPicker: when the agent supplied
        // `{path}` (no inline contents), read the file once now and inline
        // its bytes so the page-side `getFile()` resolves without another
        // server round-trip. Save-pickers keep `path` as the WRITE target
        // (no read).
        const api = args.api as FsPickerApi;
        const prepared: FsPickerFile[] = (args.files as FsPickerFile[]).map((f) => {
          if (api === "showSaveFilePicker") return f;
          if (f.path === undefined || f.contents !== undefined) return f;
          try {
            const resolved = resolveWorkspaceFsPath(workspace.root, f.path);
            const bytes = readFileSync(resolved);
            return {
              ...f,
              contents: bytes.toString("base64"),
              name: f.name ?? pathBasename(resolved),
            };
          } catch (err) {
            throw new Error(
              `fs_picker_respond: failed to read \`path\` ${JSON.stringify(f.path)} — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
        e.fsPicker.pushResponse(api, prepared);
        const body = {
          ok: true,
          session: e.id,
          queued: { api, fileCount: prepared.length },
          tokensEstimate: estimateTokens(JSON.stringify({ api, fileCount: prepared.length })),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "permission_state",
    {
      description:
        'Read the current permission state(s) for an origin via the W3C Permissions API (`navigator.permissions.query` — which reflects the CDP-applied baseline). Returns `{ [permission]: "granted" | "denied" | "prompt" | "unknown" }` per requested name. Defaults the `origin` to the current page\'s origin when omitted. Read-only — does not mutate state. Supported permission names (v1): ' +
        SUPPORTED_PERMISSIONS.join(", ") +
        ". Sibling of `set_permission_policy`.",
      inputSchema: {
        permissions: z
          .array(z.string())
          .min(1)
          .describe(
            'Canonical permission names to query — see tool description for the supported set. Unknown names map to `"unknown"` in the result.',
          ),
        origin: z
          .string()
          .optional()
          .describe(
            'Origin to query (e.g. "https://example.com"). Omit to use the current page\'s origin.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ permissions, origin, session }) => {
      const g = gateCheck("permission_state");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const supported = (permissions as string[]).filter((p): p is SupportedPermission =>
          (SUPPORTED_PERMISSIONS as readonly string[]).includes(p),
        );
        const states = await readPermissionStates(
          e.session.page().context(),
          e.session.page(),
          supported,
          origin,
        );
        const out: Record<string, string> = { ...states };
        for (const p of permissions) {
          if (!(p in out)) out[p] = "unknown";
        }
        const body = {
          ok: true,
          session: e.id,
          origin:
            origin ??
            (() => {
              try {
                return new URL(e.session.page().url()).origin;
              } catch {
                return null;
              }
            })(),
          states: out,
          tokensEstimate: estimateTokens(JSON.stringify(out)),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "set_notification_policy",
    {
      description:
        "Mutate the session's notification policy at runtime. Governs `new Notification(title, opts)` *constructor* calls — the page actually attempting to display a notification. Distinct from `set_permission_policy` (which gates `Notification.requestPermission` and the `Notification.permission` state); the two policies compose. Modes:\n" +
        '  - "allow"     — DEFAULT (browser default). Constructor proceeds; the OS displays per its own settings. Every call is still captured on `ActionResult.notifications[]` for observability.\n' +
        '  - "deny"      — Constructor throws `NotAllowedError` (the same exception the browser raises when permission is denied). Use to suppress OS notifications while still observing what the page would have shown.\n' +
        '  - "raise"     — Constructor throws AND RECORDS; the next ActionResult flips `ok:false` with `failure:{source:"app", hint:"unhandled notification — set notificationPolicy"}`. Useful when notifications should be a hard signal that the action triggered an unexpected user-facing event.\n' +
        '  - "ask-human" — server blocks on `__browx.confirm(true|false)` (the `await_human({kind:"confirm"})` mechanism), then resolves to allow/deny per the human\'s answer. The constructor returns a stub synchronously (the spec requires a sync return); the real OS notification fires once the human-decision resolves.\n' +
        "Persists across navigation: the init-script is re-injected on every new document within the session. Returns the resolved policy. Captured calls surface on `ActionResult.notifications[] = [{title, body?, icon?, tag?, timestamp, origin?, handledAs}]`.",
      inputSchema: {
        mode: z
          .enum(["allow", "deny", "raise", "ask-human"])
          .describe("Policy mode — see tool description."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("set_notification_policy");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const next: NotificationPolicy = { mode: args.mode };
        const resolved = e.notification.set(next);
        // Push the new sync-decision hint to every live page so the
        // constructor's throw timing tracks the policy without a reload.
        await propagateNotificationSyncDecision(e.session.page().context(), e.notification).catch(
          () => undefined,
        );
        const tokensEstimate = estimateTokens(JSON.stringify(resolved));
        const body = { ok: true, session: e.id, policy: resolved, tokensEstimate };
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---------- Web Bluetooth / WebUSB / WebHID device emulation
  // (capability `device-emulation`) ----------
  //
  // Three sibling mutators (`emulate_bluetooth` / `emulate_usb` / `emulate_hid`)
  // plus a read-side companion (`device_requests`). All four gate behind the
  // off-by-default `device-emulation` capability — same posture class as
  // `eval` / `network-body` / `secrets` / `extensions` / `stealth` / `captcha`.
  // The page-side init-script wrappers install eagerly at session creation
  // (so a page that calls `requestDevice()` on initial document parse never
  // hangs); the check binding short-circuits to `refused` when the capability
  // is off, so a server without `device-emulation` still surfaces "page
  // asked but capability was off" on `device_requests`.
  //
  // Shared input schema — the SyntheticDevice union (every field optional;
  // wrappers default missing fields to deterministic placeholders so the
  // page sees a complete shape). A single shape covers all three APIs;
  // each wrapper picks the fields its spec exposes.
  const SYNTHETIC_DEVICE_SCHEMA = z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Display name. Bluetooth: `.name`; USB: `.productName`; HID: `.productName`. Default `"browxai-virtual"`.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Bluetooth: stable device id (UUID-style string). Default `"browxai-<api>-<index>"`.',
      ),
    vendorId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB / HID: 16-bit USB-IF vendor id. Default `0x0000`."),
    productId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB / HID: 16-bit product id. Default `0x0000`."),
    manufacturerName: z
      .string()
      .optional()
      .describe('USB: human-readable manufacturer string. Default `"browxai virtual"`.'),
    serialNumber: z
      .string()
      .optional()
      .describe('USB: serial number string. Default `"BROWX-VIRTUAL"`.'),
    deviceClass: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device class. Default `0xFF` (vendor-specific)."),
    deviceSubclass: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device subclass. Default `0x00`."),
    deviceProtocol: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device protocol. Default `0x00`."),
    services: z
      .array(z.string())
      .optional()
      .describe(
        "Bluetooth: GATT primary service UUIDs the device advertises. Surfaced on the synthetic device as `device.uuids`. v1 does NOT emulate GATT service exchange — `gatt.getPrimaryService()` rejects.",
      ),
    collections: z
      .array(z.unknown())
      .optional()
      .describe(
        "HID: report-descriptor collection topology exposed on `device.collections`. Pass-through — the page sees whatever shape you supplied.",
      ),
  });

  const registerEmulateApi = (toolName: string, api: DeviceApi, hint: string): void => {
    register(
      toolName,
      {
        description:
          `Stage a synthetic ${api === "bluetooth" ? "Web Bluetooth" : api === "usb" ? "WebUSB" : "WebHID"} device catalog for this session. The page-side wrapper around \`navigator.${api}.requestDevice()\` resolves with the agent-supplied device(s) the next time the page calls it. ${hint} ` +
          `Pass \`{devices: [...]}\` to install a non-empty catalog (the next requestDevice call ${api === "hid" ? "resolves with the matching device list" : "resolves with the first matching device"}); pass \`{devices: []}\` or omit \`devices\` to clear the catalog (the next call ${api === "hid" ? "resolves with `[]` — the user-dismissed shape for HID" : "rejects with `NotFoundError` — the user-dismissed shape for the picker"}). Persists across navigation: the init-script is re-injected on every new document within the session. Captured page-side calls surface on \`device_requests({session})\`. ` +
          `**Gated behind the off-by-default \`device-emulation\` capability** — the wrappers tell the page it found physical devices that don't exist, a posture-broadening change distinct from the surrounding policies. v1 covers the picker-clear path only — ${api === "bluetooth" ? "GATT service exchange (`getPrimaryService()`) rejects" : api === "usb" ? "transfer endpoints (`transferIn`/`transferOut`) resolve with zero-byte results" : "input/output reports (`oninputreport`, `sendReport()`) are stubs"}. Same posture class as \`eval\` / \`network-body\` / \`secrets\` / \`extensions\` / \`stealth\` / \`captcha\` — see docs/threat-model.md. Returns \`{ok, session, api, catalog:{devices:[…]}, warnings?, tokensEstimate}\`.`,
        inputSchema: {
          devices: z
            .array(SYNTHETIC_DEVICE_SCHEMA)
            .optional()
            .describe(
              `Synthetic devices to expose. Omit or pass \`[]\` to clear the catalog. ${api === "hid" ? "All entries are returned to the page on every requestDevice() call." : "Only the first entry is returned to the page on requestDevice() (Bluetooth/USB pickers are single-result)."}`,
            ),
          ...SESSION_ARG,
        },
      },
      async (args) => {
        const g = gateCheck(toolName);
        if (g) return g;
        const e = await entryFor(args.session);
        try {
          const devices = (args.devices as SyntheticDevice[] | undefined) ?? [];
          const catalog = e.webDeviceEmulation.set(api, devices);
          const warnings: string[] = [];
          if (e.mode === "attached") warnings.push(BYOB_DEVICE_EMU_WARNING);
          const body: Record<string, unknown> = {
            ok: true,
            session: e.id,
            api,
            catalog,
          };
          if (warnings.length) body.warnings = warnings;
          body.tokensEstimate = estimateTokens(JSON.stringify(body));
          return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ok: false, error: err instanceof Error ? err.message : String(err) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  };

  registerEmulateApi(
    "emulate_bluetooth",
    "bluetooth",
    "The synthetic `BluetoothDevice` carries `{id, name, uuids, gatt}`; `gatt.connect()` resolves with a stub server whose `getPrimaryService()` rejects (no GATT emulation in v1) — enough for pages that gate flow on the picker-clear, not enough for pages that go on to exchange characteristic data.",
  );
  registerEmulateApi(
    "emulate_usb",
    "usb",
    "The synthetic `USBDevice` carries vendor/product/class/manufacturer/serial fields; `open()` / `selectConfiguration()` / `claimInterface()` resolve; transfer endpoints (`transferIn` / `transferOut` / `controlTransferIn` / `controlTransferOut`) resolve with zero-byte payloads (no synthetic data flow).",
  );
  registerEmulateApi(
    "emulate_hid",
    "hid",
    "The synthetic `HIDDevice` carries vendor/product/productName/collections; `open()` / `sendReport()` / `sendFeatureReport()` resolve; `receiveFeatureReport()` resolves with an empty DataView; `oninputreport` is never fired (no synthetic device traffic).",
  );

  register(
    "device_requests",
    {
      description:
        'Read-side companion to `emulate_bluetooth` / `emulate_usb` / `emulate_hid`. Returns the buffer of `requestDevice()` calls the page has made on this session — one entry per page-side call, each with `{api, handledAs, returned, filters?, ts}`. Useful for diagnosing "did the page even ask?" when a flow gated on hardware appears stuck. `handledAs`:\n' +
        '  - `"resolved"`  — catalog non-empty; picker resolved with the synthetic device (Bluetooth/USB) or device list (HID).\n' +
        '  - `"rejected"` — catalog empty for Bluetooth/USB; picker rejected with `NotFoundError` (user-dismissed shape).\n' +
        '  - `"empty"`    — catalog empty for HID; picker resolved with `[]` (HID\'s user-dismissed shape).\n' +
        '  - `"refused"`  — capability `device-emulation` was OFF at the time of the call; the wrapper short-circuited. Recorded so the read surfaces "the page asked for hardware and you didn\'t have the capability on".\n' +
        "**Gated behind the off-by-default `device-emulation` capability** — a server without the capability can't even read whether the page tried to ask (same posture class as `eval` / `network-body` / `secrets`). Read-only — does not mutate state.",
      inputSchema: {
        since: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "epoch ms — return only records with `ts >= since`. Default 0 (return everything in the buffer).",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ since, session }) => {
      const g = gateCheck("device_requests");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const records = e.webDeviceEmulation.since(typeof since === "number" ? since : 0);
        const body: Record<string, unknown> = {
          ok: true,
          session: e.id,
          supportedApis: [...SUPPORTED_DEVICE_APIS],
          requests: records,
        };
        body.tokensEstimate = estimateTokens(JSON.stringify(body));
        return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---------- Per-primitive device emulation ----------
  //
  // Seven sibling tools (deliberately NOT a bundled `emulate({…})`) — each
  // mutates ONE Playwright/CDP knob on the live session: `set_locale`,
  // `set_timezone`, `set_geolocation`, `set_color_scheme`, `set_reduced_motion`,
  // `set_user_agent`, `grant_permissions`. State persists on the SessionEntry
  // so new pages within the same context re-apply automatically. CONTEXT-
  // time-only Playwright settings (locale, timezone, UA) are routed through
  // their CDP equivalents (`Emulation.setLocaleOverride`,
  // `Emulation.setTimezoneOverride`, `Network.setUserAgentOverride`) — those
  // DO take effect mid-session. The other four use Playwright's stable
  // mutators. BYOB / attached sessions surface a warning that overrides
  // applied via CDP outlive browxai's detach.

  /** Wrap an emulation-tool result with the standard envelope (`ok`, `applied`,
   *  `state` snapshot, `tokensEstimate`, plus BYOB warning when applicable). */
  const emulationResult = (
    e: SessionEntry,
    applied: Record<string, unknown>,
    extra: { warnings?: string[]; note?: string } = {},
  ): { content: Array<{ type: "text"; text: string }> } => {
    const warnings: string[] = [...(extra.warnings ?? [])];
    if (e.mode === "attached") warnings.push(BYOB_EMULATION_WARNING);
    const body: Record<string, unknown> = {
      ok: true,
      session: e.id,
      applied,
      state: {
        locale: e.deviceEmulation.locale ?? null,
        timezoneId: e.deviceEmulation.timezoneId ?? null,
        geolocation: e.deviceEmulation.geolocation ?? null,
        colorScheme: e.deviceEmulation.colorScheme ?? null,
        reducedMotion: e.deviceEmulation.reducedMotion ?? null,
        userAgent: e.deviceEmulation.userAgent ?? null,
        permissions: Object.fromEntries(e.deviceEmulation.permissions),
      },
    };
    if (warnings.length) body.warnings = warnings;
    if (extra.note) body.note = extra.note;
    body.tokensEstimate = estimateTokens(JSON.stringify(body));
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  };

  /** Standard emulation failure envelope. */
  const emulationError = (toolName: string, err: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            action: { type: toolName },
            error: err instanceof Error ? err.message : String(err),
            tokensEstimate: 0,
          },
          null,
          2,
        ),
      },
    ],
  });

  /** Render an EmulationSubstrate refusal as the standard failure envelope (the
   *  Safari adapter has no live surface for the knob). Carries the adapter's
   *  `hint` so the agent knows where the override IS available. */
  const emulationRefusal = (toolName: string, refusal: EmulationResult & { kind: "refusal" }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            action: { type: toolName },
            error: refusal.error,
            ...(refusal.hint ? { hint: refusal.hint } : {}),
            tokensEstimate: 0,
          },
          null,
          2,
        ),
      },
    ],
  });

  register(
    "set_locale",
    {
      description:
        "Override the session's browser locale (`navigator.language`, `Intl.*` defaults, `Accept-Language` header). Persists across navigation + new tabs in the same session. Pass `locale: null` to clear the override and restore the browser default. NOTE: Playwright's `BrowserContext.locale` is creation-time-only, so this primitive is implemented via CDP `Emulation.setLocaleOverride` — which DOES take effect mid-session on existing pages. BYOB caveat: the CDP override persists on the attached Chrome until it navigates/restarts after detach.",
      inputSchema: {
        locale: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            'BCP-47 locale tag, e.g. "en-US", "de-DE", "ja-JP". Pass null (or omit) to clear the override and restore the browser default.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ locale, session }) => {
      const g = gateCheck("set_locale");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("set_locale", e);
      if (eg) return eg;
      try {
        if (locale === null || locale === undefined) {
          await clearLocaleCdp(requireCdp(e.session));
          e.deviceEmulation.locale = undefined;
          return emulationResult(e, { locale: null });
        }
        await applyLocaleCdp(requireCdp(e.session), locale);
        e.deviceEmulation.locale = locale;
        return emulationResult(e, { locale });
      } catch (err) {
        return emulationError("set_locale", err);
      }
    },
  );

  register(
    "set_timezone",
    {
      description:
        "Override the session's IANA timezone for `Date`, `Intl.DateTimeFormat`, etc. Persists across navigation + new tabs. Pass `timezoneId: null` to clear. NOTE: Playwright's `BrowserContext.timezoneId` is creation-time-only, so this primitive uses CDP `Emulation.setTimezoneOverride` (mid-session-capable). BYOB caveat: the CDP override persists on attached Chrome after detach.",
      inputSchema: {
        timezoneId: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            'IANA timezone, e.g. "America/New_York", "Europe/London", "Asia/Tokyo". Pass null (or omit) to clear.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ timezoneId, session }) => {
      const g = gateCheck("set_timezone");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("set_timezone", e);
      if (eg) return eg;
      try {
        if (timezoneId === null || timezoneId === undefined) {
          await clearTimezoneCdp(requireCdp(e.session));
          e.deviceEmulation.timezoneId = undefined;
          return emulationResult(e, { timezoneId: null });
        }
        await applyTimezoneCdp(requireCdp(e.session), timezoneId);
        e.deviceEmulation.timezoneId = timezoneId;
        return emulationResult(e, { timezoneId });
      } catch (err) {
        return emulationError("set_timezone", err);
      }
    },
  );

  register(
    "set_geolocation",
    {
      description:
        "Override the session's HTML5 Geolocation reading. The page MUST also be granted the `geolocation` permission via `grant_permissions` for `navigator.geolocation.*` to deliver this value (browsers gate it). Uses Playwright's `context.setGeolocation()` which mutates a live context — no CDP fallback needed. Pass no coords (or `latitude:null`) to clear.",
      inputSchema: {
        latitude: z
          .union([z.number(), z.null()])
          .optional()
          .describe("Latitude in degrees [-90, 90]. Pass null (or omit) to clear the override."),
        longitude: z.number().optional().describe("Longitude in degrees [-180, 180]."),
        accuracy: z
          .number()
          .nonnegative()
          .optional()
          .describe("Accuracy radius in metres. Default 0."),
        ...SESSION_ARG,
      },
    },
    async ({ latitude, longitude, accuracy, session }) => {
      const g = gateCheck("set_geolocation");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const isClear = latitude === null || latitude === undefined;
        if (isClear) {
          const r = await emulationFor(e).setGeolocation(null);
          if (r.kind === "refusal") return emulationRefusal("set_geolocation", r);
          e.deviceEmulation.geolocation = undefined;
          return emulationResult(e, { geolocation: null });
        }
        if (longitude === undefined) {
          return emulationError(
            "set_geolocation",
            new Error("longitude is required when latitude is set"),
          );
        }
        const coords = { latitude, longitude, accuracy };
        const r = await emulationFor(e).setGeolocation(coords);
        if (r.kind === "refusal") return emulationRefusal("set_geolocation", r);
        e.deviceEmulation.geolocation = coords;
        const warnings: string[] = [];
        const grantedHere = e.deviceEmulation.permissions.get("") ?? [];
        const grantedAll = [...e.deviceEmulation.permissions.values()].flat();
        if (![...grantedHere, ...grantedAll].includes("geolocation")) {
          warnings.push(
            'set_geolocation: pages need the `geolocation` permission for navigator.geolocation to deliver this — call grant_permissions({ permissions: ["geolocation"] }) for the relevant origin.',
          );
        }
        return emulationResult(e, { geolocation: coords }, { warnings });
      } catch (err) {
        return emulationError("set_geolocation", err);
      }
    },
  );

  register(
    "set_color_scheme",
    {
      description:
        "Override the session's `prefers-color-scheme` media query — drives dark-mode rendering. Mutates a live page via Playwright's `page.emulateMedia({colorScheme})`; takes effect immediately (CSS media queries re-evaluate). Pass `\"no-preference\"` to clear the override.",
      inputSchema: {
        scheme: z
          .enum(["light", "dark", "no-preference"])
          .describe(
            "`light` / `dark` force the scheme; `no-preference` clears the override and restores the system default.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ scheme, session }) => {
      const g = gateCheck("set_color_scheme");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const r = await emulationFor(e).setColorScheme(scheme as ColorScheme);
        if (r.kind === "refusal") return emulationRefusal("set_color_scheme", r);
        e.deviceEmulation.colorScheme =
          scheme === "no-preference" ? undefined : (scheme as ColorScheme);
        return emulationResult(e, { colorScheme: scheme });
      } catch (err) {
        return emulationError("set_color_scheme", err);
      }
    },
  );

  register(
    "set_reduced_motion",
    {
      description:
        "Override the session's `prefers-reduced-motion` media query — useful when an animation-heavy page is unstable to drive, or to verify a reduced-motion code path. Mutates a live page via Playwright's `page.emulateMedia({reducedMotion})`. Pass `on:false` to clear.",
      inputSchema: {
        on: z.boolean().describe("true → `reduce`; false → `no-preference` (clears the override)."),
        ...SESSION_ARG,
      },
    },
    async ({ on, session }) => {
      const g = gateCheck("set_reduced_motion");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const motion: ReducedMotion = on ? "reduce" : "no-preference";
        const r = await emulationFor(e).setReducedMotion(motion);
        if (r.kind === "refusal") return emulationRefusal("set_reduced_motion", r);
        e.deviceEmulation.reducedMotion = on ? "reduce" : undefined;
        return emulationResult(e, { reducedMotion: motion });
      } catch (err) {
        return emulationError("set_reduced_motion", err);
      }
    },
  );

  register(
    "set_user_agent",
    {
      description:
        "Override the session's User-Agent (HTTP header + `navigator.userAgent`). Persists across navigation + new tabs. Pass `userAgent: null` to clear. NOTE: Playwright's `BrowserContext.userAgent` is creation-time-only, so this primitive uses CDP `Network.setUserAgentOverride` (mid-session-capable; updates both the network header and the JS-visible value). BYOB caveat: the CDP override persists on attached Chrome after detach.",
      inputSchema: {
        userAgent: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            "Full User-Agent string. Pass null (or omit) to clear and restore the browser default.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ userAgent, session }) => {
      const g = gateCheck("set_user_agent");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("set_user_agent", e);
      if (eg) return eg;
      try {
        if (userAgent === null || userAgent === undefined) {
          await clearUserAgentCdp(requireCdp(e.session));
          e.deviceEmulation.userAgent = undefined;
          return emulationResult(e, { userAgent: null });
        }
        await applyUserAgentCdp(requireCdp(e.session), userAgent);
        e.deviceEmulation.userAgent = userAgent;
        return emulationResult(e, { userAgent });
      } catch (err) {
        return emulationError("set_user_agent", err);
      }
    },
  );

  register(
    "grant_permissions",
    {
      description:
        "Grant browser permissions for the session — `geolocation`, `notifications`, `clipboard-read`, `clipboard-write`, `camera`, `microphone`, `midi`, `background-sync`, `accelerometer`, `gyroscope`, `magnetometer`, `ambient-light-sensor`, `payment-handler`, etc. (Chromium permission names). Mutates a live context via Playwright `context.grantPermissions`. Optionally scope to a specific `origin`; otherwise grants for the current page's origin. Pass `permissions: []` (or omit) to clear all grants for the session — Playwright does not expose per-origin revocation, so clearing is context-wide.",
      inputSchema: {
        permissions: z
          .array(z.string())
          .optional()
          .describe(
            "List of Chromium permission names. Pass empty array (or omit) to clear ALL grants (context-wide; per-origin revocation isn't supported by the underlying platform).",
          ),
        origin: z
          .string()
          .optional()
          .describe(
            'Origin to scope the grant to (e.g. "https://example.com"). Omit to use the current page\'s origin.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ permissions, origin, session }) => {
      const g = gateCheck("grant_permissions");
      if (g) return g;
      const e = await entryFor(session);
      try {
        if (!permissions || permissions.length === 0) {
          const hadOrigin = origin !== undefined;
          await clearPermissions(e.session.page().context(), e.deviceEmulation, origin);
          const note = hadOrigin
            ? "Per-origin permission revocation isn't supported by Playwright; cleared ALL grants for the session context."
            : "Cleared ALL permission grants for the session context.";
          return emulationResult(e, { permissions: [], origin: origin ?? null }, { note });
        }
        await applyPermissions(e.session.page().context(), e.deviceEmulation, permissions, origin);
        return emulationResult(e, { permissions, origin: origin ?? null });
      } catch (err) {
        return emulationError("grant_permissions", err);
      }
    },
  );

  register(
    "tab_visibility",
    {
      description:
        'Background or foreground the session\'s tab — the only way to reproduce the bug class that only fires when the tab is hidden (throttled setTimeout, paused requestAnimationFrame so framework enter/animation hooks never run, and on-return a visibilitychange/focus handler replays stale state). `state:"background"` overrides document.visibilityState/hidden + dispatches visibilitychange, AND best-effort takes front focus away from the page so real timer/rAF throttling applies (real throttling is best-effort under headless). `state:"background"` with `holdMs` is the headline form: background, hold hidden for holdMs, then auto-foreground — reproducing the background→return transition in one call. `state:"foreground"` restores visibility and re-focuses the tab.',
      inputSchema: {
        state: z
          .enum(["background", "foreground"])
          .describe("background = hide/deprioritise the tab; foreground = restore + re-focus."),
        holdMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe(
            "background only: hold hidden this long (ms), then auto-foreground. Cap 120000.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ state, holdMs, session }) => {
      const g = gateCheck("tab_visibility");
      if (g) return g;
      const e = await entryFor(session);
      const result = await setTabVisibility(
        e.session.page(),
        e.session.page().context(),
        state,
        holdMs,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ---------- config store ----------

  const CONFIG_PATCH_SCHEMA = {
    testAttributes: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    confirmRequired: z.array(z.string()).optional(),
    allowedOrigins: z.array(z.string()).optional(),
    blockedOrigins: z.array(z.string()).optional(),
    headless: z.boolean().optional(),
    actionTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    disableWebSecurity: z.boolean().optional(),
    defaultDevice: z.string().optional(),
    defaultViewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .optional(),
    hideOverlaySelectors: z.array(z.string()).optional(),
    plugins: z.array(z.string()).optional(),
    unstable: z.record(z.unknown()).optional(),
  };

  register(
    "get_config",
    {
      description:
        "Inspect browxai configuration. Default returns the fully *resolved* view (precedence: built-in defaults < env [legacy BROWX_*] < user < project < session). Pass `scope` to see one raw pre-merge layer. Config is browxai-managed — change it with `set_config`, never by hand-editing files or env.",
      inputSchema: {
        scope: z
          .enum(["defaults", "env", "user", "project", "session", "resolved"])
          .optional()
          .describe("Which layer to show. Omit or 'resolved' for the merged view."),
      },
    },
    async ({ scope }) => {
      let body: Record<string, unknown>;
      if (!scope || scope === "resolved") {
        const resolved = configStore.resolve();
        // `capabilities` in the resolved view is the LIVE enforced set — what
        // tool gating actually uses — not the freshly re-resolved config.
        // Those diverge after a `set_config({capabilities})` until a restart;
        // reporting the re-resolved value here would lie to the agent.
        const live = [...caps.enabled].sort();
        const persisted = [...resolved.capabilities].sort();
        // the LIVE enabled plugin set is whatever the runtime
        // loaded at server start (status === "loaded"). Persisted plugins
        // come from the resolved config layer. They diverge after a
        // `set_config({plugins})` until a restart — same posture as
        // capabilities.
        const livePlugins = pluginRecords
          .filter((p) => p.status === "loaded")
          .map((p) => p.manifest.name)
          .sort();
        const persistedPlugins = [...resolved.plugins].sort();
        body = {
          scope: "resolved",
          config: { ...resolved, capabilities: live, plugins: livePlugins },
        };
        if (live.join(",") !== persisted.join(",")) {
          body.capabilitiesPendingRestart = {
            active: live,
            persisted,
            note: "`capabilities` was changed via set_config (or env) but is resolved ONCE at server start — the difference takes effect only after a browxai server RESTART. Tool gating enforces `active`.",
          };
        }
        if (livePlugins.join(",") !== persistedPlugins.join(",")) {
          body.pluginsPendingRestart = {
            active: livePlugins,
            persisted: persistedPlugins,
            note: "`plugins` was changed via set_config but is resolved ONCE at server start — the difference takes effect only after a browxai server RESTART. Plugin tool registration enforces `active`.",
          };
        }
      } else {
        body = { scope, config: configStore.getLayer(scope as ConfigScope) };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "set_config",
    {
      description:
        "Persist a config patch into the `user` or `project` layer of the browxai-managed config store (`<workspace>/config.json`). This is the ONLY supported way to set persistent config — no env vars, no hand-edited files. Arrays replace; `unstable.*` shallow-merges. Takes effect for sessions opened after this call (the default session re-resolves lazily). Refuses defaults/env/session scopes.",
      inputSchema: {
        scope: z.enum(["user", "project"]).describe("Which persistent layer to write."),
        patch: z
          .object(CONFIG_PATCH_SCHEMA)
          .describe("Partial config — only the keys you want to override."),
      },
    },
    async ({ scope, patch }) => {
      configStore.setLayer(scope as PersistentScope, patch);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { ok: true, scope, written: Object.keys(patch), resolved: configStore.resolve() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  register(
    "reset_config",
    {
      description:
        "Clear a persistent config layer (`user` or `project`) entirely. The built-in defaults + env layer remain.",
      inputSchema: { scope: z.enum(["user", "project"]).describe("Persistent layer to clear.") },
    },
    async ({ scope }) => {
      configStore.resetLayer(scope as PersistentScope);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { ok: true, cleared: scope, resolved: configStore.resolve() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ---------- session pre-approvals ----------

  register(
    "approve_actions",
    {
      description:
        'session-scoped pre-approval for one or more confirm-required scopes. Lets a non-Claude MCP client run without a human at DevTools to issue page-side `__browx.confirm(true)`. The client calls this once at session start with the scopes to pre-approve (e.g. `["byob_action"]`) and an optional TTL; confirm hooks for those scopes auto-approve within the window. Each grant + consume is logged for audit. Falls back to page-side confirm when no grant covers the scope. Pre-approval is **not** a security boundary — it\'s an unblock for headless flows; tighten by capping `ttlSeconds` per-session.',
      inputSchema: {
        scopes: z
          .array(z.enum(["navigate_off_allowlist", "byob_action", "file_download", "file_upload"]))
          .min(1)
          .describe("Confirm scope names to grant. Same vocabulary as BROWX_CONFIRM_REQUIRED."),
        ttlSeconds: z
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60)
          .optional()
          .describe(
            "Lifetime of the grant in seconds. Default 3600 (1 hour). Hard cap 86400 (24h).",
          ),
      },
    },
    async ({ scopes, ttlSeconds }) => {
      const ttl = ttlSeconds ?? 3600;
      for (const scope of scopes) approvals.grant(scope, ttl);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                granted: scopes,
                ttlSeconds: ttl,
                expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
                note: "Each call into a granted scope is logged. Subsequent approve_actions calls for the same scope reset the TTL.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  register(
    "list_approvals",
    {
      description:
        "List live pre-approvals from `approve_actions` — scope, grantedAt, expiresAt, uses, remainingMs. Audit helper.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ approvals: approvals.list() }, null, 2),
        },
      ],
    }),
  );

  // ---------- secrets registry (capability `secrets`) ----------

  register(
    "register_secret",
    {
      description:
        'Register a sensitive value the agent will use without ever seeing the real string in any tool result. **Gated behind the off-by-default `secrets` capability** — same posture class as `eval` / `network-body` / `disableWebSecurity`. Pair: the agent calls `fill({value:"<NAME>"})` / `press({key:"<NAME>"})` and the runtime substitutes the registered real value AT dispatch (so the page receives the actual string), while EVERY egress sink — `ActionResult.network`, `network_read`, `network_body`, `ws_read`, `console_read`, `snapshot`, `find` evidence — strips occurrences of the real value back to `<NAME>` before returning to the agent. `name` must match `/^[A-Z][A-Z0-9_]*$/` (uppercase identifier — the `<NAME>` mask is the stable contract). Optional `scope` (URL substring, case-insensitive) narrows the *dispatch* side: a scoped secret won\'t be substituted into a `fill` whose page URL doesn\'t contain the scope (refuses with a clear error). Per-session registry, capped at 32 entries. `screenshot` is a PARTIAL sink: when the page\'s text content contains a registered value, a warning is appended; pixel-level redaction (region-blur) is deferred — call snapshot/find for verified-clean evidence instead. NEVER re-emits or logs the real value.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'Agent-facing alias, e.g. "PASSWORD" / "OTP" / "SESSION_TOKEN". Uppercase identifier — `<NAME>` mask format.',
          ),
        value: z
          .string()
          .describe(
            "The real secret value. Stored per-session in memory only; never persisted, never logged.",
          ),
        scope: z
          .string()
          .optional()
          .describe(
            "Optional URL substring (case-insensitive). When set, dispatch-side substitution refuses if the current page URL doesn't contain the scope (prevents cross-origin leak). Egress masking is global regardless.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({
      name,
      value,
      scope,
      session,
    }: {
      name: string;
      value: string;
      scope?: string;
      session?: string;
    }) => {
      const g = gateCheck("register_secret");
      if (g) return g;
      const e = await entryFor(session);
      try {
        e.secrets.register({ name, value, ...(scope ? { scope } : {}) });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
      const body = {
        ok: true,
        registered: name,
        scope: scope ?? null,
        // never echo the value back. Echo only the registered names — useful
        // for the agent to confirm what aliases are live without leaking.
        names: e.secrets.names(),
        tokensEstimate: estimateTokens(
          JSON.stringify({ ok: true, registered: name, scope, names: e.secrets.names() }),
        ),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---------- captcha solver delegation (capability `captcha`) ----------
  //
  // `solve_captcha` is a delegation seam — it POSTs the captcha challenge to a
  // provider configured per-deployment via environment variables
  // (BROWX_CAPTCHA_PROVIDER + BROWX_CAPTCHA_API_KEY, optional
  // BROWX_CAPTCHA_API_BASE / BROWX_CAPTCHA_TIMEOUT_MS / BROWX_CAPTCHA_POLL_MS).
  // browxai does NOT bundle a solver and does NOT auto-purchase credits — when
  // the capability is on but no provider is configured the tool returns a
  // structured failure with a clear "no provider configured" hint. Loud-warned
  // at boot (see the `captcha` warning above). Targets the 2Captcha-
  // compatible HTTP API for v0.2.0 (`/in.php` submit + `/res.php` poll);
  // CapMonster Cloud mirrors the same shape. Other providers can be added by
  // extending src/page/solve-captcha.ts.

  register(
    "solve_captcha",
    {
      description:
        "Delegate a captcha challenge to a configured external provider (2Captcha / CapMonster / etc — provider speaks the 2Captcha-compatible REST API). **Gated behind the off-by-default `captcha` capability** — same posture class as `eval` / `network-body` / `secrets` / `extensions` / `stealth`. SOLVING CAPTCHAS MAY VIOLATE THE TARGET SITE'S TERMS OF SERVICE; the operator carries the legal exposure. " +
        "Provider config is per-deployment via environment variables: BROWX_CAPTCHA_PROVIDER (`2captcha` or `capmonster`) + BROWX_CAPTCHA_API_KEY; optional BROWX_CAPTCHA_API_BASE / BROWX_CAPTCHA_TIMEOUT_MS / BROWX_CAPTCHA_POLL_MS. **browxai does NOT bundle a solver and does NOT auto-purchase credits** — when the capability is on but no provider is configured the tool returns a structured `ok:false` with a clear `no provider configured` hint. " +
        "For widget captchas (`recaptcha2`, `recaptcha3`, `hcaptcha`, `turnstile`), supply the page's site-key via `siteKey` OR `selector` (when given, the server reads `data-sitekey` from the selected element on the current page). For `image`, supply `imageBase64` (raw base64, no data URL prefix). Returns `{ok, provider, solution, taskId, elapsedMs}` on success — the agent then types `solution` into the hidden form field / invokes the page's recaptcha callback. We do NOT auto-submit the solution; how to wire it into the page is per-site.",
      inputSchema: {
        type: z
          .enum(["recaptcha2", "recaptcha3", "hcaptcha", "turnstile", "image"])
          .describe(
            "Captcha kind. `recaptcha2` = checkbox or invisible v2; `recaptcha3` = score-based v3; `hcaptcha` = hCaptcha widget; `turnstile` = Cloudflare Turnstile; `image` = base64 image upload (caller provides `imageBase64`).",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for the captcha widget element on the current page. When given, the server reads `data-sitekey` (or equivalent) from the element to populate `siteKey`. Either `selector` or `siteKey` is required for widget captchas.",
          ),
        siteKey: z
          .string()
          .optional()
          .describe(
            "Explicit site-key for the captcha widget (alternative to `selector`). Required for widget captchas when `selector` is not given.",
          ),
        imageBase64: z
          .string()
          .optional()
          .describe(
            "Raw base64-encoded image bytes (no `data:image/...;base64,` prefix). Required for `image` type; ignored for widget types.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({
      type,
      selector,
      siteKey,
      imageBase64,
      session,
    }: {
      type: CaptchaType;
      selector?: string;
      siteKey?: string;
      imageBase64?: string;
      session?: string;
    }) => {
      const g = gateCheck("solve_captcha");
      if (g) return g;
      // Resolve provider config fresh per call so an operator can rotate
      // creds via env without restarting the server (env is the source of
      // truth — set_config doesn't override; secrets shouldn't live in the
      // config store).
      const cfg = resolveCaptchaProvider(process.env);
      if (!cfg.ok) {
        if (cfg.reason === "unconfigured") {
          const body = unconfiguredFailure();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const body = {
          ok: false,
          provider: null,
          error: cfg.error ?? "captcha provider config is incomplete",
          hint: "Set BROWX_CAPTCHA_PROVIDER and BROWX_CAPTCHA_API_KEY together. browxai does NOT bundle a solver and does NOT auto-purchase credits.",
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
      const e = await entryFor(session);
      let pageUrl: string;
      try {
        pageUrl = e.session.page().url();
      } catch {
        const body = {
          ok: false,
          provider: cfg.config.provider,
          error: "session has no active page",
          hint: "Call open_session + navigate first.",
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
      // Resolve siteKey: explicit > selector-derived. For `image` neither is
      // needed (imageBase64 is the payload).
      let resolvedSiteKey = siteKey;
      if (!resolvedSiteKey && selector && type !== "image") {
        try {
          const handle = await e.session.page().$(selector);
          if (handle) {
            // Read `data-sitekey` first (recaptcha/hcaptcha/turnstile
            // convention); fall back to a few common alternatives.
            resolvedSiteKey =
              (await handle.getAttribute("data-sitekey")) ??
              (await handle.getAttribute("data-site-key")) ??
              (await handle.getAttribute("sitekey")) ??
              undefined;
            await handle.dispose().catch(() => undefined);
          }
        } catch {
          /* fall through — explicit failure below if still no key */
        }
        if (!resolvedSiteKey) {
          const body = {
            ok: false,
            provider: cfg.config.provider,
            error: `solve_captcha: could not read a site-key attribute from selector "${selector}"`,
            hint: "Pass `siteKey` explicitly, or pass a `selector` that points at an element carrying `data-sitekey` (the standard reCAPTCHA / hCaptcha / Turnstile widget attribute).",
          };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }
      const result = await submitToProvider(
        {
          type,
          pageUrl,
          ...(resolvedSiteKey ? { siteKey: resolvedSiteKey } : {}),
          ...(imageBase64 ? { imageBase64 } : {}),
        },
        cfg.config,
      );
      // Mask the solution through the per-session secrets registry so a
      // solver-issued token containing a registered value (unlikely but
      // defensible) doesn't bypass the egress layer.
      const masked = e.secrets.applyMaskDeep(result);
      const body = { ...masked, tokensEstimate: estimateTokens(JSON.stringify(masked)) };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---------- credentials hook (capability `credentials`) ----------
  //
  // Pluggable TOTP / username+password lookup against an operator-configured
  // vault. Off-by-default; loud-warned at boot. Provider is per-deployment,
  // NEVER bundled. `get_credential` ADDITIONALLY requires the `secrets`
  // capability (auto-registers the looked-up password into the secrets-mask
  // registry under `<PASSWORD_<account>>` — without `secrets`, the lookup
  // refuses rather than leak cleartext into the result).

  register(
    "get_totp",
    {
      description:
        "Look up a one-time TOTP code from the deployment's configured credentials vault. **Gated behind the off-by-default `credentials` capability** — same posture class as `eval` / `network-body` / `secrets`. Provider is selected per-deployment via `BROWX_CREDENTIALS_PROVIDER` (`oathtool` default — no paid dependency, seeds via env or file; or `1password` / `bitwarden` / `lastpass` via their respective CLIs the operator installs out-of-band). Returns `{ok, code, provider}` on success; `{ok:false, error, hint, provider}` on failure (missing seed / CLI not on PATH / CLI not logged in — actionable hint included). TOTP codes are NOT masked through the secrets registry: a TOTP is single-use and short-lived, so masking buys little while complicating verify-step flows — the code is returned in plaintext so the agent can pass it to `fill({value: code})` or compare against on-page text. `account` semantics depend on the provider (oathtool: a key from `BROWX_OATHTOOL_SEEDS`; 1password/bitwarden/lastpass: an item name / id the CLI accepts).",
      inputSchema: {
        account: z
          .string()
          .describe(
            "Provider-specific account identifier (oathtool seed key / 1password item name / bitwarden item id / lastpass item name).",
          ),
      },
    },
    async ({ account }: { account: string }) => {
      const g = gateCheck("get_totp");
      if (g) return g;
      const result = await credentialsResolved.provider.getTotp(account);
      const body = {
        ...result,
        tokensEstimate: estimateTokens(JSON.stringify(result)),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "get_credential",
    {
      description:
        'Look up a `{username, password}` pair from the deployment\'s configured credentials vault. **Gated behind the off-by-default `credentials` capability** AND additionally requires the `secrets` capability (without it the lookup refuses — returning a password in cleartext would leak it into the transcript on first reference). On success, the password is AUTO-REGISTERED into the per-session secrets registry under `<PASSWORD_<account>>` (account name sanitised to `/^[A-Z][A-Z0-9_]*$/`); the agent then passes `fill({value: "<PASSWORD_acct>"})` and the runtime materialises the real value AT Playwright dispatch. The returned object carries `{ok, username, aliasName, provider}` — **never the cleartext password**. Pair with `get_totp` for the 2FA half. `oathtool` provider does NOT support `get_credential` (TOTP-only) — pair with a credential-bearing provider. `account` semantics are provider-specific (1password: item name; bitwarden: item id; lastpass: item name).',
      inputSchema: {
        account: z
          .string()
          .describe(
            "Provider-specific account identifier — see the per-provider notes in docs/tool-reference.md.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ account, session }: { account: string; session?: string }) => {
      const g = gateCheck("get_credential");
      if (g) return g;
      const e = await entryFor(session);
      const raw = (await credentialsResolved.provider.getCredential(
        account,
      )) as ProviderCredentialInternal;
      // `applyCredentialToRegistry` enforces the `secrets`-capability
      // pairing rule and strips `_password` before the result leaves this
      // module — so the response we serialise never contains cleartext.
      const registry = caps.enabled.has("secrets") ? e.secrets : null;
      const result = applyCredentialToRegistry(raw, registry, account);
      const body = {
        ...result,
        tokensEstimate: estimateTokens(JSON.stringify(result)),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---------- extensions registry (capability `extensions`) ----------
  //
  // Per-session Chrome extension management. Off-by-default capability;
  // loud-warned at boot. The 5 tools below all gate behind `extensions` AND
  // additionally refuse on incognito / attached sessions and on headless
  // launches (see src/session/extensions.ts for the rationale).
  //
  // install/reload/uninstall mutate the session's extension list AND rebuild
  // the underlying browser context — Chromium does not support adding/
  // removing extensions on a live context. The rebuild closes the current
  // BrowserSession, relaunches `openManagedSession` with the updated
  // `--load-extension` / `--disable-extensions-except` flags, and splices
  // the new inner pieces (session, console, network, ws, bridge, refs) onto
  // the existing SessionEntry. Profile state on disk (cookies, localStorage,
  // IndexedDB) survives; in-memory refs / buffers do not.

  /** Pure refusal check for the extension tools. Returns a typed early-exit
   *  envelope when the session is incognito / attached / headless; null when
   *  the session can host extensions. */
  const extensionRefusal = (e: SessionEntry, tool: string) => {
    if (e.mode === "persistent" || e.mode === "incognito" || e.mode === "attached") {
      const headless = !!(opts.headless ?? resolvedConfig.headless);
      const r = refuseExtensionsIfUnsupported({ mode: e.mode, headless, tool });
      if (r) {
        const body = { ok: false, error: r.error, hint: r.hint };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    }
    return null;
  };

  /** Rebuild the persistent session's browser context with the entry's
   *  current extension list reflected as launch flags. Closes the existing
   *  BrowserSession + bridge, relaunches via `openManagedSession`, and
   *  replaces the entry's inner pieces in-place so the registry mapping
   *  (sessionId → entry) stays valid. Caller MUST have verified the entry
   *  is `persistent` and not headless (via `extensionRefusal`). */
  const rebuildPersistentForExtensions = async (e: SessionEntry): Promise<void> => {
    const headless = opts.headless ?? resolvedConfig.headless;
    const disableWebSecurity = configStore.resolve().disableWebSecurity === true;
    const profileName = e.launchProfile ?? e.id;
    const profileDir =
      e.id === DEFAULT_SESSION_ID && !e.launchProfile
        ? workspace.sub("profile")
        : workspace.sub(`profiles/${profileName}`);
    const extensionPaths = e.extensions.loaded.filter((x) => x.enabled).map((x) => x.path);
    // Preserve the engine across the rebuild (extensions are Chromium-only, so
    // this is chromium today; reading it before close keeps the rebuild engine-
    // faithful for when a second engine lands).
    const rebuildEngine = e.session.engine;
    // Tear down the current session BEFORE relaunching — Chromium will not
    // open a second persistent context on the same profile dir.
    await e.bridge.detach().catch(() => undefined);
    await e.session.close().catch(() => undefined);
    // Resolve device fresh from the current resolved config (no spec stored
    // post-creation; the device-emulation state on `e.deviceEmulation` is
    // re-applied below).
    const device = resolveDevice({
      device: resolvedConfig.defaultDevice,
      viewport: resolvedConfig.defaultViewport,
    });
    const sess = await openManagedSession({
      headless,
      profileDir,
      device,
      disableWebSecurity,
      browserType: rebuildEngine,
      ...(extensionPaths.length ? { extensionPaths } : {}),
    });
    // Rebuild the per-session inner pieces. The secrets / dialog policy /
    // device-emulation state survive on the entry (intentional — they are
    // operator-supplied across rebuilds); buffers and refs are replaced
    // since they referenced the now-closed CDP session.
    const consoleBuf = new ConsoleBuffer();
    consoleBuf.attach(sess.page());
    // Re-select the network substrate on the rebuilt context (extensions are
    // chromium-only, so this stays the CDP substrate — but routing through the
    // selector keeps the rebuild engine-agnostic and the entry's substrate live).
    const networkSub = networkSubstrateFor(sess);
    await networkSub.attach();
    const networkBuf = networkSub.http;
    const wsBuf = networkSub.ws;
    consoleBuf.setSecrets(e.secrets);
    networkSub.setSecrets(e.secrets);
    const br = new BrowxBridge();
    await br.attach(sess.page().context());
    attachDialogPolicy(sess.page().context(), e.dialog);
    // Re-attach permission policy on the rebuilt context. The state's
    // wired-contexts WeakSet ensures the new context is treated as fresh
    // (the old one was torn down), so the binding + init-script install
    // afresh and the CDP baseline is re-applied.
    await attachPermissionPolicy(
      sess.page().context(),
      e.permission,
      async (permission, origin) => {
        log.info(
          `permission ask-human: ${permission}${origin ? ` (${origin})` : ""} → call __browx.confirm(true|false) in DevTools to respond`,
        );
        try {
          const sig = await br.awaitSignal("respond", 300_000);
          const data = sig.data as { kind?: string; value?: unknown } | null;
          if (data && data.kind === "confirm" && data.value === true) return "allow";
          return "deny";
        } catch {
          return "deny";
        }
      },
    );
    await applyPermissionCdpBaseline(sess.page().context(), e.permission).catch(() => undefined);
    // Re-attach notification-constructor policy on the rebuilt context. The
    // state's wired-contexts WeakSet ensures the new context is treated as
    // fresh (the old one was torn down), so the binding + init-script install
    // afresh and the sync-decision hint is re-seeded.
    await attachNotificationPolicy(sess.page().context(), e.notification, async (n) => {
      log.info(
        `notification ask-human: ${JSON.stringify({ title: n.title, origin: n.origin })} → call __browx.confirm(true|false) in DevTools to respond`,
      );
      try {
        const sig = await br.awaitSignal("respond", 300_000);
        const data = sig.data as { kind?: string; value?: unknown } | null;
        if (data && data.kind === "confirm" && data.value === true) return "allow";
        return "deny";
      } catch {
        return "deny";
      }
    });
    // Re-attach fs-picker policy on the rebuilt context. WeakSet inside the
    // state treats the new context as fresh — binding + init script are
    // re-installed, write-target handles for the previous context are
    // garbage-collected with it.
    await attachFsPickerPolicy(
      sess.page().context(),
      e.fsPicker,
      workspace.root,
      async (api, suggestedName) => {
        log.info(
          `fs-picker ask-human: ${api}${suggestedName ? ` (${suggestedName})` : ""} → call __browx.respond({files:[…]}) in DevTools (or fs_picker_respond) to answer`,
        );
        try {
          const sig = await br.awaitSignal("respond", 300_000);
          const data = sig.data as { kind?: string; value?: unknown } | null;
          if (
            data &&
            data.kind === "fs_picker_respond" &&
            Array.isArray((data.value as { files?: unknown })?.files)
          ) {
            return (data.value as { files: FsPickerFile[] }).files;
          }
          return null;
        } catch {
          return null;
        }
      },
    ).catch(() => undefined);
    await applyOverlayHide(sess.page().context(), configStore.resolve().hideOverlaySelectors);
    // Re-apply per-context stealth init-script (capability `stealth`) on the
    // rebuilt context. Stealth must engage on every navigation post-rebuild,
    // not just on the original launch.
    if (caps.enabled.has("stealth")) {
      await applyStealth(sess.page().context()).catch((err) => {
        log.warn(
          `stealth: rebuild failed to apply init script — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    // Re-apply per-primitive device emulation state to the fresh context's
    // pages (locale/timezone/UA via CDP, geolocation/colour-scheme/reduced-
    // motion/permissions via Playwright). Best-effort — failures don't
    // abort the rebuild.
    try {
      await reapplyEmulation(
        sess.page().context(),
        sess.page(),
        requireCdp(sess),
        e.deviceEmulation,
      );
    } catch {
      /* best-effort */
    }
    // Re-attach Web Bluetooth / WebUSB / WebHID device-emulation wrappers on
    // the rebuilt context. The state's wired-contexts WeakSet treats the new
    // context as fresh — binding + init script reinstall, current catalog is
    // re-served verbatim on the next page-side requestDevice.
    await attachDeviceEmulation(sess.page().context(), e.webDeviceEmulation).catch(() => undefined);
    sess
      .page()
      .context()
      .on("page", (newPage) => {
        (async () => {
          try {
            const newCdp = await sess.page().context().newCDPSession(newPage);
            await reapplyEmulation(sess.page().context(), newPage, newCdp, e.deviceEmulation);
          } catch {
            /* best-effort */
          }
        })().catch(() => undefined);
      });
    // Splice the new pieces onto the existing entry — sessionId still maps
    // here so every caller holding `entry` keeps working.
    e.session = sess;
    e.console = consoleBuf;
    e.networkSubstrate = networkSub;
    e.network = networkBuf;
    e.ws = wsBuf;
    e.bridge = br;
    e.refs = new RefRegistry();
    // The rebuild minted a fresh CDP session on the new context; re-derive the
    // snapshot substrate so it captures the live handle (extensions are
    // chromium-only, so this stays the CDP substrate).
    e.snapshotSubstrate = snapshotSubstrateFor(sess);
    // Interactive-WS state is page-side; the rebuild destroyed the wrapper
    // and any active interceptors with it. Discard the server-side mirror
    // so it doesn't claim live interceptors that no longer exist, then
    // re-install the wrapper before any nav so the new context's first
    // page sees the wrapped WebSocket constructor.
    e.wsInteractive = new WsInteractiveRegistry();
    if (caps.enabled.has("action")) {
      await e.wsInteractive.install(sess.page()).catch(() => undefined);
    }
    // workers visibility. Rebuild destroyed the page-side wrapper
    // and any SW attachments; discard the server-side mirror and re-install.
    e.workers.dispose();
    e.workers = new WorkersRegistry();
    if (caps.enabled.has("read")) {
      await e.workers.installPageWrapper(sess.page()).catch(() => undefined);
    }
  };

  /** Envelope helper for the extension tools. */
  const extensionEnvelope = (
    e: SessionEntry,
    extra: Record<string, unknown>,
  ): { content: Array<{ type: "text"; text: string }> } => {
    const body: Record<string, unknown> = {
      ok: true,
      session: e.id,
      loaded: e.extensions.loaded.map((x): LoadedExtension => ({ ...x })),
      ...extra,
    };
    body.tokensEstimate = estimateTokens(JSON.stringify(body));
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  };

  const extensionErrorEnvelope = (
    tool: string,
    err: unknown,
  ): { content: Array<{ type: "text"; text: string }> } => {
    const body = {
      ok: false,
      action: { type: tool },
      error: err instanceof Error ? err.message : String(err),
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
            null,
            2,
          ),
        },
      ],
    };
  };

  register(
    "extensions_install",
    {
      description:
        "Load an unpacked Chromium extension (MV3 or MV2 directory containing `manifest.json`) into the session's managed-profile launch. **Gated behind the off-by-default `extensions` capability** — same posture class as `eval` / `network-body` / `secrets`. Loaded extensions can READ every page the session visits and make ARBITRARY network requests; the extension code itself becomes trust-equivalent to the agent. " +
        "`path` is workspace-rooted (under $BROWX_WORKSPACE) — traversal / absolute-outside is rejected. Pass the UNPACKED extension directory; `.crx` packed archives must be unpacked first (the directory must contain `manifest.json`). " +
        "Headed + persistent only — incognito / attached / headless sessions REFUSE with a structured error and hint. **install REBUILDS the underlying browser context** (Chromium doesn't support adding extensions to a live context): the current page navigates to about:blank, refs invalidate, console/network/ws buffers reset. Profile state on disk (cookies, localStorage, IndexedDB) survives. Treat install as a session-restart. " +
        "Returns `{ok, session, installed:{id,name,version,path}, loaded:[…], note?, tokensEstimate}`. The `id` is a stable hash of the resolved path — pass it back to `extensions_reload` / `extensions_trigger` / `extensions_uninstall`.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Workspace-rooted directory of the unpacked extension (must contain `manifest.json`).",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ path, session }: { path: string; session?: string }) => {
      const g = gateCheck("extensions_install");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_install", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_install");
      if (refused) return refused;
      let resolved: string;
      let manifest;
      try {
        resolved = resolveExtensionPath(workspace.root, path, "extensions_install");
        manifest = readManifest(resolved, "extensions_install");
      } catch (err) {
        return extensionErrorEnvelope("extensions_install", err);
      }
      let installed;
      try {
        const r = applyExtensionInstall(
          e.extensions,
          { path: resolved, name: manifest.name, version: manifest.version },
          "extensions_install",
        );
        e.extensions.loaded = r.loaded;
        installed = e.extensions.loaded.find((x) => x.id === r.id)!;
      } catch (err) {
        return extensionErrorEnvelope("extensions_install", err);
      }
      try {
        await rebuildPersistentForExtensions(e);
      } catch (err) {
        // rebuild failed — roll back the registry so the next call doesn't
        // try to re-apply a now-doomed extension list.
        e.extensions.loaded = e.extensions.loaded.filter((x) => x.id !== installed.id);
        return extensionErrorEnvelope("extensions_install", err);
      }
      return extensionEnvelope(e, {
        installed: {
          id: installed.id,
          name: installed.name,
          version: installed.version,
          path: installed.path,
        },
        note: "browser context rebuilt — refs / console / network / ws buffers reset; on-disk profile state preserved",
      });
    },
  );

  register(
    "extensions_list",
    {
      description:
        "List extensions currently loaded for this session. Returns `[{id, name, version, path, enabled}]`. Empty list when no extension is loaded (the default). Gated behind the off-by-default `extensions` capability — disabled sessions return a structured error before reaching this list. Headed + persistent sessions only.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }: { session?: string }) => {
      const g = gateCheck("extensions_list");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_list", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_list");
      if (refused) return refused;
      return extensionEnvelope(e, {});
    },
  );

  register(
    "extensions_reload",
    {
      description:
        "Reload an installed extension: re-parse its `manifest.json`, then rebuild the underlying browser context so Chromium re-injects content scripts and restarts the MV3 service worker. Identify the extension by its `id` (from `extensions_install` / `extensions_list`). Same rebuild caveat as install — refs / buffers reset, on-disk profile state survives. Headed + persistent sessions only.",
      inputSchema: {
        id: z.string().describe("Extension id returned by extensions_install / extensions_list."),
        ...SESSION_ARG,
      },
    },
    async ({ id, session }: { id: string; session?: string }) => {
      const g = gateCheck("extensions_reload");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_reload", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_reload");
      if (refused) return refused;
      const target = e.extensions.loaded.find((x) => x.id === id);
      if (!target) {
        return extensionErrorEnvelope(
          "extensions_reload",
          new Error(
            `no extension with id "${id}" is loaded in this session (call extensions_list to see ids)`,
          ),
        );
      }
      let parsed;
      try {
        parsed = readManifest(target.path, "extensions_reload");
      } catch (err) {
        return extensionErrorEnvelope("extensions_reload", err);
      }
      try {
        const r = applyExtensionReload(e.extensions, id, parsed, "extensions_reload");
        e.extensions.loaded = r.loaded;
      } catch (err) {
        return extensionErrorEnvelope("extensions_reload", err);
      }
      try {
        await rebuildPersistentForExtensions(e);
      } catch (err) {
        return extensionErrorEnvelope("extensions_reload", err);
      }
      const after = e.extensions.loaded.find((x) => x.id === id);
      return extensionEnvelope(e, {
        reloaded: after
          ? { id: after.id, name: after.name, version: after.version, path: after.path }
          : null,
        note: "browser context rebuilt — content scripts re-injected; refs / buffers reset",
      });
    },
  );

  register(
    "extensions_trigger",
    {
      description:
        "Best-effort invoke of an installed extension's surface. With `command`, attempts to fire the keyboard-command binding declared in the extension's manifest (`commands` key). Without `command`, navigates the session's active page to the extension's `chrome-extension://<id>/<default_popup>` URL so the popup renders in-tab and is driveable like any other page. Many extensions lack both surfaces; this tool returns `ok:false` with a clear reason in those cases. Read-only side-effects on the extension itself — it does not mutate the loaded list. Headed + persistent sessions only.\n\n" +
        "**Note on `id`.** browxai's id (a hash of the path) does NOT necessarily equal the Chrome-runtime id of the loaded extension — Chrome derives its id from the extension's signing key when one is present. For popup-style triggers we attempt to read the active page's `chrome-extension://` runtime id from the context's service workers / background pages; on a mismatch the tool returns a hint pointing at extensions_list and the page's own discovery.",
      inputSchema: {
        id: z.string().describe("Extension id returned by extensions_install / extensions_list."),
        command: z
          .string()
          .optional()
          .describe(
            'Optional manifest `commands` binding name to fire (e.g. "_execute_action"). Omit to open the extension\'s default_popup in the active page.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ id, command, session }: { id: string; command?: string; session?: string }) => {
      const g = gateCheck("extensions_trigger");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_trigger", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_trigger");
      if (refused) return refused;
      const target = e.extensions.loaded.find((x) => x.id === id);
      if (!target) {
        return extensionErrorEnvelope(
          "extensions_trigger",
          new Error(
            `no extension with id "${id}" is loaded in this session (call extensions_list to see ids)`,
          ),
        );
      }
      try {
        // Resolve the Chrome-runtime id of the extension by inspecting the
        // context's service-worker / background-page URLs (both start with
        // `chrome-extension://<runtime-id>/`). We don't fail when this comes
        // up empty — the result surfaces the discovered ids so the caller
        // can decide.
        const ctx = e.session.page().context();
        // service workers (MV3) — newer Playwright surfaces them; older
        // builds may not. Best-effort.
        const sw =
          (
            ctx as unknown as { serviceWorkers?: () => Array<{ url: () => string }> }
          ).serviceWorkers?.() ?? [];
        const swIds = sw
          .map((w) => w.url())
          .filter((u) => u.startsWith("chrome-extension://"))
          .map((u) => u.slice("chrome-extension://".length).split("/")[0]!);
        // background pages (MV2)
        const bgPages =
          (
            ctx as unknown as { backgroundPages?: () => Array<{ url: () => string }> }
          ).backgroundPages?.() ?? [];
        const bgIds = bgPages
          .map((p) => p.url())
          .filter((u) => u.startsWith("chrome-extension://"))
          .map((u) => u.slice("chrome-extension://".length).split("/")[0]!);
        const runtimeIds = Array.from(new Set([...swIds, ...bgIds]));
        // We can't reliably map our path-hash id to the runtime id without
        // parsing the manifest's `key` field — when there's exactly one
        // loaded extension AND one runtime id we assume the mapping.
        const runtimeId =
          runtimeIds.length === 1 && e.extensions.loaded.length === 1 ? runtimeIds[0] : undefined;
        if (command) {
          // Chrome keyboard-command bindings are user-keyboard-only; CDP has
          // no public surface to dispatch them programmatically. Return a
          // structured "not supported" rather than silently no-op.
          return extensionErrorEnvelope(
            "extensions_trigger",
            new Error(
              `extensions_trigger: keyboard command "${command}" — Chromium does not expose extension keyboard-command dispatch via CDP / Playwright. ` +
                `Workaround: invoke the extension's underlying behaviour via its content-script API or open its popup (call extensions_trigger without \`command\`).`,
            ),
          );
        }
        if (!runtimeId) {
          return extensionErrorEnvelope(
            "extensions_trigger",
            new Error(
              `extensions_trigger: cannot determine Chrome-runtime extension id for path-hash id "${id}". ` +
                `Browxai's id is a hash of the unpacked path and does NOT necessarily equal Chrome's runtime id (Chrome derives that from the manifest \`key\` when present). ` +
                `runtimeIdsDetected: ${JSON.stringify(runtimeIds)}; loaded: ${e.extensions.loaded.length}. ` +
                `Workaround: navigate the page directly to the extension popup URL once you know the runtime id.`,
            ),
          );
        }
        // Open the extension's popup (or its background page) in the active
        // page. The extension serves `chrome-extension://<id>/` from its
        // manifest's `action.default_popup` / `browser_action.default_popup`.
        const url = `chrome-extension://${runtimeId}/`;
        await e.session
          .page()
          .goto(url, { waitUntil: "domcontentloaded" })
          .catch(() => undefined);
        return extensionEnvelope(e, {
          triggered: { id, runtimeId, url, command: command ?? null },
          note: "best-effort: navigated active page to extension root; default_popup discovery depends on the extension's manifest",
        });
      } catch (err) {
        return extensionErrorEnvelope("extensions_trigger", err);
      }
    },
  );

  register(
    "extensions_uninstall",
    {
      description:
        "Remove an installed extension from the session and rebuild the underlying browser context without it. Same rebuild caveat as install — refs / buffers reset, on-disk profile state survives. Headed + persistent sessions only.",
      inputSchema: {
        id: z.string().describe("Extension id returned by extensions_install / extensions_list."),
        ...SESSION_ARG,
      },
    },
    async ({ id, session }: { id: string; session?: string }) => {
      const g = gateCheck("extensions_uninstall");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_uninstall", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_uninstall");
      if (refused) return refused;
      let removed;
      try {
        const r = applyExtensionUninstall(e.extensions, id, "extensions_uninstall");
        e.extensions.loaded = r.loaded;
        removed = r.removed;
      } catch (err) {
        return extensionErrorEnvelope("extensions_uninstall", err);
      }
      try {
        await rebuildPersistentForExtensions(e);
      } catch (err) {
        // rebuild failed after registry mutation — restore the entry so the
        // agent can retry the operation. The original BrowserSession is
        // already torn down (we cannot recover it), so the session itself
        // is in a degraded state; surface that explicitly.
        return extensionErrorEnvelope(
          "extensions_uninstall",
          new Error(
            `(post-rebuild) ${err instanceof Error ? err.message : String(err)} — session "${e.id}" is now in a degraded state; close it and open a fresh one.`,
          ),
        );
      }
      return extensionEnvelope(e, {
        uninstalled: {
          id: removed.id,
          name: removed.name,
          version: removed.version,
          path: removed.path,
        },
        note: "browser context rebuilt without this extension — refs / buffers reset",
      });
    },
  );

  // ---------- human↔agent helper ----------

  register(
    "await_human",
    {
      description:
        "Block until the human responds in the page. Operator reads `prompt` from the server's stderr (or a future banner UI) and triggers a response from DevTools:\n" +
        "  - `acknowledge` → `__browx.proceed()` (or `signal('proceed')`)\n" +
        "  - `confirm`     → `__browx.confirm(true|false)`\n" +
        "  - `choose`      → `__browx.choose(<index-into-choices>)`\n" +
        "  - `input`       → `__browx.input('typed text')`\n" +
        "Returns `{ kind, value, timedOut }`. `pick_element` kind (in-page hover-pick overlay) is deferred to .",
      inputSchema: {
        kind: z.enum(["acknowledge", "confirm", "choose", "input"]).default("acknowledge"),
        prompt: z
          .string()
          .describe("Human-readable instruction shown to the operator (logged to stderr)."),
        choices: z
          .array(z.string())
          .optional()
          .describe(
            'For `kind:"choose"` — labels shown in the prompt; the human responds with an index into this list.',
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(3_600_000)
          .optional()
          .describe(
            "Human response window (ms). Human-paced default 300000 (5min); hard max 3600000 (1h). " +
              "there is no infinite wait — an unanswered prompt times out (the only previously " +
              "unbounded path). For unattended runs use `approve_actions` instead of a long wait.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ kind, prompt, choices, timeoutMs, session }) => {
      const g = gateCheck("await_human");
      if (g) return g;
      const e = await entryFor(session);
      // kill the only infinite path. 0/unset → 5min human-paced default,
      // hard-capped at 1h. await_human is human-paced — NOT under the 5s
      // action default — but never unbounded.
      const humanMs = Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : 300_000, 3_600_000);
      const promptBody =
        kind === "choose" && choices
          ? `${prompt}\n${choices.map((c: string, i: number) => `    [${i}] ${c}`).join("\n")}\n→ call __browx.choose(<index>) in DevTools to respond`
          : kind === "confirm"
            ? `${prompt} → call __browx.confirm(true|false)`
            : kind === "input"
              ? `${prompt} → call __browx.input('your text')`
              : `${prompt} → call __browx.proceed() to release`;
      log.info(`await_human (${kind}): ${promptBody}`);
      const signalName = kind === "acknowledge" ? "proceed" : "respond";
      try {
        const sig = await e.bridge.awaitSignal(signalName, humanMs);
        // For typed kinds the page sends `{ kind, value }`; for acknowledge it sends any/null.
        let value: unknown = sig.data;
        if (
          kind !== "acknowledge" &&
          sig.data &&
          typeof sig.data === "object" &&
          "value" in (sig.data as Record<string, unknown>)
        ) {
          value = (sig.data as { value: unknown }).value;
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ kind, value, timedOut: false }, null, 2) },
          ],
        };
      } catch (e) {
        const timedOut = e instanceof Error && e.message.includes("timed out");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  kind,
                  value: null,
                  timedOut,
                  error: timedOut ? undefined : e instanceof Error ? e.message : String(e),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---------- batch protocol primitive ----------

  const BATCH_MAX_CALLS = 32;

  register(
    "batch",
    {
      description:
        "Run a sequence of tool calls server-side and return their results as one response. Eliminates round-trip overhead for known-safe sequences (e.g. fill several fields then submit). Each call is dispatched through the same handlers as a top-level call; capability gating, confirmation hooks, and ActionResults are unchanged. Stops at the first failure unless `stopOnError: false`. Disallows nested `batch` and human-blocking tools.",
      inputSchema: {
        calls: z
          .array(
            z.object({
              tool: z.string().describe("Tool name (must be in the batch whitelist)"),
              args: z
                .record(z.unknown())
                .optional()
                .describe("Args for the inner tool, same shape as a top-level call"),
              label: z
                .string()
                .optional()
                .describe("opaque label echoed in the result entry for cross-referencing"),
              expect: z
                .object({
                  valueEquals: z.string().optional(),
                  displayTextIncludes: z.string().optional(),
                  controlDisplayTextIncludes: z.string().optional(),
                  containerTextIncludes: z.string().optional(),
                  controlChanged: z.boolean().optional(),
                })
                .optional()
                .describe(
                  "optional post-call assertions on the inner ActionResult's element probe. Failing any assertion marks the call ok=false with `error: 'expect failed: …'` and respects `stopOnError`.",
                ),
            }),
          )
          .min(1)
          .max(BATCH_MAX_CALLS)
          .describe(`Up to ${BATCH_MAX_CALLS} inner calls. Run sequentially.`),
        stopOnError: z
          .boolean()
          .optional()
          .describe(
            "Default true. When true, the first inner-call failure halts the batch. When false, every call is attempted and individual results carry their own ok/error.",
          ),
      },
    },
    async ({
      calls,
      stopOnError,
    }: {
      calls: Array<{
        tool: string;
        args?: Record<string, unknown>;
        label?: string;
        expect?: import("./util/batch.js").BatchExpect;
      }>;
      stopOnError?: boolean;
    }) => {
      const g = gateCheck("batch");
      if (g) return g;
      const report = await runBatch(calls, {
        allowed: BATCH_ALLOWED_TOOLS,
        handlers: toolHandlers,
        stopOnError,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  // ---------- act-then-trace ----------

  register(
    "act_and_sample",
    {
      description:
        "run ONE action and capture a metric trace *across its transition*, in one call — closes the state-capture-latency blind spot (a separate read lands after the spinner/pending UI already resolved). The sampler (fixed-enum, no agent JS) starts, the inner action dispatches concurrently, both are awaited. `action` is `{tool,args}` from the batch whitelist (no `batch`/`await_human`/recording/self); the inner tool's capability + deadline + the confirm hooks still apply. Sample target via `ref`/`selector`/`named` (or omit for the document scroller; not coords). Returns `{ action: <inner result>, ...sampleResult }`.",
      inputSchema: {
        action: z.object({
          tool: z.string().describe("Inner tool name (batch whitelist)."),
          args: z
            .record(z.unknown())
            .optional()
            .describe("Inner tool args (same shape as a top-level call)."),
        }),
        ...REF_OR_SELECTOR,
        metric: z.enum(ELEMENT_METRICS).describe("Fixed metric to trace (same enum as `sample`)."),
        durationMs: z.number().int().positive().max(30_000).describe("Trace window (ms, ≤30000)."),
        everyFrame: z
          .boolean()
          .optional()
          .describe("Sample every animation frame (rAF). Default false → fixed interval."),
        intervalMs: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Interval (ms, default 100, min 16). Ignored when everyFrame:true."),
        summary: z
          .boolean()
          .optional()
          .describe(
            "Series-omission control (summary always returned). true=omit series; false=always include; omit=auto-omit for large windows (>300 pts, sets `autoSummarised`).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("act_and_sample");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "act_and_sample") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `act_and_sample: inner tool "${innerTool}" not allowed (must be in the batch whitelist; no batch / await_human / recording / self)`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const ig = gateCheck(innerTool);
      if (ig) return ig; // enforce the inner tool's own capability gate
      const e = await entryFor(args.session);
      let sampleTarget;
      if (args.ref || args.selector || args.named || args.coords) {
        const t = asTarget(args, "act_and_sample", e.refs);
        if ("coords" in t) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error:
                      "act_and_sample: sample target can't be coords — use ref/selector/named or omit for the window",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        sampleTarget = t;
      }
      // Start the sampler, then dispatch the inner action concurrently so the
      // trace spans the transition. Sampler self-bounds via durationMs; the
      // inner action self-bounds via the anti-wedge deadline. Both await.
      const samplePromise = sampleMetric(e.session.page(), e.refs, {
        target: sampleTarget,
        metric: args.metric,
        durationMs: args.durationMs,
        everyFrame: args.everyFrame,
        intervalMs: args.intervalMs,
        summary: args.summary,
      });
      const innerArgs = { ...(args.action.args ?? {}), session: args.session };
      const [sRes, aRes] = await Promise.allSettled([
        samplePromise,
        toolHandlers[innerTool]!(innerArgs),
      ]);
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      const sampleOut =
        sRes.status === "fulfilled"
          ? sRes.value
          : { error: sRes.reason instanceof Error ? sRes.reason.message : String(sRes.reason) };
      const actionOut =
        aRes.status === "fulfilled"
          ? parseInner(aRes.value)
          : {
              ok: false,
              error: aRes.reason instanceof Error ? aRes.reason.message : String(aRes.reason),
            };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ action: actionOut, sample: sampleOut }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "act_and_diff",
    {
      description:
        "Run ONE action and report the DOM changes it caused within a `scope` — for selection-heavy UIs where the state change (which clip/row became selected) shows only as class / `aria-*` / `data-*` / inline-style changes, invisible to snapshot/find/text_search. Captures a structural DOM map before, dispatches the inner action, captures after, diffs. `action` is `{tool,args}` from the batch whitelist (no `batch`/`await_human`/recording/self); the inner tool's capability + deadline still apply. Returns `{ action: <inner result>, diff: { changed:[{path,tag,testId,classDelta,styleDelta,attrDelta}], added, removed, counts } }`.",
      inputSchema: {
        action: z.object({
          tool: z.string().describe("Inner tool name (batch whitelist)."),
          args: z.record(z.unknown()).optional().describe("Inner tool args."),
        }),
        scope: z
          .string()
          .optional()
          .describe(
            "CSS selector to bound the diff (default: document.body). Must exist before AND after the action.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("act_and_diff");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "act_and_diff") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `act_and_diff: inner tool "${innerTool}" not allowed (batch whitelist; no batch / await_human / recording / self)`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const ig = gateCheck(innerTool);
      if (ig) return ig;
      const e = await entryFor(args.session);
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      try {
        const before = await captureDomMap(e.session.page(), args.scope);
        const innerArgs = { ...(args.action.args ?? {}), session: args.session };
        const actionResp = await toolHandlers[innerTool]!(innerArgs);
        const after = await captureDomMap(e.session.page(), args.scope);
        const diff = diffDomMaps(before, after);
        // Egress sink — `diff.changed[].classDelta` / `styleDelta` / `attrDelta`
        // surface raw attribute / inline-style values (e.g. `aria-label="hunter2"`
        // or `style="background-image: url(?token=hunter2)"`). The inner-action
        // response was already masked by its own handler; the diff is the
        // remaining literal-value channel and is masked here.
        const maskedDiff = caps.enabled.has("secrets") ? e.secrets.applyMaskDeep(diff) : diff;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ action: parseInner(actionResp), diff: maskedDiff }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---------- flake-check ----------

  register(
    "flake_check",
    {
      description:
        "Run the same call sequence N times and report what shifted between runs — for diagnosing intermittent CI flakes BEFORE chasing them through logs. Inner calls are dispatched through the `batch` whitelist (capability + confirm hooks unchanged); each run uses `stopOnError:false` internally so a mid-sequence failure does NOT hide the variance picture for later steps. Returns per-step success-rate, distinct errors, distinct resolution signatures, the earliest `firstDivergence` step where ok shifted across runs, and a `cachedResolvers[]` artifact — `{step → resolved ref/selectorHint}` for steps where every run agreed AND succeeded. The artifact mirrors the `ActionDescriptor` shape for `plan` steps so a follow-up call can re-execute against a fresh snapshot. `stopOnAllGreen: K` short-circuits when K consecutive runs are all-green (skips redundant work once you've proved the sequence is stable).",
      inputSchema: {
        calls: z
          .array(
            z.object({
              tool: z.string().describe("Tool name (must be in the batch whitelist)"),
              args: z
                .record(z.unknown())
                .optional()
                .describe("Args for the inner tool, same shape as a top-level call"),
              label: z
                .string()
                .optional()
                .describe("opaque label echoed in the result entry for cross-referencing"),
              expect: z
                .object({
                  valueEquals: z.string().optional(),
                  displayTextIncludes: z.string().optional(),
                  controlDisplayTextIncludes: z.string().optional(),
                  containerTextIncludes: z.string().optional(),
                  controlChanged: z.boolean().optional(),
                })
                .optional()
                .describe(
                  "optional post-call assertions on the inner ActionResult — same shorthand vocabulary as `batch`.",
                ),
            }),
          )
          .min(1)
          .max(BATCH_MAX_CALLS)
          .describe(`Up to ${BATCH_MAX_CALLS} inner calls. Same shape and whitelist as \`batch\`.`),
        n: z
          .number()
          .int()
          .min(3)
          .max(20)
          .describe(
            "How many times to repeat the call sequence. Bounded [3, 20] — fewer than 3 can't surface intermittent flakes; more than 20 burns server time without sharpening the picture.",
          ),
        stopOnAllGreen: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Short-circuit when this many consecutive runs all-pass. Off by default."),
      },
    },
    async ({
      calls,
      n,
      stopOnAllGreen,
    }: {
      calls: Array<{
        tool: string;
        args?: Record<string, unknown>;
        label?: string;
        expect?: import("./util/batch.js").BatchExpect;
      }>;
      n: number;
      stopOnAllGreen?: number;
    }) => {
      const g = gateCheck("flake_check");
      if (g) return g;
      // Reject self-nesting + the same human-blocking / recording tools `batch`
      // already excludes. The whitelist is the source of truth.
      for (const c of calls) {
        if (!BATCH_ALLOWED_TOOLS.has(c.tool)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: `flake_check: inner tool "${c.tool}" not allowed (batch whitelist; no batch / flake_check / await_human / recording)`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }
      const report = await runFlakeCheck(calls, {
        n,
        ...(stopOnAllGreen !== undefined ? { stopOnAllGreen } : {}),
        allowed: BATCH_ALLOWED_TOOLS,
        handlers: toolHandlers,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  // ---------- plugin runtime ----------
  //
  // Plugins are loaded ONCE here, after every core tool has registered.
  // Cycle detection is fatal; everything else (capability mismatch,
  // missing dep, malformed manifest, load-time exception) downgrades the
  // affected plugin to a non-`loaded` status and surfaces on
  // `plugins_list`. `set_config({plugins})` persists into the config
  // store but takes effect on NEXT server restart — mirroring the
  // capability lifecycle.

  /** Per-plugin-tool capability map. Populated as the runtime registers
   *  tools; `isToolEnabled` consults this first for namespaced tools and
   *  falls back to the core map otherwise. */
  const pluginToolCapability = new Map<string, Capability | undefined>();
  /** Per-plugin-tool ownership map (tool → plugin npm name). Mirrors the
   *  runtime's internal liveTools registry so the host-side `ownerOf`
   *  hook can answer "who owns tool X" without crossing the runtime
   *  boundary. */
  const pluginToolOwner = new Map<string, string>();
  /** Per-plugin-tool def cache — keeps the description + input schema
   *  so `plugins_info` can dump the registered shape. */
  const pluginToolDef = new Map<
    string,
    { description: string; inputSchema?: Record<string, z.ZodTypeAny> | undefined }
  >();
  // Snapshot of core tool names at this point — anything registered
  // BEFORE plugin loading is a core tool from the plugin runtime's point
  // of view.
  const coreToolNames = new Set(Object.keys(toolHandlers));

  // Wrap `gateCheck` for plugin tools by patching the active gate
  // check pipeline. We can't reuse the core `gateCheck` directly — it
  // consults `TOOL_CAPABILITY` for the core surface only. The wrapper
  // injected on every plugin tool registration does the check inline.
  const pluginGate = (
    toolName: string,
  ): { content: Array<{ type: "text"; text: string }> } | null => {
    const cap = pluginToolCapability.get(toolName);
    if (cap === undefined) return null; // no capability declared → allowed
    if (caps.enabled.has(cap)) return null;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ok: false,
              error: `plugin tool "${toolName}" is disabled — its declared capability is not in the server's ACTIVE set`,
              requiredCapability: cap,
              activeCapabilities: [...caps.enabled],
              hint:
                "Plugin-declared capabilities are gated the same way as core tools — add the capability to BROWX_CAPABILITIES " +
                "(or set_config({capabilities:[...]})) and RESTART the browxai server.",
            },
            null,
            2,
          ),
        },
      ],
    };
  };

  const registerPluginTool = (
    name: string,
    def: { description: string; inputSchema?: Record<string, z.ZodTypeAny> | undefined },
    handler: PluginToolHandler,
    capability: string | undefined,
    ownerPlugin: string,
  ): void => {
    if (capability !== undefined) {
      pluginToolCapability.set(name, capability as Capability);
    } else {
      pluginToolCapability.set(name, undefined);
    }
    pluginToolOwner.set(name, ownerPlugin);
    pluginToolDef.set(name, def);
    // Plugin tool handler envelope: capability gate → handler → standard
    // metrics + diagnostics wrap. We don't apply the wedge tracker —
    // plugin tools aren't core page-exercising primitives, so the
    // session-wedged stamping path is reserved for browser-touching
    // tools the host owns.
    const wrapped: (args: unknown) => Promise<ToolResponse> = async (args: unknown) => {
      const startedAt = Date.now();
      const gated = pluginGate(name);
      if (gated) return gated;
      let inner: PluginToolResponse;
      try {
        inner = await handler(args);
      } catch (e) {
        inner = {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: `plugin tool "${name}" threw: ${e instanceof Error ? e.message : String(e)}`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      // PluginToolResponse content items match ToolResponse exactly — same
      // shape, kept as parallel types only to draw the API boundary.
      const out: ToolResponse = { content: [...inner.content] };
      noteMetrics(name, args, out, startedAt);
      noteDiagnostics(name, args, out, startedAt);
      return out;
    };
    toolHandlers[name] = wrapped;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(name, def, wrapped);
  };

  try {
    const result = await startPluginRuntime({
      workspaceRoot: workspace.root,
      enabledCapabilities: caps.enabled,
      extraDeclared: resolvedConfig.plugins,
      host: {
        isCoreTool: (n) => coreToolNames.has(n),
        dispatch: async (n, args) => {
          const fn = toolHandlers[n];
          if (!fn) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { ok: false, error: `dispatch: unknown tool "${n}"` },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          const res = await fn(args);
          return { content: [...res.content] };
        },
        registerTool: registerPluginTool,
        ownerOf: (n) => {
          if (coreToolNames.has(n)) return undefined;
          return pluginToolOwner.get(n);
        },
      },
    });
    pluginRecords = result.plugins;
    const loaded = pluginRecords.filter((p) => p.status === "loaded");
    log.info("plugin runtime: loaded", {
      apiVersion: RUNTIME_API_VERSION,
      pluginsDeclared: pluginRecords.length,
      pluginsLoaded: loaded.length,
      toolsRegistered: result.toolCount,
    });
    for (const p of pluginRecords) {
      if (p.status !== "loaded") {
        log.warn(`plugin runtime: ${p.manifest.name} status=${p.status} — ${p.statusReason ?? ""}`);
      }
    }
  } catch (e) {
    // Cycle errors and only cycle errors abort startup loudly. All other
    // failures get downgraded inside startPluginRuntime to a per-plugin
    // load-error record.
    log.error(`plugin runtime: fatal — ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }

  // plugins_list / plugins_info MCP tools ( surface).
  register(
    "plugins_list",
    {
      description:
        "List every declared browxai plugin and its load status. Each entry carries `{name, namespace, version, trust, capabilities, dependsOn, status, declaredAt, enabledAt?, statusReason?, tools, transitiveDeps}`. `status` is one of `loaded` (live), `disabled-by-capability-mismatch` (plugin declares a capability not in the server's active set), `disabled-by-cycle` (caught at startup — server start would have aborted, so this status only appears in test surfaces), `disabled-by-dep-missing` (a `dependsOn` target isn't installed or fails the version range), `disabled-by-namespace-conflict` (two plugins claimed the same namespace), or `load-error` (manifest invalid, entry module threw, etc.). Read-only — gates under `read`. The plugin runtime is RESOLVED ONCE AT SERVER START; this tool reports the live state, not what `plugins.json` currently declares (use `get_config({scope:'resolved'}).plugins` for that, plus the `pluginsPendingRestart` flag).",
      inputSchema: {},
    },
    async () => {
      const body = {
        ok: true,
        apiVersion: RUNTIME_API_VERSION,
        plugins: pluginRecords.map((p) => ({
          name: p.manifest.name,
          namespace: p.manifest.browxai.namespace || null,
          version: p.manifest.version,
          trust: p.manifest.trust,
          capabilities: p.declaredCapabilities,
          dependsOn: p.manifest.browxai.dependsOn,
          status: p.status,
          declaredAt: p.declaredAt,
          ...(p.enabledAt ? { enabledAt: p.enabledAt } : {}),
          ...(p.statusReason ? { statusReason: p.statusReason } : {}),
          tools: p.tools,
          transitiveDeps: p.transitiveDeps,
        })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "plugins_info",
    {
      description:
        "Full manifest + tool registry dump for ONE plugin. Returns `{name, version, namespace, trust, capabilities, dependsOn, transitiveDeps, status, tools: [{name, description, inputSchema?}]}` so an operator can audit what a plugin contributes to the running surface. Read-only — gates under `read`.",
      inputSchema: {
        name: z
          .string()
          .describe('npm package name of the plugin (e.g. "@browxai/plugin-example").'),
      },
    },
    async ({ name }: { name: string }) => {
      const p = pluginRecords.find((r) => r.manifest.name === name);
      if (!p) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `plugin "${name}" is not in the declared set`,
                  declared: pluginRecords.map((r) => r.manifest.name),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const tools = p.tools.map((tName) => {
        const def = pluginToolDef.get(tName);
        return {
          name: tName,
          description: def?.description ?? null,
          // Best-effort schema introspection — Zod schemas are runtime
          // objects, but we can surface the field names so the operator
          // sees the input shape. Full JSON-Schema lowering is deferred.
          inputFields: def?.inputSchema ? Object.keys(def.inputSchema).sort() : [],
        };
      });
      const body = {
        ok: true,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description ?? null,
        path: p.manifest.path,
        entryPath: p.manifest.entryPath,
        namespace: p.manifest.browxai.namespace || null,
        trust: p.manifest.trust,
        capabilities: p.declaredCapabilities,
        dependsOn: p.manifest.browxai.dependsOn,
        transitiveDeps: p.transitiveDeps,
        status: p.status,
        statusReason: p.statusReason ?? null,
        declaredAt: p.declaredAt,
        enabledAt: p.enabledAt ?? null,
        apiVersion: p.manifest.browxai.apiVersion,
        browxaiVersion: p.manifest.browxai.browxaiVersion ?? null,
        tools,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

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
