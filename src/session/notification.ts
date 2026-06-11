// Per-session notification policy. Sibling of `permission_policy`. Plugs the
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
//
// Init-script wraps the global `Notification` constructor (and preserves the
// static `requestPermission` / `permission` getters so the `permission_policy`
// wrappers — already injected by `session/permission.ts` — keep working
// untouched). The two policies compose; coordination is by-construction:
// `permission_policy` only touches `Notification.requestPermission`, this
// module only touches `new Notification(...)`.

import type { BrowserContext } from "playwright-core";
import { log } from "../util/logging.js";

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
  private buffer: NotificationRecord[] = [];
  /** Hard cap so a chatty page can't grow this without bound. */
  private readonly cap: number;
  /** Contexts we've already installed the init-script + binding on. */
  private wired = new WeakSet<BrowserContext>();

  constructor(initial: NotificationPolicy = { mode: "allow" }, cap = 200) {
    this.policy = normalise(initial);
    this.cap = cap;
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
    this.buffer.push(rec);
    if (this.buffer.length > this.cap) this.buffer.shift();
  }

  /** Slice records with `timestamp >= since`. Used by the action-window. */
  since(since: number): NotificationRecord[] {
    return this.buffer.filter((r) => r.timestamp >= since);
  }

  /** True if any record in `[since, now]` was handled in `raise` mode. */
  raisedSince(since: number): boolean {
    return this.buffer.some((r) => r.timestamp >= since && r.handledAs === "raised");
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

/** Init script that wraps the page-side `Notification` constructor. Stringified
 *  so it can be passed to `addInitScript` and `page.evaluate`. Browser-only JS
 *  — no TS syntax. Re-injected on `framenavigated` (idempotent: guards on
 *  `window.__browx_notification_installed`).
 *
 *  The wrapper consults `window.__browx_notification_check({title, body, …})`
 *  (an exposeBinding callable from page context) — it returns `"allow" |
 *  "deny"`. The server's binding implementation records the construction +
 *  (for `ask-human`) blocks on the bridge before answering.
 *
 *  IMPORTANT: this script does NOT touch `Notification.requestPermission` or
 *  the `Notification.permission` static getter — those are owned by
 *  `session/permission.ts` (permission_policy). Coordination is by-
 *  construction: each script owns disjoint surface area. */
export const NOTIFICATION_PAGE_SCRIPT = `(() => {
  if (window.__browx_notification_installed) return;
  if (typeof Notification === "undefined") return;
  window.__browx_notification_installed = true;

  var OrigNotification = Notification;

  function check(payload) {
    try {
      if (typeof window.__browx_notification_check === "function") {
        return Promise.resolve(window.__browx_notification_check(JSON.stringify(payload)));
      }
    } catch (_) {}
    return Promise.resolve("allow");
  }
  function notAllowed(msg) {
    var e = new Error(msg || "notification denied by browxai notificationPolicy");
    try { e.name = "NotAllowedError"; } catch (_) {}
    return e;
  }

  // The constructed instance is a plain object whose prototype is set to
  // \`OrigNotification.prototype\` AFTER own-property assignment, so
  // accessor-only props on the platform prototype (\`title\`, \`body\`, etc.)
  // don't intercept our \`this.title = ...\` writes. (Setting them via
  // assignment with the prototype already in place throws TypeError in
  // headless Chromium — \`Notification.prototype.title\` is getter-only.)
  function ProxyNotification(title, options) {
    var safeTitle = String(title);
    var payload = {
      title: safeTitle,
      body: (options && options.body) || undefined,
      icon: (options && options.icon) || undefined,
      tag: (options && options.tag) || undefined,
      origin: location.origin,
    };

    // SYNC throw timing — read the pre-seeded decision hint. Spec requires
    // \`new Notification(...)\` to throw synchronously on failure. The async
    // \`check()\` below still records the call (and does the ask-human dance);
    // the sync hint is purely for the throw timing.
    var syncDecision = (typeof window.__browx_notification_sync_decision === "string")
      ? window.__browx_notification_sync_decision
      : "allow";
    if (syncDecision === "deny" || syncDecision === "raise") {
      // Still record the attempt before throwing.
      try { check(payload); } catch (_) {}
      throw notAllowed(syncDecision === "raise"
        ? "notification raised — set notificationPolicy"
        : "Notification denied by browxai notificationPolicy");
    }

    // Build the stub-as-this. Own data properties first; THEN set the
    // prototype so getter-only inherited accessors don't intercept writes.
    var listeners = {};
    var realRef = null;
    var pendingClose = false;
    Object.defineProperty(this, "title", { value: safeTitle, writable: true, configurable: true, enumerable: true });
    Object.defineProperty(this, "body",  { value: (options && options.body) || "", writable: true, configurable: true, enumerable: true });
    Object.defineProperty(this, "icon",  { value: (options && options.icon) || "", writable: true, configurable: true, enumerable: true });
    Object.defineProperty(this, "tag",   { value: (options && options.tag)  || "", writable: true, configurable: true, enumerable: true });
    Object.defineProperty(this, "data",  { value: (options && options.data) !== undefined ? options.data : null, writable: true, configurable: true, enumerable: true });
    var self = this;
    Object.defineProperty(this, "close", { value: function () {
      if (realRef) { try { realRef.close(); } catch (_) {} return; }
      pendingClose = true;
    }, writable: true, configurable: true });
    Object.defineProperty(this, "addEventListener", { value: function (ev, cb) {
      (listeners[ev] = listeners[ev] || []).push(cb);
      if (realRef && realRef.addEventListener) { try { realRef.addEventListener(ev, cb); } catch (_) {} }
    }, writable: true, configurable: true });
    Object.defineProperty(this, "removeEventListener", { value: function (ev, cb) {
      var arr = listeners[ev]; if (!arr) return;
      var i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1);
      if (realRef && realRef.removeEventListener) { try { realRef.removeEventListener(ev, cb); } catch (_) {} }
    }, writable: true, configurable: true });

    // ask-human / allow: dispatch the policy check + (if allowed) construct
    // the real native Notification and route the page's listeners to it.
    check(payload).then(function (decision) {
      if (decision !== "allow") return;
      try {
        var real = new OrigNotification(safeTitle, options || {});
        realRef = real;
        for (var ev in listeners) {
          if (!Object.prototype.hasOwnProperty.call(listeners, ev)) continue;
          for (var i = 0; i < listeners[ev].length; i++) {
            try { real.addEventListener(ev, listeners[ev][i]); } catch (_) {}
          }
        }
        if (pendingClose) { try { real.close(); } catch (_) {} }
      } catch (_) {
        // Browser refused (e.g. \`Notification.permission === "denied"\`
        // because permission_policy denied). The stub remains a no-op,
        // matching the deny branch.
      }
    });

    void self; // referenced via closure above
  }
  // Use a fresh prototype object — NOT \`OrigNotification.prototype\`, whose
  // accessor-only properties (\`title\`, \`body\`, \`tag\`, etc.) would intercept
  // our writes on \`this\` via the prototype chain (\`TypeError: Cannot set
  // property title of #<Notification> which has only a getter\` in headless
  // Chromium). Trade-off: \`instanceof Notification\` returns false for our
  // stub; apps rarely runtime-check that, and the alternative (overriding
  // the platform prototype's accessors) is messier + version-fragile.
  ProxyNotification.prototype = {};
  // Preserve the static surface — permission_policy owns these. Forward
  // every static read/write to the original constructor so the existing
  // \`permission_policy\` wrapper script still wraps \`requestPermission\` /
  // observes \`permission\` unchanged.
  try {
    Object.defineProperty(ProxyNotification, "permission", {
      get: function () { return OrigNotification.permission; },
      configurable: true,
    });
  } catch (_) {}
  ProxyNotification.requestPermission = function () {
    return OrigNotification.requestPermission.apply(OrigNotification, arguments);
  };
  try { ProxyNotification.maxActions = OrigNotification.maxActions; } catch (_) {}

  try {
    // Replace the global. Some browsers refuse to delete \`Notification\` on
    // \`window\` (it's a configurable: false property in newer specs); fall
    // back to a defineProperty assignment if direct assignment is silent.
    window.Notification = ProxyNotification;
    if (window.Notification !== ProxyNotification) {
      Object.defineProperty(window, "Notification", {
        value: ProxyNotification, writable: true, configurable: true,
      });
    }
  } catch (_) {}
})();`;

/** Server-side wire-up. Installs:
 *   - `__browx_notification_check` exposeBinding: page-side records +
 *     ask-human resolves to allow/deny via the bridge.
 *   - The page-side init script (above), re-injected by Playwright on every
 *     new document via `addInitScript`.
 *   - Seeds the SYNCHRONOUS decision hint
 *     (`window.__browx_notification_sync_decision`) on every wired page so
 *     the constructor wrapper can throw without awaiting a binding round-
 *     trip; refreshed on `set_notification_policy` via
 *     `propagateSyncDecision`.
 *
 * Idempotent on the same context (the state's `WeakSet<BrowserContext>` guard).
 * Errors during install are logged and swallowed — when bindings fail the
 * wrapper falls back to call-through (browser default).
 */
export async function attachNotificationPolicy(
  context: BrowserContext,
  state: NotificationPolicyState,
  askHandler: NotificationAskHandler,
): Promise<void> {
  if (state.hasContext(context)) return;
  state.markContext(context);

  try {
    await context.exposeBinding("__browx_notification_check", async (_source, payload: string) => {
      try {
        const o = JSON.parse(payload) as {
          title?: string;
          body?: string;
          icon?: string;
          tag?: string;
          origin?: string;
        };
        const title = String(o.title ?? "");
        const origin = o.origin;
        const mode = state.current().mode;
        const ts = Date.now();
        const baseRec: Omit<NotificationRecord, "handledAs"> = {
          title,
          timestamp: ts,
          ...(o.body !== undefined ? { body: o.body } : {}),
          ...(o.icon !== undefined ? { icon: o.icon } : {}),
          ...(o.tag !== undefined ? { tag: o.tag } : {}),
          ...(origin !== undefined ? { origin } : {}),
        };
        switch (mode) {
          case "allow":
            state.record({ ...baseRec, handledAs: "allowed" });
            return "allow";
          case "deny":
            state.record({ ...baseRec, handledAs: "denied" });
            return "deny";
          case "ask-human": {
            const decision = await askHandler({
              title,
              ...(o.body !== undefined ? { body: o.body } : {}),
              ...(o.icon !== undefined ? { icon: o.icon } : {}),
              ...(o.tag !== undefined ? { tag: o.tag } : {}),
              ...(origin !== undefined ? { origin } : {}),
            }).catch(() => "deny" as const);
            state.record({ ...baseRec, handledAs: "asked-human" });
            return decision;
          }
          case "raise":
          default:
            state.record({ ...baseRec, handledAs: "raised" });
            return "deny";
        }
      } catch (err) {
        log.warn("session.notification: check handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return "allow";
      }
    });
  } catch (err) {
    log.warn(
      "session.notification: exposeBinding install failed; constructor falls back to call-through",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // Init-script — Playwright re-runs it on every new document. Idempotent
  // via the `__browx_notification_installed` guard inside the script.
  try {
    await context.addInitScript({ content: NOTIFICATION_PAGE_SCRIPT });
    // Seed the sync decision before any page script runs, plus apply to
    // already-attached pages so the wrapper installs on the current document.
    await context.addInitScript({ content: syncDecisionSeed(state.current().mode) });
    for (const page of context.pages()) {
      await page.evaluate(syncDecisionSeed(state.current().mode)).catch(() => undefined);
      await page.evaluate(NOTIFICATION_PAGE_SCRIPT).catch(() => undefined);
    }
  } catch (err) {
    log.warn("session.notification: addInitScript failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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

function syncDecisionSeed(mode: NotificationPolicyMode): string {
  const dec = syncDecisionFor(mode);
  // Init-script: runs before any page script, sets the hint on `window`.
  return `(() => { try { window.__browx_notification_sync_decision = ${JSON.stringify(dec)}; } catch (_) {} })();`;
}

/** Push the current policy's sync decision to every live page in the context
 *  AND register an additional init-script so future new documents see the
 *  fresh value. Called from `set_notification_policy` so a runtime mode flip
 *  takes effect on the very next constructor call without page reload.
 *
 *  Init-scripts accumulate in Playwright (one per call); the seed is ~80
 *  bytes so even hundreds of flips are negligible. The constructor wrapper
 *  reads `window.__browx_notification_sync_decision` at each call, so the
 *  most-recently-evaluated seed wins. */
export async function propagateSyncDecision(
  context: BrowserContext,
  state: NotificationPolicyState,
): Promise<void> {
  const seed = syncDecisionSeed(state.current().mode);
  try {
    await context.addInitScript({ content: seed });
  } catch {
    /* best-effort */
  }
  for (const page of context.pages()) {
    await page.evaluate(seed).catch(() => undefined);
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
