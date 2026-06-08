// Per-session permission policy. Sibling of `dialog_policy`. Plugs the
// runtime-permission blind spot: camera / microphone / geolocation / clipboard /
// notification (and the long tail of sensor permissions) requests fire from the
// page asynchronously; without a server-side interceptor the request either
// silently sits forever (default Chromium policy in headless: "denied" via no
// user-gesture infobar) or — worse — pre-grants from `grant_permissions` change
// app behavior silently. This module wires a four-mode policy mirroring
// `dialog_policy`'s posture:
//
//   - "allow"     — pre-grant via CDP `Browser.setPermission`; in-page wrappers
//                   call through. The app sees a granted permission.
//   - "deny"      — pre-deny via CDP; in-page wrappers reject with the standard
//                   `NotAllowedError`. The app sees a denied permission.
//   - "raise"     — DEFAULT (deterministic anti-deadlock). Pre-deny via CDP +
//                   in-page wrappers reject AND RECORD the request as
//                   `handledAs:"raised"`. The next ActionResult flips `ok:false`
//                   with a stable hint pointing at `set_permission_policy`.
//                   Mirrors `dialog_policy`'s `raise` — the page never blocks,
//                   but a permission request never silently changes app state
//                   under an unaware caller either.
//   - "ask-human" — server records the request, blocks on
//                   `bridge.awaitSignal("respond")` (the `await_human({kind:
//                   "confirm"})` mechanism), then calls through or rejects per
//                   the human's answer.
//
// Per-permission override map. The top-level `mode` is the default; the
// per-permission map (`perPermission: { camera: "allow", … }`) overrides it for
// a specific permission name. Mirrors how Playwright's permission set is
// per-name. The `current(name)` accessor handles the fallback chain.
//
// Per-action capture. Every page-side request is appended to a buffer with a
// timestamp. `since(ts)` slices for the action window — same pattern as
// `dialog_policy`'s buffer; the `raisedSince(ts)` flag drives the
// ok:false flip.
//
// Why two layers (CDP setPermission + init-script wrappers) ?
//   - CDP `Browser.setPermission` controls the *state* the browser reports
//     (granted / denied) — `navigator.permissions.query({name:"camera"})`
//     reads this state without ever invoking our wrappers; without setting it
//     we get the wrong reading. But CDP can't record *when* the page asked.
//   - Init-script wrappers around `getUserMedia`, `getCurrentPosition`,
//     etc. capture the request moment for `permissionRequests[]` AND let
//     `ask-human` block until the human responds (CDP setPermission has no
//     await-human integration).
//   - For `allow` the wrapper calls through (CDP already granted); for
//     `deny`/`raise` it throws (CDP denial backstops it if the wrapper is
//     somehow bypassed); for `ask-human` it consults the server, which blocks
//     until the human answers and then returns allow/deny.

import type { BrowserContext, Page } from "playwright-core";
import { log } from "../util/logging.js";

export type PolicyMode = "allow" | "deny" | "raise" | "ask-human";

/** Canonical name set for v1. Aligned with Playwright/Chromium permission names.
 *  USB/Bluetooth/HID are deliberately NOT in v1 (Phase 7's `device-emulation`).
 *  Re-exported in `permission_state` tool docs + tool-reference.md. */
export const SUPPORTED_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "clipboard-read",
  "clipboard-write",
  "midi",
  "midi-sysex",
  "payment-handler",
  "background-sync",
  "accelerometer",
  "gyroscope",
  "magnetometer",
] as const;
export type SupportedPermission = (typeof SUPPORTED_PERMISSIONS)[number];

/** Subset of names CDP `Browser.setPermission` accepts. Maps our canonical
 *  names to the CDP descriptor names (most are 1:1; midi vs midi-sysex,
 *  notifications vs background-sync etc. all match CDP's permission enum). */
const CDP_PERMISSION_NAME: Readonly<Record<SupportedPermission, string>> = {
  "camera": "videoCapture",
  "microphone": "audioCapture",
  "geolocation": "geolocation",
  "notifications": "notifications",
  "clipboard-read": "clipboardReadWrite",
  "clipboard-write": "clipboardSanitizedWrite",
  "midi": "midi",
  "midi-sysex": "midiSysex",
  "payment-handler": "paymentHandler",
  "background-sync": "backgroundSync",
  "accelerometer": "sensors",
  "gyroscope": "sensors",
  "magnetometer": "sensors",
};

/** Public, runtime-mutable shape. Top-level `mode` is the default; the
 *  per-permission override map wins when present. */
export interface PermissionPolicy {
  mode: PolicyMode;
  perPermission?: Partial<Record<SupportedPermission, PolicyMode>>;
}

/** One captured permission request, exposed on `ActionResult.permissionRequests[]`. */
export interface PermissionRecord {
  permission: SupportedPermission;
  /** origin of the page that made the request; undefined when not parseable. */
  origin?: string;
  /** What the server actually did. `"raised"` means the wrapper rejected
   *  AND the policy was `raise`, so the action will be marked failed. */
  handledAs: "allowed" | "denied" | "raised" | "asked-human";
  /** epoch ms — used by the action-window slice. */
  ts: number;
}

/** Hint emitted on `ActionResult.failure.hint` when `raise` mode fired.
 *  Stable, agent-facing string — referenced in docs/tool-reference.md. */
export const UNHANDLED_PERMISSION_HINT =
  "unhandled permission request — set permissionPolicy (open_session/set_permission_policy) " +
  "to \"allow\", \"deny\", or \"ask-human\" before driving an action that may trigger one. " +
  "The request was rejected page-side (NotAllowedError) so the page is not deadlocked, but " +
  "the app effect is the deny branch.";

/** BYOB warning surfaced when policy is set on `attached` sessions. CDP
 *  `Browser.setPermission` mutates the human's Chrome and is not cleanly
 *  revertable on detach — same posture class as the BYOB emulation warning. */
export const BYOB_PERMISSION_WARNING =
  "BYOB caveat: this permission policy is enforced via CDP `Browser.setPermission` " +
  "on an attached (not-owned) Chrome. The override PERSISTS on that browser after " +
  "browxai detaches; the human's Chrome must navigate / restart to fully clear it.";

/** Mutable per-session state. The page-side check binding reads `current(name)`
 *  on every request, so a `set_permission_policy` call takes effect on the
 *  very next request without page reload. */
export class PermissionPolicyState {
  private policy: PermissionPolicy;
  private buffer: PermissionRecord[] = [];
  /** Hard cap so a chatty page can't grow this without bound. The per-action
   *  slice is the only consumer — older records are noise. */
  private readonly cap: number;
  /** Contexts we've already installed the init-script + binding on. Idempotent
   *  install guard — BYOB reconnect / context rebuild MUST not double-wire. */
  private wired = new WeakSet<BrowserContext>();

  constructor(initial: PermissionPolicy = { mode: "raise" }, cap = 200) {
    this.policy = normalise(initial);
    this.cap = cap;
  }

  /** Resolved policy snapshot. */
  current(): PermissionPolicy {
    return { mode: this.policy.mode, ...(this.policy.perPermission ? { perPermission: { ...this.policy.perPermission } } : {}) };
  }

  /** Effective mode for a single permission — per-permission map wins, else
   *  top-level. Unknown permissions fall through to top-level (we still want
   *  a deterministic answer for whatever the page asked for). */
  modeFor(name: string): PolicyMode {
    const override = this.policy.perPermission?.[name as SupportedPermission];
    return override ?? this.policy.mode;
  }

  set(next: PermissionPolicy): PermissionPolicy {
    this.policy = normalise(next);
    return this.current();
  }

  /** Append a request record. Caps the buffer at `cap`. */
  record(rec: PermissionRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length > this.cap) this.buffer.shift();
  }

  /** Slice records with `ts >= since`. Used by the action-window. */
  since(since: number): PermissionRecord[] {
    return this.buffer.filter((r) => r.ts >= since);
  }

  /** True if any record in `[since, now]` was handled in `raise` mode.
   *  When true, the action-window flips the result to `ok:false`. */
  raisedSince(since: number): boolean {
    return this.buffer.some((r) => r.ts >= since && r.handledAs === "raised");
  }

  /** Has this context already been wired? Idempotent install guard. */
  hasContext(c: BrowserContext): boolean {
    return this.wired.has(c);
  }
  /** Mark a context as wired. */
  markContext(c: BrowserContext): void {
    this.wired.add(c);
  }
}

/** Idempotent normaliser. Rejects unknown top-level modes; per-permission map
 *  is validated per-entry (an unknown permission name in the map throws so the
 *  caller gets a fast error instead of silent fallthrough). */
function normalise(p: PermissionPolicy): PermissionPolicy {
  if (!isPolicyMode(p.mode)) {
    throw new Error(`permissionPolicy: invalid mode "${p.mode}" — expected "allow" | "deny" | "raise" | "ask-human"`);
  }
  if (p.perPermission) {
    const cleaned: Partial<Record<SupportedPermission, PolicyMode>> = {};
    for (const [name, mode] of Object.entries(p.perPermission)) {
      if (!SUPPORTED_PERMISSIONS.includes(name as SupportedPermission)) {
        throw new Error(
          `permissionPolicy.perPermission: unknown permission "${name}" — supported: ${SUPPORTED_PERMISSIONS.join(", ")}`,
        );
      }
      if (mode === undefined) continue;
      if (!isPolicyMode(mode)) {
        throw new Error(`permissionPolicy.perPermission["${name}"]: invalid mode "${mode}" — expected "allow" | "deny" | "raise" | "ask-human"`);
      }
      cleaned[name as SupportedPermission] = mode;
    }
    return { mode: p.mode, perPermission: cleaned };
  }
  return { mode: p.mode };
}

function isPolicyMode(m: unknown): m is PolicyMode {
  return m === "allow" || m === "deny" || m === "raise" || m === "ask-human";
}

/** Parse the spec's compact string form for the top-level mode, or accept the
 *  object form. Idempotent. */
export function parsePermissionPolicyArg(
  v: string | PermissionPolicy | undefined,
): PermissionPolicy {
  if (!v) return { mode: "raise" };
  if (typeof v === "object") return normalise(v);
  if (isPolicyMode(v)) return { mode: v };
  throw new Error(
    `permissionPolicy: invalid value "${v}" — expected "allow" | "deny" | "raise" | "ask-human"`,
  );
}

/** Map a canonical permission name to the CDP `Browser.setPermission`
 *  descriptor name. */
export function cdpPermissionName(p: SupportedPermission): string {
  return CDP_PERMISSION_NAME[p];
}

/** Compute the CDP setting (granted/denied) for a permission given the active
 *  policy. `raise` / `deny` → "denied"; `allow` → "granted"; `ask-human` →
 *  "prompt" (CDP returns to the page-script wrapper which then asks the human).
 *
 *  Kept as a pure function so registry.test.ts can assert the mapping without
 *  launching Chromium. */
export function cdpSettingFor(mode: PolicyMode): "granted" | "denied" | "prompt" {
  switch (mode) {
    case "allow": return "granted";
    case "ask-human": return "prompt";
    case "deny":
    case "raise":
    default: return "denied";
  }
}

/** Bridge callback type. The server-side binding wires this to await-human
 *  (when the policy is `ask-human`); the page-side wrapper script consults it
 *  before deciding whether to call through. Returns the decision the wrapper
 *  should enact: `"allow"` calls through, `"deny"` throws NotAllowedError. */
export type PermissionAskHandler = (
  permission: SupportedPermission,
  origin: string | undefined,
) => Promise<"allow" | "deny">;

/** Init script that wraps the page-side permission APIs. Stringified so it can
 *  be passed to `addInitScript` and `page.evaluate`. Keep browser-only JS — no
 *  TS-only syntax. Re-injected on `framenavigated` (idempotent: guards on
 *  `window.__browx_permission_installed`).
 *
 *  The wrappers consult `window.__browx_permission_check({permission, origin})`
 *  (an exposeBinding callable from page context) — it returns `"allow" |
 *  "deny"`. The server's binding implementation records the request + (for
 *  `ask-human`) blocks on the bridge before answering. */
export const PERMISSION_PAGE_SCRIPT = `(() => {
  if (window.__browx_permission_installed) return;
  window.__browx_permission_installed = true;
  // Detect whether the exposeBinding is available. If not (BYOB multi-attach
  // clobber, or the binding install failed), the wrappers fall back to
  // call-through — the CDP setPermission baseline still enforces grant/deny.
  function check(permission) {
    try {
      if (typeof window.__browx_permission_check === "function") {
        return Promise.resolve(window.__browx_permission_check(JSON.stringify({
          permission: permission, origin: location.origin,
        })));
      }
    } catch (_) {}
    return Promise.resolve("allow");
  }
  function notAllowed(msg) {
    var e = new Error(msg || "permission denied by browxai permissionPolicy");
    try { e.name = "NotAllowedError"; } catch (_) {}
    return e;
  }

  // --- navigator.mediaDevices.getUserMedia (camera + microphone) ---
  try {
    var md = navigator.mediaDevices;
    if (md && typeof md.getUserMedia === "function") {
      var origGUM = md.getUserMedia.bind(md);
      md.getUserMedia = function (constraints) {
        var wantsVideo = !!(constraints && constraints.video);
        var wantsAudio = !!(constraints && constraints.audio);
        var perm = wantsVideo ? "camera" : (wantsAudio ? "microphone" : "camera");
        return check(perm).then(function (decision) {
          if (decision === "deny") return Promise.reject(notAllowed("Permission denied"));
          return origGUM(constraints);
        });
      };
    }
  } catch (_) {}

  // --- navigator.geolocation (getCurrentPosition + watchPosition) ---
  // watchPosition is long-lived (the callback may fire many times) — we gate
  // the *initial* permission check at watch-installation time, then if allowed
  // pass through to the native API which itself manages the callback stream.
  try {
    var geo = navigator.geolocation;
    if (geo && typeof geo.getCurrentPosition === "function") {
      var origGet = geo.getCurrentPosition.bind(geo);
      geo.getCurrentPosition = function (success, error, options) {
        check("geolocation").then(function (decision) {
          if (decision === "deny") {
            if (typeof error === "function") {
              try { error({ code: 1, message: "User denied geolocation", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); } catch (_) {}
            }
            return;
          }
          try { origGet(success, error, options); } catch (e) {
            if (typeof error === "function") { try { error(e); } catch (_) {} }
          }
        });
      };
    }
    if (geo && typeof geo.watchPosition === "function") {
      var origWatch = geo.watchPosition.bind(geo);
      // Return a synthetic watch id when denied so callers calling
      // clearWatch(id) still see a valid (no-op) integer. Native ids are
      // small positive integers; we use negatives starting at -1 to avoid
      // colliding with any in-flight native watch.
      var synthCounter = 0;
      geo.watchPosition = function (success, error, options) {
        var pending = true;
        var synthId = --synthCounter;
        check("geolocation").then(function (decision) {
          pending = false;
          if (decision === "deny") {
            if (typeof error === "function") {
              try { error({ code: 1, message: "User denied geolocation", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }); } catch (_) {}
            }
            return;
          }
          // Allowed — install the native watch. We've already returned the
          // synthetic id to the caller; the native id is held internally and
          // proxied through clearWatch below.
          try {
            var nativeId = origWatch(success, error, options);
            geo.__browx_watch_map = geo.__browx_watch_map || {};
            geo.__browx_watch_map[synthId] = nativeId;
          } catch (e) {
            if (typeof error === "function") { try { error(e); } catch (_) {} }
          }
        });
        return synthId;
      };
      var origClear = typeof geo.clearWatch === "function" ? geo.clearWatch.bind(geo) : null;
      if (origClear) {
        geo.clearWatch = function (id) {
          var map = geo.__browx_watch_map || {};
          if (id in map) {
            try { origClear(map[id]); } catch (_) {}
            delete map[id];
            return;
          }
          try { origClear(id); } catch (_) {}
        };
      }
    }
  } catch (_) {}

  // --- Notification.requestPermission ---
  try {
    if (typeof Notification !== "undefined" && typeof Notification.requestPermission === "function") {
      var origReq = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = function (cb) {
        return check("notifications").then(function (decision) {
          var result = decision === "deny" ? "denied" : "granted";
          if (decision === "deny") {
            try { Object.defineProperty(Notification, "permission", { get: function () { return "denied"; }, configurable: true }); } catch (_) {}
            if (typeof cb === "function") { try { cb(result); } catch (_) {} }
            return result;
          }
          // Allowed — delegate to native; the CDP setPermission baseline has
          // already pre-granted, so the native call resolves immediately.
          try {
            var r = origReq(cb);
            return r && typeof r.then === "function" ? r : Promise.resolve(result);
          } catch (_) {
            return result;
          }
        });
      };
    }
  } catch (_) {}

  // --- navigator.clipboard (read / write / readText / writeText) ---
  try {
    var clip = navigator.clipboard;
    if (clip) {
      var wrap = function (name, perm) {
        var orig = typeof clip[name] === "function" ? clip[name].bind(clip) : null;
        if (!orig) return;
        clip[name] = function () {
          var args = arguments;
          return check(perm).then(function (decision) {
            if (decision === "deny") return Promise.reject(notAllowed("Clipboard " + name + " denied"));
            return orig.apply(null, args);
          });
        };
      };
      wrap("read", "clipboard-read");
      wrap("readText", "clipboard-read");
      wrap("write", "clipboard-write");
      wrap("writeText", "clipboard-write");
    }
  } catch (_) {}

  // --- navigator.permissions.query — read-side. Force the wrapper's view of
  // state through us so a query() honoured a "raise" policy returns "denied"
  // (matching the wrapper rejection) and a "ask-human" returns "prompt" (the
  // native query would otherwise see the CDP "prompt" setting and skip our
  // recording). Falls back to native when the queried name isn't one we govern.
  try {
    var permsApi = navigator.permissions;
    if (permsApi && typeof permsApi.query === "function") {
      var origQuery = permsApi.query.bind(permsApi);
      permsApi.query = function (desc) {
        var name = desc && desc.name;
        // pass through to native — we don't override the query result, just
        // record that the page asked, so the next ActionResult shows it. The
        // native value still reflects the CDP-set state (granted/denied/prompt).
        if (typeof window.__browx_permission_observe === "function") {
          try { window.__browx_permission_observe(JSON.stringify({ permission: name, origin: location.origin })); } catch (_) {}
        }
        return origQuery(desc);
      };
    }
  } catch (_) {}
})();`;

/** Server-side wire-up. Installs:
 *   - `__browx_permission_check` exposeBinding: synchronous-from-page consult
 *     that records the request, runs the ask-human handler if the policy is
 *     `ask-human`, and returns the resolved decision (`"allow"` / `"deny"`).
 *   - `__browx_permission_observe` exposeBinding: read-side notice that the
 *     page called `navigator.permissions.query` (no decision returned).
 *   - The page-side init script (see above), re-injected by Playwright on
 *     every new document via `addInitScript`.
 *
 * Idempotent on the same context (the state's `WeakSet<BrowserContext>` guard).
 * Errors during install are logged and swallowed — the CDP setPermission baseline
 * still enforces grant/deny even when the in-page wrappers fail to wire.
 */
export async function attachPermissionPolicy(
  context: BrowserContext,
  state: PermissionPolicyState,
  askHandler: PermissionAskHandler,
): Promise<void> {
  if (state.hasContext(context)) return;
  state.markContext(context);

  // exposeBinding — synchronous-from-page from Playwright's perspective:
  // page-side awaits the Promise the binding returns. Errors thrown here
  // bubble back to the page as a rejected promise; the wrapper script catches
  // and falls back to "allow" (CDP backstop still enforces).
  try {
    await context.exposeBinding("__browx_permission_check", async (_source, payload: string) => {
      try {
        const o = JSON.parse(payload) as { permission?: string; origin?: string };
        const name = o.permission;
        const origin = o.origin;
        const cdpName = name && SUPPORTED_PERMISSIONS.includes(name as SupportedPermission)
          ? (name as SupportedPermission) : undefined;
        if (!cdpName) {
          // Unknown permission name — record under "geolocation" sentinel? No:
          // just allow through. Anything outside the v1 set is best-effort.
          return "allow";
        }
        const mode = state.modeFor(cdpName);
        const ts = Date.now();
        switch (mode) {
          case "allow":
            state.record({ permission: cdpName, origin, handledAs: "allowed", ts });
            return "allow";
          case "deny":
            state.record({ permission: cdpName, origin, handledAs: "denied", ts });
            return "deny";
          case "ask-human": {
            const decision = await askHandler(cdpName, origin).catch(() => "deny" as const);
            state.record({ permission: cdpName, origin, handledAs: "asked-human", ts });
            return decision;
          }
          case "raise":
          default:
            state.record({ permission: cdpName, origin, handledAs: "raised", ts });
            return "deny";
        }
      } catch (err) {
        log.warn("session.permission: check handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return "allow";
      }
    });
    await context.exposeBinding("__browx_permission_observe", async (_source, _payload: string) => {
      // Read-side breadcrumb only — no decision, no record (the page calling
      // permissions.query() is too noisy to record per-call).
      return undefined;
    });
  } catch (err) {
    log.warn("session.permission: exposeBinding install failed; CDP baseline still enforces", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Init-script — Playwright re-runs it on every new document, including the
  // post-`framenavigated` reload of the same page. Idempotent via the
  // `__browx_permission_installed` guard inside the script.
  try {
    await context.addInitScript({ content: PERMISSION_PAGE_SCRIPT });
    for (const page of context.pages()) {
      await page.evaluate(PERMISSION_PAGE_SCRIPT).catch(() => undefined);
    }
  } catch (err) {
    log.warn("session.permission: addInitScript failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Apply the policy's baseline by computing the set of permissions that should
 *  be GRANTED (mode `allow`) and routing them through Playwright's
 *  `context.grantPermissions`. Permissions in `deny`/`raise`/`ask-human` are
 *  NOT granted — the in-page wrapper rejects them at request time before the
 *  native code runs.
 *
 *  Why not CDP `Browser.setPermission` directly: the underlying CDP method
 *  takes a W3C PermissionDescriptor name (e.g. `geolocation`, `camera`) and
 *  the descriptor schema varies by Chromium build. Playwright's
 *  `grantPermissions` carries the canonical mapping (see Playwright's
 *  `webPermissionToProtocol`) and falls back across Chromium versions —
 *  delegating means we don't have to track the protocol versions ourselves.
 *
 *  Note: `clearPermissions` first then `grantPermissions` is the Playwright
 *  idiom for "REPLACE the granted set" (the underlying CDP call is
 *  `Browser.resetPermissions` + `Browser.grantPermissions`). Both are
 *  context-wide on Chromium so the policy applies to every page.
 *
 *  Best-effort: errors are logged and don't throw — the in-page wrapper still
 *  enforces grant/deny even if the baseline application fails. Re-applied on
 *  `set_permission_policy` and re-attach paths. */
export async function applyCdpBaseline(
  context: BrowserContext,
  state: PermissionPolicyState,
): Promise<void> {
  const allowList: string[] = [];
  for (const name of SUPPORTED_PERMISSIONS) {
    if (state.modeFor(name) === "allow") allowList.push(name);
  }
  try {
    // Clear first so a previous policy's grants don't leak when the next
    // policy reduces the allow list.
    await context.clearPermissions();
  } catch (err) {
    log.warn("session.permission: clearPermissions failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (allowList.length === 0) return;
  try {
    await context.grantPermissions(allowList);
  } catch (err) {
    log.warn("session.permission: grantPermissions failed", {
      permissions: allowList,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read-side via the page's native `navigator.permissions.query` (W3C
 *  Permissions API). Returns `{ [name]: "granted"|"denied"|"prompt"|"unknown" }`.
 *  Per-permission errors populate the entry with `"unknown"` so the caller
 *  sees a deterministic shape.
 *
 *  Why the Permissions API and not CDP `Browser.getPermissionState`: the CDP
 *  method's PermissionDescriptor schema varies across Chromium builds and
 *  several of our supported names (e.g. `clipboard-write` → `clipboardSan…`)
 *  don't map cleanly. The Permissions API takes the canonical web spec name
 *  directly and is supported across versions. The state it reports reflects
 *  whatever the CDP-level baseline set, so it's the right read-side mirror
 *  for `applyCdpBaseline`.
 *
 *  Note: the in-page wrapper script is a no-op for query() (passes through);
 *  it doesn't override the resulting state, so this read is the canonical
 *  browser-reported state, not a wrapper-side guess. */
export async function readPermissionStates(
  context: BrowserContext,
  page: Page,
  names: SupportedPermission[],
  origin?: string,
): Promise<Record<string, "granted" | "denied" | "prompt" | "unknown">> {
  const out: Record<string, "granted" | "denied" | "prompt" | "unknown"> = {};
  // origin parameter: for now we only support querying the current page's
  // origin (Permissions API has no cross-origin query). When origin is set
  // but doesn't match the page, return unknown for the whole set — the
  // caller can navigate / open a new tab if they need cross-origin state.
  if (origin) {
    try {
      const pageOrigin = new URL(page.url()).origin;
      if (pageOrigin !== origin) {
        for (const n of names) out[n] = "unknown";
        return out;
      }
    } catch {
      for (const n of names) out[n] = "unknown";
      return out;
    }
  }
  void context; // signature-compat: takes context so a future cross-origin
                // CDP path can adopt it without breaking callers.
  for (const n of names) {
    try {
      const state = await page.evaluate(async (perm: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const navAny = (globalThis as any).navigator;
          if (!navAny?.permissions?.query) return "unknown";
          const res = await navAny.permissions.query({ name: perm });
          return res?.state ?? "unknown";
        } catch {
          return "unknown";
        }
      }, n).catch(() => "unknown" as string);
      out[n] = (state === "granted" || state === "denied" || state === "prompt") ? state : "unknown";
    } catch {
      out[n] = "unknown";
    }
  }
  return out;
}
