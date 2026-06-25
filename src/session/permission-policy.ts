// Node-side policy state for the per-session permission policy (realm 1 of 3:
// the class holding the per-session decision state, plus the pure types /
// validators / CDP-name mappings it owns). Sibling of `dialog_policy`. Plugs
// the runtime-permission blind spot: camera / microphone / geolocation /
// clipboard / notification (and the long tail of sensor permissions) requests
// fire from the page asynchronously; without a server-side interceptor the
// request either silently sits forever (default Chromium policy in headless:
// "denied" via no user-gesture infobar) or — worse — pre-grants from
// `grant_permissions` change app behavior silently. This module wires a
// four-mode policy mirroring `dialog_policy`'s posture:
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

import type { BrowserContext } from "playwright-core";
import { PolicyRecordBuffer } from "./policy-buffer.js";

export type PolicyMode = "allow" | "deny" | "raise" | "ask-human";

/** Canonical name set for v1. Aligned with Playwright/Chromium permission names.
 *  USB/Bluetooth/HID are deliberately NOT in v1 ('s `device-emulation`).
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
  camera: "videoCapture",
  microphone: "audioCapture",
  geolocation: "geolocation",
  notifications: "notifications",
  "clipboard-read": "clipboardReadWrite",
  "clipboard-write": "clipboardSanitizedWrite",
  midi: "midi",
  "midi-sysex": "midiSysex",
  "payment-handler": "paymentHandler",
  "background-sync": "backgroundSync",
  accelerometer: "sensors",
  gyroscope: "sensors",
  magnetometer: "sensors",
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
  'to "allow", "deny", or "ask-human" before driving an action that may trigger one. ' +
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
  /** Bounded record ring (shared `PolicyRecordBuffer` — the hard cap so a chatty
   *  page can't grow this without bound; the per-action slice is the only
   *  consumer, older records are noise). */
  private readonly records: PolicyRecordBuffer<PermissionRecord>;
  /** Contexts we've already installed the init-script + binding on. Idempotent
   *  install guard — BYOB reconnect / context rebuild MUST not double-wire. */
  private wired = new WeakSet<BrowserContext>();

  constructor(initial: PermissionPolicy = { mode: "raise" }, cap = 200) {
    this.policy = normalise(initial);
    this.records = new PolicyRecordBuffer<PermissionRecord>(cap);
  }

  /** Resolved policy snapshot. */
  current(): PermissionPolicy {
    return {
      mode: this.policy.mode,
      ...(this.policy.perPermission ? { perPermission: { ...this.policy.perPermission } } : {}),
    };
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
    this.records.record(rec);
  }

  /** Slice records with `ts >= since`. Used by the action-window. */
  since(since: number): PermissionRecord[] {
    return this.records.since(since);
  }

  /** True if any record in `[since, now]` was handled in `raise` mode.
   *  When true, the action-window flips the result to `ok:false`. */
  raisedSince(since: number): boolean {
    return this.records.matchedSince(since, (r) => r.handledAs === "raised");
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
    throw new Error(
      `permissionPolicy: invalid mode "${String(p.mode)}" — expected "allow" | "deny" | "raise" | "ask-human"`,
    );
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
        throw new Error(
          `permissionPolicy.perPermission["${name}"]: invalid mode "${String(mode)}" — expected "allow" | "deny" | "raise" | "ask-human"`,
        );
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
    case "allow":
      return "granted";
    case "ask-human":
      return "prompt";
    case "deny":
    case "raise":
    default:
      return "denied";
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
