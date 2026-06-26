// Per-session notification policy — browser-realm page script. Realm (2) of the
// notification policy: the init-script string that runs *in the page* to wrap
// the global `Notification` constructor. This is browser-only JS (no TS
// syntax) and its exact text is the serialization contract passed to
// `addInitScript` / `page.evaluate` — do not inline or transform it.
//
// Leaf file: imports nothing from the barrel so the attach adapter and the
// barrel can both depend on it without an import cycle.
//
// Init-script wraps the global `Notification` constructor (and preserves the
// static `requestPermission` / `permission` getters so the `permission_policy`
// wrappers — already injected by `session/permission.ts` — keep working
// untouched). The two policies compose; coordination is by-construction:
// `permission_policy` only touches `Notification.requestPermission`, this
// module only touches `new Notification(...)`.

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
