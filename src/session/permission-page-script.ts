// Browser-realm half of the per-session permission policy (realm 2 of 3:
// the page-script constant). This is browser-only JS that runs *inside the
// page*; it is stringified and handed to `addInitScript` / `page.evaluate` by
// the attach adapter (`permission-attach.ts`). The serialization contract
// depends on its exact text — do NOT inline, transform, or "modernise" it
// (no TS-only syntax, no template-string interpolation that the page can't
// parse). It lives in its own leaf file so the Node-side policy state and the
// attach adapter both stay free of browser-realm code.
//
// The wrappers consult `window.__browx_permission_check({permission, origin})`
// (an exposeBinding callable from page context) — it returns `"allow" |
// "deny"`. The server's binding implementation (see `permission-attach.ts`)
// records the request + (for `ask-human`) blocks on the bridge before
// answering.

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
