import { openManagedSession } from "../session/managed.js";
import { openByobSession } from "../session/byob.js";
import { requireCdp, type EngineKind } from "../engine/index.js";
import { openIncognitoSession } from "../session/incognito.js";
import { resolveDevice } from "../session/device.js";
import { newEmulationState, reapplyAll as reapplyEmulation } from "../session/emulation.js";
import type { BrowserSession } from "../session/types.js";
import {
  SessionRegistry,
  DEFAULT_SESSION_ID,
  type SessionEntry,
  type SessionMode,
} from "../session/registry.js";
import { newExtensionRegistry } from "../session/extensions.js";
import { WedgeTracker } from "../session/wedge.js";
import { SessionMetrics } from "../session/metrics.js";
import { DialogPolicyState, attachDialogPolicy } from "../session/dialog.js";
import {
  PermissionPolicyState,
  attachPermissionPolicy,
  applyCdpBaseline as applyPermissionCdpBaseline,
} from "../session/permission.js";
import { NotificationPolicyState, attachNotificationPolicy } from "../session/notification.js";
import {
  FsPickerPolicyState,
  attachFsPickerPolicy,
  type FsPickerFile,
} from "../session/fs-picker.js";
import {
  DeviceEmulationState as WebDeviceEmulationState,
  attachDeviceEmulation,
} from "../session/device-emu.js";
import { RefRegistry } from "../page/refs.js";
import { snapshotSubstrateFor } from "../page/snapshot-substrate-select.js";
import { networkSubstrateFor } from "../page/network-substrate-select.js";
import { FrameRegistry } from "../page/frames.js";
import { RouteRegistry } from "../page/routes.js";
import { WsInteractiveRegistry } from "../page/ws-interactive.js";
import { WorkersRegistry } from "../page/workers.js";
import { EmulationRegistry } from "../page/emulation.js";
import { ClockRegistry } from "../page/clock.js";
import { SeededRandomRegistry } from "../page/seed-random.js";
import { PerfTracingState } from "../page/perf.js";
import { CoverageTrackerState } from "../page/coverage.js";
import { RegionRegistry } from "../page/regions.js";
import { DownloadsRegistry, attachDownloadCapture } from "../page/downloads.js";
import { ArtifactsRegistry } from "../session/artifacts.js";
import { readStorageStateFile, authLoad, type StorageStateBlob } from "../session/storage.js";
import { SecretRegistry } from "../util/secrets.js";
import { ClipboardBuffer } from "../page/clipboard.js";
import { ConsoleBuffer } from "../page/console.js";
import {
  newHarRecorderState,
  buildRecordHarOption,
  applyHarReplay,
  resolveHarReplayPaths,
} from "../page/har.js";
import {
  newVideoRecorderState,
  buildRecordVideoOption,
  finalizeVideoOnClose,
} from "../page/video.js";
import { BrowxBridge } from "../helper/bridge.js";
import { applyOverlayHide } from "../helper/overlay-hide.js";
import { applyStealth } from "../helper/stealth.js";
import { Recorder } from "../page/recording.js";
import { FeedbackMemory } from "../page/learning.js";
import { log } from "../util/logging.js";
import type { CapabilityConfig } from "../util/capabilities.js";
import type { ConfigStore, ResolvedConfig } from "../util/config-store.js";
import type { Workspace } from "../util/workspace.js";
import type { StartOptions } from "../server.js";

/** The createServer-owned locals the SessionRegistry factory + teardown close
 *  over. Bundled here so the construction expression moves verbatim — every
 *  callback body references these exactly as it did inline in `createServer`. */
export interface SessionRegistryDeps {
  opts: StartOptions;
  resolvedConfig: ResolvedConfig;
  configStore: ConfigStore;
  caps: CapabilityConfig;
  workspace: Workspace;
  serverEngine: EngineKind;
  serverDefaultMode: SessionMode;
}

/**
 * Build the per-session `SessionRegistry` — the composition root's session
 * factory + teardown pair. Moved out of `createServer` verbatim: the "default"
 * session is still created lazily on the first browser-touching tool call, and
 * every factory/teardown body is byte-identical to the inline version. The
 * createServer locals each callback references (config, caps, workspace, …)
 * arrive through `deps`.
 */
export function buildSessionRegistry(deps: SessionRegistryDeps): SessionRegistry {
  const { opts, resolvedConfig, configStore, caps, workspace, serverEngine, serverDefaultMode } =
    deps;
  return new SessionRegistry(
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
}
