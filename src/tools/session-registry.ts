import { openManagedSession } from "../session/managed.js";
import { openByobSession } from "../session/byob.js";
import { requireCdp, type EngineKind, requirePage } from "../engine/index.js";
import {
  engineEntry,
  byobAttachNeedsEndpoint,
  engineIsAttachOnly,
  engineRequiredCapability,
  type SubstrateDeps,
  type PostWireDeps,
} from "../engine/registry.js";
import "../engine/register-engines.js";
import { openIncognitoSession } from "../session/incognito.js";
import { resolveDevice } from "../session/device.js";
import { newEmulationState } from "../session/emulation.js";
import type { BrowserSession } from "../session/types.js";
import {
  SessionRegistry,
  DEFAULT_SESSION_ID,
  type SessionEntry,
  type SessionMode,
} from "../session/registry.js";
import { hostFreeSubstrateDeps } from "../session/substrate-deps.js";
import { newExtensionRegistry } from "../session/extensions.js";
import { WedgeTracker } from "../session/wedge.js";
import { SessionMetrics } from "../session/metrics.js";
import { DialogPolicyState } from "../session/dialog.js";
import { PermissionPolicyState } from "../session/permission.js";
import { NotificationPolicyState } from "../session/notification.js";
import { FsPickerPolicyState } from "../session/fs-picker.js";
import { DeviceEmulationState as WebDeviceEmulationState } from "../session/device-emu.js";
import { RefRegistry } from "../page/refs.js";
import { FrameRegistry } from "../page/frames.js";
import { WsInteractiveRegistry } from "../page/ws-interactive.js";
import { WorkersRegistry } from "../page/workers.js";
import { EmulationRegistry } from "../page/emulation.js";
import { ClockRegistry } from "../page/clock.js";
import { SeededRandomRegistry } from "../page/seed-random.js";
import { PerfTracingState } from "../page/perf.js";
import { CoverageTrackerState } from "../page/coverage.js";
import { RegionRegistry } from "../page/regions.js";
import { DownloadsRegistry } from "../page/downloads.js";
import { ArtifactsRegistry } from "../session/artifacts.js";
import { SecretRegistry } from "../util/secrets.js";
import { ClipboardBuffer } from "../page/clipboard.js";
import { ConsoleBuffer } from "../page/console.js";
import { newHarRecorderState, applyHarReplay } from "../page/har.js";
import { newVideoRecorderState } from "../page/video.js";
import type { CaptureSubstrate } from "../page/capture-substrate.js";
import { resolveCreationOptions } from "./session-creation-options.js";
import { BrowxBridge } from "../helper/bridge.js";
import { Recorder } from "../page/recording.js";
import { ReplaySession } from "../replay/session.js";
import { FeedbackMemory } from "../page/learning.js";
import { log } from "../util/logging.js";
import { capabilityMissing, type CapabilityConfig } from "../util/capabilities.js";
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

/** Default launch mode for a session given its (effective, per-session) engine
 *  and whether the server was started with a CDP attach endpoint. Mirrors the
 *  server-level `serverDefaultMode` (createServer) but keys on the PER-SESSION
 *  engine, so an explicit `open_session({engine:"android"})` defaults to
 *  `attached` even on a chromium-default server (android is attach-only). For
 *  any non-android engine the result is byte-identical to the legacy server
 *  default, so omitting `engine` changes nothing. */
export function defaultModeForEngine(
  engine: EngineKind,
  attachCdp: string | undefined,
): SessionMode {
  if (engineIsAttachOnly(engine)) return "attached";
  return attachCdp ? "attached" : "persistent";
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
  // This server's OWN post-wire deps (caps / configStore / workspace) — threaded
  // explicitly into `engineEntry(...).postWire(entry, serverPostWireDeps)` per
  // session, never a module-global. A module-global would let a SECOND server in
  // the same process (the in-process SDK transport composes one server per
  // transport) overwrite this server's caps gate + workspace sandbox-root, so its
  // post-wire could install another server's action-gated wrappers / stealth
  // scripts on THIS server's sessions. The closure-owned local makes that
  // impossible: every session this registry opens wires with exactly these deps.
  const serverPostWireDeps: PostWireDeps = { caps, configStore, workspace };
  // The substrate deps the registry resolves its substrates with. It holds none
  // of the server's host config (`ctxFor` / `describeTarget` / `save` are
  // host-build's), so each of those throws if reached — lazily, when called. The
  // registry drives `snapshot` and `network` at session creation and the capture
  // port's video flush at teardown; `screenshot` on that same capture object
  // still refuses. Shared with the extension-context rebuild.
  const registrySubstrateDeps: SubstrateDeps = hostFreeSubstrateDeps("session-registry");
  /** The capture port for a session, from the engine's own bundle.
   *
   *  Teardown-only, and only for `prepareVideoSave`. Flushing a recording is the
   *  one capture member that needs no host closure, and routing it through the
   *  port is what takes the last Playwright-`Page` read out of the teardown path
   *  — an engine with no `Page` answers `null` instead of throwing at
   *  `requirePage`, and RFC 0008 §5's segmented native writer has somewhere to
   *  land. (RFC 0009 P3.) */
  const captureFor = (e: SessionEntry): CaptureSubstrate =>
    engineEntry(e.session.engine).makeSubstrates(registrySubstrateDeps).capture(e);
  return new SessionRegistry(
    async (id, spec): Promise<SessionEntry> => {
      const headless = opts.headless ?? resolvedConfig.headless;
      // The engine for THIS session: an explicit `open_session({engine})`
      // overrides the server default; omitted ⇒ the server engine (legacy). One
      // server can therefore drive sessions on different engines at once.
      const effectiveEngine: EngineKind = spec?.engine ?? serverEngine;
      // The ENGINE-level capability gate (RFC 0008 §8). An engine whose session
      // broadens posture on its own — a native engine installs and launches
      // applications, drives an OS-level input pipeline and photographs the
      // screen before any tool runs — declares the capability it needs at
      // registration, and the refusal lands here, at session creation, so no tool
      // it serves can be reached around it. Data-driven: adding such an engine is
      // still one `registerEngine(...)` call.
      const requiredCapability = engineRequiredCapability(effectiveEngine);
      if (requiredCapability && capabilityMissing(requiredCapability, caps)) {
        throw new Error(
          `capability-required: the "${effectiveEngine}" engine needs the ` +
            `\`${requiredCapability}\` capability, which is OFF by default. Add it to ` +
            `BROWX_CAPABILITIES (e.g. BROWX_CAPABILITIES=read,navigation,action,human,` +
            `${requiredCapability}) and restart the server. See docs/threat-model.md for what ` +
            "it grants.",
        );
      }
      // Omitted engine keeps the exact legacy default mode (`serverDefaultMode`);
      // an explicit per-session engine resolves its own default (android ⇒
      // attached). Non-android explicit engines match the legacy default too.
      const mode: SessionMode =
        spec?.mode ??
        (spec?.engine !== undefined
          ? defaultModeForEngine(effectiveEngine, opts.attachCdp)
          : serverDefaultMode);
      // resolve the gated launch knobs *fresh* per session so a `set_config`
      // takes effect on the next open_session without a server restart.
      // `disableWebSecurity` is off by default; `channel` unset keeps the
      // bundled Chrome for Testing build, and the per-session spec wins.
      const launchConfig = configStore.resolve();
      const disableWebSecurity = launchConfig.disableWebSecurity === true;
      const channel = spec?.channel ?? launchConfig.channel;
      const backgroundThrottling = spec?.backgroundThrottling;
      // resolve device/viewport — spec overrides config-store defaults.
      const device = resolveDevice({
        device: spec?.device ?? resolvedConfig.defaultDevice,
        viewport: spec?.viewport ?? resolvedConfig.defaultViewport,
      });
      // Resolve the native context-creation primitives (creation-time
      // storageState w/ storageState⊕authState exclusivity, HAR recording, HAR
      // replay paths, video recording) from the spec. Pure — no browser yet.
      // Resolved EXACTLY ONCE: the helper performs the workspace-path safety
      // checks (parent-dir creation, missing-replay-file errors) as a side
      // effect, so re-calling it would double them.
      const creationOptions = resolveCreationOptions(id, workspace.root, spec);
      const {
        creationStorageState,
        creationReplayHars,
        creationRecordVideo,
        creationRecordVideoResolved,
      } = creationOptions;
      // `creationRecordHar*` stay mutable because the attached branch below
      // NULLS them out (BYOB Chrome is not-owned: we don't wire context-creation
      // primitives on it); everything else is read-only after resolution.
      let creationRecordHar = creationOptions.creationRecordHar;
      let creationRecordHarResolved = creationOptions.creationRecordHarResolved;
      let sess: BrowserSession;
      if (mode === "attached") {
        // android attach is endpoint-DISCOVERED over adb — it does NOT need
        // BROWX_ATTACH_CDP; the desktop CDP-attach lane still requires it. The
        // android-specific fact lives in the engine layer (`byobAttachNeedsEndpoint`),
        // so this precondition stays engine-agnostic (no `=== "android"` literal).
        if (byobAttachNeedsEndpoint(effectiveEngine) && !opts.attachCdp) {
          throw new Error(
            `byob-attach-endpoint-required: session "${id}": mode "attached" on engine ` +
              `"${effectiveEngine}" requires the server to be started with BROWX_ATTACH_CDP ` +
              `(per-session attach endpoints aren't supported yet)`,
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
        if (spec?.channel || backgroundThrottling) {
          log.warn(
            `session "${id}": ignoring \`channel\` / \`backgroundThrottling\` for attached/BYOB ` +
              "session — both are launch-time settings and the consumer's Chrome was already " +
              "launched by whoever started it. Use `browxai chrome start` (which takes " +
              "--disable-background-throttling) or your own launch flags for the attach target.",
          );
        }
        // Attached Chrome is not-owned: device emulation is best-effort
        // (viewport via Emulation in byob.ts); isMobile/touch/UA can't be
        // retro-applied to an existing context.
        sess = await openByobSession({
          attachCdp: opts.attachCdp,
          headless,
          browserType: effectiveEngine,
          sessionId: id,
        });
      } else if (mode === "incognito") {
        sess = await openIncognitoSession({
          headless,
          device,
          disableWebSecurity,
          channel,
          backgroundThrottling,
          storageState: creationStorageState,
          recordHar: creationRecordHar,
          recordVideo: creationRecordVideo,
          browserType: effectiveEngine,
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
          channel,
          backgroundThrottling,
          storageState: creationStorageState,
          recordHar: creationRecordHar,
          recordVideo: creationRecordVideo,
          browserType: effectiveEngine,
        });
      }
      // Initialise HAR recorder state. If `recordHar` was wired at context
      // creation, mark the recorder `active + nativeRecord:true` so
      // `start_har` / `stop_har` can refuse cleanly (the native path can't be
      // toggled mid-session — Playwright finalizes it on context.close()).
      const harState = newHarRecorderState();
      // The per-engine substrate bundle — the EngineRegistry resolves it once per
      // session (RFC 0004 D1). The seven selectors (actions/capture/storage/script/
      // emulation/snapshot/network) are the engine's own concern; here we use the
      // snapshot/network pair to wire the session's substrates. A `{ session }`
      // partial is enough for those two (they read only `e.session`); the substrate
      // deps are this server's own (action/capture deps unreachable on this path).
      const substrates = engineEntry(sess.engine).makeSubstrates(registrySubstrateDeps);
      const substrateSeed = { session: sess } as SessionEntry;
      // safari is the first non-Playwright engine: it has no Playwright Page, no
      // Playwright BrowserContext. The few creation-config steps below that need
      // the per-session creation locals (HAR/video state init, HAR replay) stay in
      // the factory, keyed on the engine's Playwright-Page capability (`!sess.safari`
      // — a capability check, not an engine-name branch). The full post-creation
      // attach set (console / bridge / dialog / permission / notification /
      // fs-picker / downloads / overlay / stealth / device-emulation / ws-interactive
      // / workers) has been RELOCATED into the engine's `postWire` (called after the
      // entry is assembled), so the 17 scattered `!== "safari"` guards collapse into
      // one engine-agnostic call — byte-identical, only owned by the engine now.
      const hasPlaywrightPage = !sess.safari;
      if (creationRecordHarResolved && hasPlaywrightPage) {
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
      if (creationRecordVideoResolved && hasPlaywrightPage) {
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
      if (creationReplayHars && creationReplayHars.length && hasPlaywrightPage) {
        await applyHarReplay(requirePage(sess).context(), creationReplayHars);
      }
      // per-session console buffer. The page/BiDi attach is the engine's job —
      // it runs in `postWire` (Playwright: `console.attach(page)`; Safari: the
      // BiDi `log.entryAdded` bridge), so the buffer is built here and wired below.
      const consoleBuf = new ConsoleBuffer();
      // The network/WS substrate is selected by engine capability via the bundle:
      // chromium (CDP present) gets the verbatim CDP NetworkBuffer/WsBuffer/tap;
      // firefox/webkit get the Playwright context-event buffers; safari the no-op.
      // The session-wide rings attach once here; the action window mints its
      // per-action tap from the substrate and `network_body` fetches through it —
      // so the network tools + the envelope's network slice run on every engine.
      const networkSub = substrates.network(substrateSeed);
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
      // dialog / permission / notification / fs-picker policy STATES are built
      // here from the spec (the string parsing happened at the open_session tool
      // layer); their per-context ATTACH lives in the engine's `postWire`.
      const dialogState = new DialogPolicyState(spec?.dialogPolicy ?? { mode: "raise" });
      const permissionState = new PermissionPolicyState(
        spec?.permissionPolicy ?? { mode: "raise" },
      );
      const notificationState = new NotificationPolicyState(
        spec?.notificationPolicy ?? { mode: "allow" },
      );
      const fsPickerState = new FsPickerPolicyState(spec?.fsPickerPolicy ?? { mode: "raise" });
      // Per-session download capture. Storage dir is workspace-rooted +
      // per-session — kept off the public profile dir so cleaning up captured
      // artefacts is a single rmdir without touching the profile. The
      // registry is off by default; the `downloads_capture` MCP tool toggles
      // it. The context listener attach lives in the engine's `postWire`.
      const downloadsDir = workspace.sub(`.downloads/${id}`);
      const downloadsReg = new DownloadsRegistry(downloadsDir);
      // Per-session artifact KV. Storage dir is workspace-rooted +
      // per-session; the dir itself is created lazily on first save, and
      // wiped on session teardown (see `teardown` below). Capacity-bounded
      // — 200 entries / 50 MiB, oldest-write evicted.
      const artifactsDir = workspace.sub(`.artifacts/${id}`);
      const artifactsReg = new ArtifactsRegistry(artifactsDir);
      // Fresh per-primitive device-emulation state (locale, timezone,
      // geolocation, colour scheme, reduced motion, user-agent, permissions).
      // Re-applied on every new page in this context so a mid-session-opened
      // tab inherits the overrides — the page-event re-apply attach lives in the
      // engine's `postWire`.
      const deviceEmulation = newEmulationState();
      // Per-session Web Bluetooth / WebUSB / WebHID synthetic-device catalogs
      // (capability `device-emulation`). The init-script wrappers install in
      // `postWire`; the catalog is off by default until the emulate_* tools
      // populate it.
      const webDeviceEmulation = new WebDeviceEmulationState(caps.enabled.has("device-emulation"));
      const entry: SessionEntry = {
        id,
        mode,
        session: sess,
        refs: new RefRegistry(),
        // Engine-agnostic snapshot/a11y substrate, resolved from the engine's
        // bundle (chromium → the verbatim CDP substrate; firefox/webkit → the
        // page-side walker; safari → the WebDriver-Classic DOM-walk). Selected by
        // the engine's capability, never an engine-name check. Captured once here
        // so the hot snapshot/find path is a direct delegate, no per-call allocation.
        snapshotSubstrate: substrates.snapshot(substrateSeed),
        // Engine-agnostic network substrate (also from the bundle). `network` / `ws`
        // below ARE this substrate's session-wide rings; the action window mints its
        // per-action tap from it. Captured once here so the hot envelope path is a
        // captured-handle delegate.
        networkSubstrate: networkSub,
        frames: new FrameRegistry(),
        console: consoleBuf,
        network: networkBuf,
        ws: wsBuf,
        bridge: br,
        recorder: new Recorder(),
        feedback: new FeedbackMemory(),
        clipboard: new ClipboardBuffer(),
        // The page-side WS-interactive + workers wrappers install EAGERLY — but
        // that install is a Playwright-Page concern, so it has moved into the
        // engine's `postWire` (capability-gated on `action` / `read`). Here we
        // build the empty registries; `postWire` installs the page wrappers before
        // the session is handed to a tool call (byte-identical eager-install timing).
        wsInteractive: new WsInteractiveRegistry(),
        workers: new WorkersRegistry(),
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
        // Fresh replay orchestrator per session (capability `replay`). Inactive
        // until `start_recording({replay})` engages it; assigned after the
        // literal because it captures `entry` by reference.
        replay: null as unknown as ReplaySession,
      };
      entry.replay = new ReplaySession(entry);
      // Post-creation wiring — the engine owns its own bookkeeping (RFC 0004 D1).
      // The four Playwright engines attach the full console/bridge/policy/download/
      // stealth/device-emulation/ws-interactive/workers set + await it; safari
      // attaches only its BiDi console bridge; a no-Page engine attaches nothing.
      // This is the one call the 17 scattered `!== "safari"` guards collapsed into.
      // The per-server deps are passed explicitly (never a module-global) so a
      // second server in this process can never wire THIS session with its caps or
      // sandbox root.
      await engineEntry(sess.engine).postWire(entry, serverPostWireDeps);
      return entry;
    },
    async (e): Promise<void> => {
      // Stop any in-flight perf trace BEFORE closing CDP — otherwise the
      // attached Chrome (BYOB) keeps the trace buffer pinned. Best-effort:
      // a stuck Tracing.end won't block teardown (perf state bounds the wait).
      // Keyed on the Playwright-Page capability (`!e.session.safari`), not an
      // engine-name branch — Safari has no CDP, so `requireCdp` would refuse.
      const teardownHasCdp = !e.session.safari;
      if (teardownHasCdp) await e.perf.closeIfRunning(requireCdp(e.session)).catch(() => undefined);
      // also release any in-flight Profiler/CSS coverage on
      // the attached target so a BYOB Chrome doesn't keep coverage state
      // pinned past detach.
      if (teardownHasCdp)
        await e.coverage.closeIfRunning(requireCdp(e.session)).catch(() => undefined);
      // workers registry CDP listeners. Detach before CDP closes
      // so we don't race the parent session shutdown.
      try {
        e.workers.dispose();
      } catch {
        /* best-effort */
      }
      // Replay session teardown BEFORE the CDP/page handle goes away, so the
      // subscription off() calls the abort path issues still land on a live
      // context. Never runs the artifact writer — an abandoned recording
      // becomes a no-trace unlink of the intermediate JSONL, so a
      // `close_session` on an active recording never leaves plaintext page
      // data on disk. `abort()` is a no-op when nothing is recording.
      await e.replay.abort().catch(() => undefined);
      await e.bridge.detach().catch(() => undefined);
      // Take the video flush BEFORE close, run it after. The engine handle the
      // flush needs has to be resolved while the session is live, but the bytes
      // only exist once `e.session.close()` has closed the underlying context —
      // `video.saveAs()` blocks until the page is closed AND the recording is
      // fully written. So the order is: take the flush → close → flush to the
      // deterministic target path.
      //
      // Through the capture port (RFC 0009 P3). This was `requirePage(e.session)`
      // handed to `finalizeVideoOnClose`, the last Playwright-`Page` read in the
      // teardown path and the whole of the RFC's `video` bypass cluster. An
      // engine with no `Page` answers `null` and the teardown skips the flush,
      // which is what it already did for a session with no recorder.
      const flushVideo = e.video.active ? await captureFor(e).prepareVideoSave(e.video) : null;
      await e.session.close().catch(() => undefined);
      if (flushVideo) await flushVideo().catch(() => undefined);
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
