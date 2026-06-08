// Phase 2.5 — session registry. Holds one isolated SessionEntry per session id;
// the "default" entry is created lazily on first browser-touching tool call
// (back-compat: every existing caller that omits `session` resolves here).
//
// Browser-agnostic by construction: the registry takes an entry `factory` and
// a `teardown`, so it's unit-testable without launching Chrome. The factory /
// teardown that actually wire Playwright live in server.ts.

import type { BrowserSession } from "./types.js";
import type { RefRegistry } from "../page/refs.js";
import type { FrameRegistry } from "../page/frames.js";
import type { ConsoleBuffer } from "../page/console.js";
import type { NetworkBuffer, WsBuffer } from "../page/network.js";
import type { WsInteractiveRegistry } from "../page/ws-interactive.js";
import type { WorkersRegistry } from "../page/workers.js";
import type { BrowxBridge } from "../helper/bridge.js";
import type { Recorder } from "../page/recording.js";
import type { FeedbackMemory } from "../page/learning.js";
import type { ClipboardBuffer } from "../page/clipboard.js";
import type { RouteRegistry } from "../page/routes.js";
import type { RegionRegistry } from "../page/regions.js";
import type { EmulationRegistry } from "../page/emulation.js";
import type { ClockRegistry } from "../page/clock.js";
import type { SeededRandomRegistry } from "../page/seed-random.js";
import type { PerfTracingState } from "../page/perf.js";
import type { WedgeTracker } from "./wedge.js";
import type { SessionMetrics } from "./metrics.js";
import type { DialogPolicy, DialogPolicyState } from "./dialog.js";
import type { PermissionPolicy, PermissionPolicyState } from "./permission.js";
import type { NotificationPolicy, NotificationPolicyState } from "./notification.js";
import type { FsPickerPolicy, FsPickerPolicyState } from "./fs-picker.js";
import type { EmulationState as DeviceEmulationState } from "./emulation.js";
import type { DeviceEmulationState as WebDeviceEmulationState } from "./device-emu.js";
import type { SecretRegistry } from "../util/secrets.js";
import type { HarRecorderState, HarStartConfig } from "../page/har.js";
import type { VideoRecorderState, VideoStartConfig } from "../page/video.js";
import type { ExtensionRegistry } from "./extensions.js";
import type { DownloadsRegistry } from "../page/downloads.js";
import type { ArtifactsRegistry } from "./artifacts.js";

export type SessionMode = "persistent" | "incognito" | "attached";

/** Per-session state. Everything here was a server-singleton pre-Phase-2.5;
 *  one of these exists per live session id. */
export interface SessionEntry {
  id: string;
  mode: SessionMode;
  session: BrowserSession;
  refs: RefRegistry;
  /** Phase-7: per-session frame ID assignment. `frames_list` mints/looks up
   *  stable `fN` IDs from this registry; snapshot/find/action consult it to
   *  resolve a `frame` arg back to a Playwright `Frame` handle. */
  frames: FrameRegistry;
  console: ConsoleBuffer;
  network: NetworkBuffer;
  /** session-wide WebSocket/SSE frame ring. */
  ws: WsBuffer;
  /** per-session interactive-WS registry (capability `action`). Lazy:
   *  the page-side wrapper is only installed on first `ws_send` /
   *  `ws_intercept`. Holds the active interceptor patterns server-side
   *  so `unintercept` / `list` answer locally without a page round-trip. */
  wsInteractive: WsInteractiveRegistry;
  /** Phase-7: per-session worker visibility (Web Workers + Service Workers).
   *  Holds the page-side `__browxWorkers` wrapper state + the CDP-side SW
   *  attachments. Lazy in the same shape as `wsInteractive` — eagerly
   *  installed at session creation when `read` is on so workers opened by
   *  the initial document are seen; otherwise the wrapper installs on first
   *  `workers_list` / `worker_message_send` / `sw_intercept_fetch` call. */
  workers: WorkersRegistry;
  bridge: BrowxBridge;
  recorder: Recorder;
  feedback: FeedbackMemory;
  /** per-session clipboard model (capability `clipboard`). Isolated so
   *  concurrent sessions don't clobber each other through the shared OS
   *  clipboard; the OS clipboard is touched only transactionally. */
  clipboard: ClipboardBuffer;
  /** per-session network route interceptions (capability `action`). */
  routes: RouteRegistry;
  /** per-session named visual regions (capability `human`). */
  regions: RegionRegistry;
  /** per-session network + CPU emulation overrides (capability `action`).
   *  Caches active state and re-applies on main-frame navigation. */
  emulation: EmulationRegistry;
  /** per-session virtual-time clock controller (capability `action`).
   *  Wraps CDP `Emulation.setVirtualTimePolicy` for deterministic
   *  date-sensitive testing; re-applies on main-frame navigation. */
  clock: ClockRegistry;
  /** per-session seeded `Math.random` override (capability `action`). Init
   *  script wraps Mulberry32 so date / pick-randomly / id-gen flake repros
   *  are deterministic. Per-session; `crypto.randomUUID` /
   *  `crypto.getRandomValues` NOT touched in MVP. */
  seededRandom: SeededRandomRegistry;
  /** per-session CDP performance tracing state (capability `action`). One
   *  trace lifecycle at a time per session; `perf_start` while a trace is
   *  already running cleanly restarts (see src/page/perf.ts). */
  perf: PerfTracingState;
  /** W-T1 — per-session consecutive anti-wedge-timeout counter; drives the
   *  `sessionWedged` signal once the session times out repeatedly. */
  wedge: WedgeTracker;
  /** Per-session cumulative tool-call metrics (counts, latency,
   *  tokensEstimate sum, capability denials, errors). Accumulated by the
   *  dispatch wrapper in `server.ts`; surfaced via the `session_metrics`
   *  tool. Read-only from the agent's side — no per-call disk writes. */
  metrics: SessionMetrics;
  /** per-session dialog policy + per-page handler bookkeeping. Survives
   *  navigation: the `context.on('page')` install re-attaches the handler on
   *  every new page (capability `action` — no separate capability). */
  dialog: DialogPolicyState;
  /** per-session permission policy + per-context binding/init-script
   *  bookkeeping. Sibling of `dialog`: governs camera/microphone/geolocation/
   *  clipboard/notification/sensor permission requests fired from the page.
   *  Default `raise` (deterministic anti-deadlock). Mutable at runtime via
   *  `set_permission_policy`; persists across navigation (init-script is
   *  re-injected on every new document). Capability `action`. */
  permission: PermissionPolicyState;
  /** per-session notification policy + per-context binding/init-script
   *  bookkeeping. Sibling of `permission`: governs `new Notification(...)`
   *  *constructor* calls (the page actually attempting to notify the human).
   *  Distinct from `permission.notifications` — that gates the W3C permission
   *  check (`Notification.requestPermission` + `Notification.permission`),
   *  this gates the constructor surface. The two policies compose. Default
   *  `allow` (browser default — most apps expect the constructor to succeed).
   *  Mutable at runtime via `set_notification_policy`; persists across
   *  navigation. Capability `action`. */
  notification: NotificationPolicyState;
  /** per-session File System Access picker policy + per-context binding /
   *  init-script bookkeeping. Sibling of `dialog` / `permission`: governs
   *  `showOpenFilePicker` / `showSaveFilePicker` / `showDirectoryPicker`
   *  calls fired from the page. Default `raise` (deterministic anti-
   *  deadlock — without a policy, headless sessions deadlock on the picker
   *  dialog that has no driver). Mutable at runtime via
   *  `set_fs_picker_policy`; persists across navigation (init-script is
   *  re-injected on every new document). Capability `action` for the
   *  policy mutators; `file-io` for `fs_picker_respond`. */
  fsPicker: FsPickerPolicyState;
  /** Per-primitive runtime device-emulation state (locale, timezone,
   *  geolocation, colour scheme, reduced motion, user-agent, permissions).
   *  Mutated by the 7 `set_*` / `grant_permissions` tools and re-applied
   *  when a new page opens in the context. Distinct from `emulation`
   *  (which holds network/cpu throttling state). */
  deviceEmulation: DeviceEmulationState;
  /** Per-session Web Bluetooth / WebUSB / WebHID device-catalog state. Off
   *  by default — empty catalogs until `emulate_bluetooth` / `emulate_usb`
   *  / `emulate_hid` populate them. Capability `device-emulation`. When
   *  the capability is off, the page-side wrappers still install (so the
   *  default user-dismissed-picker shape is delivered without a deadlock
   *  on headless), but the check binding short-circuits to `refused`. */
  webDeviceEmulation: WebDeviceEmulationState;
  /** Per-session HAR recorder state (HTTP Archive record/replay). Drives the
   *  `start_har`/`stop_har` tools and tracks any HAR wired at session creation
   *  via `open_session({har})`. Capability `action` (writes a file). The HAR
   *  file is finalized by Playwright on `context.close()` — the recorder state
   *  carries the reserved path until then. */
  har: HarRecorderState;
  /** Per-session video recorder state. Drives the `stop_video` / `get_video`
   *  tools and tracks any video wired at session creation via
   *  `open_session({recordVideo})`. Same finalize-on-close caveat as HAR:
   *  Playwright writes the .webm only when the context closes; the
   *  registry's teardown calls `page.video().saveAs(targetPath)` for a
   *  deterministic output filename. Capability `file-io` (writes a file). */
  video: VideoRecorderState;
  /** per-session sensitive-data registry (capability `secrets`). Off by
   *  default — empty until `register_secret` is called. When non-empty, every
   *  egress sink masks occurrences of the real value back to `<NAME>` before
   *  emitting; `fill`/`press` materialise `<NAME>` to the real value at
   *  dispatch. The registry is per-session so concurrent sessions don't share
   *  an auth-flow's secrets. */
  secrets: SecretRegistry;
  /** per-session loaded Chrome extensions (capability `extensions`). Empty
   *  by default; mutated by `extensions_install` / `extensions_reload` /
   *  `extensions_uninstall`. The list also drives the launch flags
   *  (`--load-extension`, `--disable-extensions-except`) when the underlying
   *  browser context is (re)built — extensions are a launch-time concern in
   *  Chromium. Persistent (headed) sessions only — `incognito` / `attached`
   *  reject the mutators with a structured error. */
  extensions: ExtensionRegistry;
  /** Profile-name component used at launch (persistent mode only). Recorded
   *  so the rebuild path used by `extensions_*` can recompute the same
   *  profileDir without re-deriving the spec. Undefined for incognito /
   *  attached sessions. */
  launchProfile?: string;
  /** per-session download-capture registry (capability `file-io`). Off by
   *  default — every Playwright `download` event is intercepted and discarded
   *  until `downloads_capture({on:true})` toggles capture on. When on, the
   *  artifact is persisted to `$BROWX_WORKSPACE/.downloads/<sessionId>/` and
   *  surfaced on `ActionResult.downloads[]`. Same posture as `upload_file`'s
   *  workspace-rooted-paths model — the reverse direction. */
  downloads: DownloadsRegistry;
  /** per-session artifact KV (capabilities `action` for save, `read` for
   *  get/list). Workspace-rooted at `$BROWX_WORKSPACE/.artifacts/<sessionId>/`.
   *  Capacity-bounded (200 entries / 50 MiB; oldest-write evicted past the
   *  cap). The on-disk dir is wiped on session teardown — sessions that
   *  never wrote an artifact leave no trace. */
  artifacts: ArtifactsRegistry;
  openedAt: number;
  /** epoch ms of the last `get()` for this id — drives idle-age
   *  reaping (`close_sessions({ idleMs })`) at multi-agent scale. */
  lastActivityAt: number;
}

export const DEFAULT_SESSION_ID = "default";

/** Per-session creation spec, supplied by `open_session` (or undefined for the
 *  lazily-created default, which falls back to the server's launch mode). */
export interface OpenSpec {
  mode?: SessionMode;
  /** Persistent mode only: named profile dir under the workspace. */
  profile?: string;
  /** Playwright device-preset name (e.g. "iPhone 14"). */
  device?: string;
  /** explicit viewport; overrides a preset's viewport. */
  viewport?: { width: number; height: number };
  /** initial dialog policy for this session (default `{mode:"raise"}`).
   *  Mutable at runtime via `set_dialog_policy`; see src/session/dialog.ts. */
  dialogPolicy?: DialogPolicy;
  /** initial permission policy for this session (default `{mode:"raise"}`).
   *  Mutable at runtime via `set_permission_policy`; see
   *  src/session/permission.ts. */
  permissionPolicy?: PermissionPolicy;
  /** initial notification policy for this session (default `{mode:"allow"}`).
   *  Governs `new Notification(...)` constructor calls (distinct from the
   *  permission check, which lives in `permissionPolicy.notifications`).
   *  Mutable at runtime via `set_notification_policy`; see
   *  src/session/notification.ts. */
  notificationPolicy?: NotificationPolicy;
  /** initial File System Access picker policy for this session (default
   *  `{mode:"raise"}`). Mutable at runtime via `set_fs_picker_policy`;
   *  see src/session/fs-picker.ts. */
  fsPickerPolicy?: FsPickerPolicy;
  /** Seed the new context's storage state at creation (bulk layer).
   *  Either an inline blob (as returned by `dump_storage_state`) or a
   *  workspace-rooted JSON path. Mutually exclusive with `authState`.
   *  See `src/session/storage.ts` for the per-mode semantics
   *  (incognito: native primitive; managed: post-create + clears profile;
   *   attached: ignored). */
  storageState?: import("./storage.js").StorageStateBlob | string;
  /** Seed the new context's storage state at creation from a named slot
   *  (`$BROWX_WORKSPACE/.auth-states/<name>.json`, written by `auth_save`).
   *  Mutually exclusive with `storageState`. */
  authState?: string;
  /** Enable HAR recording at context creation (native Playwright `recordHar`).
   *  The HAR is finalized when the session closes. For mid-session start/stop
   *  use the `start_har`/`stop_har` tools instead — they wire HAR via
   *  `routeFromHAR(update:true)` on the running context. */
  har?: HarStartConfig;
  /** Enable video recording at context creation via Playwright's native
   *  `recordVideo` context option. The .webm is finalized when the session
   *  closes. There is no runtime `start_video` tool (Playwright doesn't
   *  expose a mid-context start) — wire it here at session creation. The
   *  target path is workspace-rooted (default
   *  `<workspace>/videos/<session-id>-<ISO>.webm`); on `close_session` the
   *  registry calls `page.video().saveAs(targetPath)` for a deterministic
   *  filename. Honoured on `persistent` + `incognito`; refused on
   *  `attached` (not-owned). */
  recordVideo?: VideoStartConfig;
  /** Workspace-rooted HAR file path(s) to REPLAY against this session. Each
   *  file is wired post-create with `context.routeFromHAR(file,
   *  {notFound:"fallback"})` — requests in the archive are served from it,
   *  anything missing falls through to the live network. */
  hars?: string[];
}

export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  /** In-flight creations, so two concurrent first-calls for the same id don't
   *  each launch a browser. */
  private creating = new Map<string, Promise<SessionEntry>>();

  constructor(
    private factory: (id: string, spec?: OpenSpec) => Promise<SessionEntry>,
    private teardown: (e: SessionEntry) => Promise<void>,
  ) {}

  /** Resolve (or lazily create) the entry for `id`. Concurrency-safe. The
   *  `spec` is only consulted on creation — once an entry exists it's returned
   *  as-is regardless of spec. */
  async get(id: string = DEFAULT_SESSION_ID, spec?: OpenSpec): Promise<SessionEntry> {
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastActivityAt = Date.now(); // touch for idle reaping
      return existing;
    }
    const inflight = this.creating.get(id);
    if (inflight) return inflight;
    const p = this.factory(id, spec)
      .then((e) => {
        this.entries.set(id, e);
        this.creating.delete(id);
        return e;
      })
      .catch((err) => {
        this.creating.delete(id);
        throw err;
      });
    this.creating.set(id, p);
    return p;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Non-creating peek — returns undefined if not yet open. */
  peek(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  list(): SessionEntry[] {
    return [...this.entries.values()];
  }

  /** Tear down + remove one session. Returns false if it wasn't open. */
  async close(id: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    await this.teardown(e);
    return true;
  }

  /**
   * bulk teardown. Selects live sessions by `prefix` (id starts-with),
   * `all`, and/or `idleMs` (no `get()` in the last N ms). Filters AND together
   * when multiple are given; at least one selector is required. Returns the
   * closed ids (in selection order). The team-lead reap primitive — at
   * multi-agent scale a wedged/killed agent strands sessions.
   */
  async closeMatching(sel: { prefix?: string; all?: boolean; idleMs?: number }): Promise<string[]> {
    const now = Date.now();
    const victims = [...this.entries.values()].filter((e) => {
      if (sel.prefix !== undefined && !e.id.startsWith(sel.prefix)) return false;
      if (sel.idleMs !== undefined && now - e.lastActivityAt < sel.idleMs) return false;
      // `all` (or prefix/idle match with all unset) — if no positive selector
      // was given the caller must pass `all`, enforced at the tool layer.
      return true;
    });
    const closed: string[] = [];
    for (const e of victims) {
      this.entries.delete(e.id);
      await this.teardown(e).catch(() => undefined);
      closed.push(e.id);
    }
    return closed;
  }

  /** Tear down everything (server shutdown). */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const e of all) {
      await this.teardown(e).catch(() => undefined);
    }
  }
}
