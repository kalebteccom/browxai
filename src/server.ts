// MCP server wiring. Tools are registered here; their implementations live in
// page/* and helper/*. stdout is the MCP channel — all logging goes via util/logging.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openManagedSession } from "./session/managed.js";
import { openByobSession } from "./session/byob.js";
import { requireCdp, assertEngineSupports, type EngineKind } from "./engine/index.js";
import { openIncognitoSession } from "./session/incognito.js";
import { resolveDevice } from "./session/device.js";
import { newEmulationState, reapplyAll as reapplyEmulation } from "./session/emulation.js";
import type { BrowserSession } from "./session/types.js";
import {
  SessionRegistry,
  DEFAULT_SESSION_ID,
  type SessionEntry,
  type SessionMode,
} from "./session/registry.js";
import { newExtensionRegistry } from "./session/extensions.js";
import { WedgeTracker } from "./session/wedge.js";
import { SessionMetrics, type DispatchOutcome } from "./session/metrics.js";
import { DialogPolicyState, attachDialogPolicy } from "./session/dialog.js";
import {
  PermissionPolicyState,
  attachPermissionPolicy,
  applyCdpBaseline as applyPermissionCdpBaseline,
} from "./session/permission.js";
import { NotificationPolicyState, attachNotificationPolicy } from "./session/notification.js";
import {
  FsPickerPolicyState,
  attachFsPickerPolicy,
  type FsPickerFile,
} from "./session/fs-picker.js";
import {
  DeviceEmulationState as WebDeviceEmulationState,
  attachDeviceEmulation,
} from "./session/device-emu.js";
import { RefRegistry } from "./page/refs.js";
import { snapshotSubstrateFor } from "./page/snapshot-substrate-select.js";
import { networkSubstrateFor } from "./page/network-substrate-select.js";
import { FrameRegistry } from "./page/frames.js";
import { RouteRegistry } from "./page/routes.js";
import { WsInteractiveRegistry } from "./page/ws-interactive.js";
import { WorkersRegistry } from "./page/workers.js";
import { EmulationRegistry } from "./page/emulation.js";
import { ClockRegistry } from "./page/clock.js";
import { SeededRandomRegistry } from "./page/seed-random.js";
import { PerfTracingState } from "./page/perf.js";
import { CoverageTrackerState } from "./page/coverage.js";
import { RegionRegistry } from "./page/regions.js";
import { DownloadsRegistry, attachDownloadCapture } from "./page/downloads.js";
import { ArtifactsRegistry } from "./session/artifacts.js";
import { readStorageStateFile, authLoad, type StorageStateBlob } from "./session/storage.js";
import { SecretRegistry } from "./util/secrets.js";
import { resolveCredentialsProvider } from "./util/credentials.js";
import { ClipboardBuffer } from "./page/clipboard.js";
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
import { ConfigStore, resolvedToEnv } from "./util/config-store.js";
import { ConsoleBuffer } from "./page/console.js";
import {
  newHarRecorderState,
  buildRecordHarOption,
  applyHarReplay,
  resolveHarReplayPaths,
} from "./page/har.js";
import {
  newVideoRecorderState,
  buildRecordVideoOption,
  finalizeVideoOnClose,
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
  type EmulationSubstrate,
} from "./page/emulation-substrate.js";
import { screenshotSave } from "./page/screenshot-save.js";
import type { ActionContext } from "./page/actionresult.js";
import { BrowxBridge } from "./helper/bridge.js";
import { applyOverlayHide } from "./helper/overlay-hide.js";
import { applyStealth } from "./helper/stealth.js";
import {
  resolveCapabilities,
  resolveConfirmHooks,
  isToolEnabled,
  TOOL_CAPABILITY,
} from "./util/capabilities.js";
import type { PluginRecord } from "./plugin/types.js";
import { resolveOriginPolicy, describePolicy } from "./policy/origin.js";
import { ApprovalStore } from "./policy/confirm.js";
import { Recorder } from "./page/recording.js";
import { FeedbackMemory } from "./page/learning.js";
import { log } from "./util/logging.js";
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
import { registerSessionPolicyTools } from "./tools/session-policy-tools.js";
import { registerEmulationConfigTools } from "./tools/emulation-config-tools.js";
import { registerInputTools } from "./tools/input-tools.js";
import { registerExtensionsBatchTools } from "./tools/extensions-batch-tools.js";
import { wirePluginRuntime } from "./tools/plugin-runtime.js";
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
    resolvedConfig,
    startOptions: opts,
    z,
    toolHandlers,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
    registry,
    diagnostics,
    approvals,
    credentialsResolved,
    // `pluginRecords` is assigned after the host literal is built (plugin
    // runtime starts later); expose it lazily so get_config sees the live set.
    get pluginRecords() {
      return pluginRecords;
    },
  };

  registerReadObserveTools(host);
  registerActionTools(host);
  registerGestureNetworkTools(host);
  registerDeepTools(host);
  registerCaptureReportTools(host);
  registerCanvasTools(host);
  registerStorageTools(host);
  registerFormsRecordingTools(host);
  registerSessionPolicyTools(host);
  registerEmulationConfigTools(host);
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
  pluginRecords = await wirePluginRuntime(host, { server, noteMetrics, noteDiagnostics });

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
