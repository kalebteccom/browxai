// Per-session notification policy — Node-side decision state. Realm (1) of the
// notification policy: the per-session state class plus the policy types,
// parsing/normalisation, and the sync-decision derivation the attach adapter
// seeds into the page. Sibling of `permission_policy`. Plugs the
// `new Notification(title, opts)` blind spot.
//
// Why a separate policy from `permission_policy.notifications`:
//
//   - `permission_policy.notifications` governs the W3C *permission* check —
//     `Notification.requestPermission()` and the `Notification.permission`
//     state-getter. That tells the page whether it MAY display notifications.
//   - `notification_policy` governs the *constructor invocation* —
//     `new Notification(title, opts)`. The constructor only succeeds when
//     permission is granted (browser-policy), but its construction is the
//     observability event: it's what the page actually does when it tries to
//     notify the human. Pre-v0.5.0 browxai had no visibility into these
//     calls; an action that fired three notifications was indistinguishable
//     from one that fired zero.
//
// The two policies compose:
//
//   - `permission_policy.notifications: "allow"`  + `notification_policy: "allow"` →
//     the page can construct + display, every construct is captured on
//     `ActionResult.notifications[]`.
//   - `permission_policy.notifications: "deny"`   + `notification_policy: "allow"` →
//     the page sees `Notification.permission === "denied"` and most apps don't
//     call the constructor at all; but if they do, the constructor still throws
//     a `NotAllowedError` (browser-policy) and we capture the attempted call.
//   - `permission_policy.notifications: "allow"`  + `notification_policy: "deny"` →
//     the constructor throws `NotAllowedError` (our policy) before the OS-level
//     notification fires. The page sees permission is granted but the
//     constructor surface refuses. Use when you want to observe + suppress.
//
// Modes mirror `permission_policy`'s posture:
//
//   - "allow"     — DEFAULT (browser default). Constructor proceeds normally;
//                   the OS displays per its own settings. Every call captured
//                   as `handledAs:"allowed"`. Matches the browser's
//                   pre-instrumentation behaviour so adopters can turn this
//                   on without breaking apps that expect notifications.
//   - "deny"      — Constructor throws `NotAllowedError` (the same exception
//                   the browser raises when permission is denied). Recorded
//                   as `handledAs:"denied"`. Use to suppress OS notifications
//                   while still observing what the page would have shown.
//   - "raise"     — Constructor throws + recorded as `handledAs:"raised"`.
//                   The next `ActionResult` flips `ok:false` with a stable
//                   hint pointing at `set_notification_policy`. Symmetric to
//                   `permission_policy`'s `raise` — useful when an agent
//                   wants notifications to be a hard signal that the action
//                   triggered an unexpected user-facing event.
//   - "ask-human" — Constructor blocks on `await_human({kind:"confirm"})`
//                   (the `__browx.confirm(true|false)` mechanism) and
//                   proceeds or throws per the human's answer. The
//                   constructor call returns synchronously in the browser
//                   spec, so we serialise the await via the same
//                   page-side promise pattern as `permission_policy`.
//                   NOTE: the constructor surface in the page must observe a
//                   synchronous return from `new Notification(...)`. Our
//                   wrapper returns a stub that satisfies the typeof check,
//                   but the actual native notification is only fired *after*
//                   the human-decision resolves — so apps that read
//                   `notification.close()` immediately will observe a no-op
//                   stub. Documented in the docs/tool-reference.md entry.

import type { BrowserContext } from "playwright-core";
import { PolicyRecordBuffer } from "./policy-buffer.js";

export type NotificationPolicyMode = "allow" | "deny" | "raise" | "ask-human";

/** Public, runtime-mutable shape. */
export interface NotificationPolicy {
  mode: NotificationPolicyMode;
}

/** One captured `new Notification(...)` call, exposed on
 *  `ActionResult.notifications[]`. */
export interface NotificationRecord {
  /** Notification title — first argument to the constructor. */
  title: string;
  /** Optional fields from the constructor's `options` bag (`NotificationOptions`).
   *  Only the small documented subset is captured (body / icon / tag) — the
   *  full spec has actions/data/badge/etc but those are rarely useful in
   *  observability and bloat the result envelope. */
  body?: string;
  icon?: string;
  tag?: string;
  /** epoch ms — used by the action-window slice. */
  timestamp: number;
  /** origin of the page that constructed it; undefined when not parseable. */
  origin?: string;
  /** What the server actually did. `"raised"` means the wrapper threw AND
   *  the policy was `raise`, so the action will be marked failed. */
  handledAs: "allowed" | "denied" | "raised" | "asked-human";
}

/** Hint emitted on `ActionResult.failure.hint` when `raise` mode fired.
 *  Stable, agent-facing string — referenced in docs/tool-reference.md. */
export const UNHANDLED_NOTIFICATION_HINT =
  "unhandled notification — set notificationPolicy (open_session/set_notification_policy) " +
  'to "allow", "deny", or "ask-human" before driving an action that may construct ' +
  "a Notification. The constructor was rejected page-side (NotAllowedError) so the page " +
  "is not deadlocked, but the app effect is the deny branch.";

/** Mutable per-session state. The page-side check binding reads `current()`
 *  on every constructor call, so a `set_notification_policy` call takes effect
 *  on the very next construction without page reload. */
export class NotificationPolicyState {
  private policy: NotificationPolicy;
  /** Bounded record ring (shared `PolicyRecordBuffer`; the hard cap so a chatty
   *  page can't grow this without bound). `NotificationRecord` carries its
   *  timestamp as `timestamp`, so the buffer reads it via an explicit extractor. */
  private readonly records: PolicyRecordBuffer<NotificationRecord>;
  /** Contexts we've already installed the init-script + binding on. */
  private wired = new WeakSet<BrowserContext>();

  constructor(initial: NotificationPolicy = { mode: "allow" }, cap = 200) {
    this.policy = normalise(initial);
    this.records = new PolicyRecordBuffer<NotificationRecord>(cap, (r) => r.timestamp);
  }

  /** Resolved policy snapshot. */
  current(): NotificationPolicy {
    return { mode: this.policy.mode };
  }

  set(next: NotificationPolicy): NotificationPolicy {
    this.policy = normalise(next);
    return this.current();
  }

  /** Append a record. Caps the buffer at `cap`. */
  record(rec: NotificationRecord): void {
    this.records.record(rec);
  }

  /** Slice records with `timestamp >= since`. Used by the action-window. */
  since(since: number): NotificationRecord[] {
    return this.records.since(since);
  }

  /** True if any record in `[since, now]` was handled in `raise` mode. */
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

function normalise(p: NotificationPolicy): NotificationPolicy {
  if (!isPolicyMode(p.mode)) {
    throw new Error(
      `notificationPolicy: invalid mode "${String(p.mode)}" — expected "allow" | "deny" | "raise" | "ask-human"`,
    );
  }
  return { mode: p.mode };
}

function isPolicyMode(m: unknown): m is NotificationPolicyMode {
  return m === "allow" || m === "deny" || m === "raise" || m === "ask-human";
}

/** Parse the spec's compact string form for the top-level mode, or accept the
 *  object form. Idempotent. */
export function parseNotificationPolicyArg(
  v: string | NotificationPolicy | undefined,
): NotificationPolicy {
  if (!v) return { mode: "allow" };
  if (typeof v === "object") return normalise(v);
  if (isPolicyMode(v)) return { mode: v };
  throw new Error(
    `notificationPolicy: invalid value "${v}" — expected "allow" | "deny" | "raise" | "ask-human"`,
  );
}

/** Bridge callback type. The server-side binding wires this to await-human
 *  (when the policy is `ask-human`); the page-side wrapper script consults it
 *  before deciding whether to call through. Returns the decision the wrapper
 *  should enact: `"allow"` calls through, `"deny"` throws NotAllowedError. */
export type NotificationAskHandler = (payload: {
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
  origin?: string;
}) => Promise<"allow" | "deny">;

/** Compute the sync decision the constructor wrapper inspects to know
 *  whether to throw synchronously. `allow` and `ask-human` BOTH yield
 *  `"allow"` here: ask-human's constructor surface is non-throwing (we
 *  return the stub and only dispatch the real notification once the human
 *  answers). `deny` and `raise` throw at construction time. */
export function syncDecisionFor(mode: NotificationPolicyMode): "allow" | "deny" | "raise" {
  switch (mode) {
    case "deny":
      return "deny";
    case "raise":
      return "raise";
    case "allow":
    case "ask-human":
    default:
      return "allow";
  }
}

/** Read-side: snapshot the current policy + recent records for the session.
 *  Used by tests and (potentially) a future `notification_state` tool. */
export function readNotifications(
  state: NotificationPolicyState,
  since = 0,
): { policy: NotificationPolicy; records: NotificationRecord[] } {
  return { policy: state.current(), records: state.since(since) };
}
