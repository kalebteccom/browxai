// Interactive WebSocket primitives — capability `action`. The read-only
// `WsBuffer` is the observation half (`ws_read` + `ActionResult.network.wsFrames`);
// this is the mutation half:
//
//   • `ws_send({wsId, message})`      — push a payload onto a live page-side
//                                        WebSocket the agent identified via
//                                        `ws_read` / `__browxWs.list()`.
//   • `ws_intercept({pattern, ...})`  — route-handler-style pattern matching
//                                        for INBOUND WS messages. Three response
//                                        modes:
//        - `drop`          — discard the message before the page handler runs;
//        - `echo`          — re-send the same payload back to the server;
//        - `{data:string}` — replace the inbound payload with `data`.
//   • `ws_unintercept({pattern})`     — remove one interceptor (or all).
//
// CDP has no native "send a WS frame on an existing socket" primitive — frames
// are observable but not injectable from outside the page. So both halves run
// page-side via a wrapper installed on `window.WebSocket` at document-start
// (`Page.addInitScript`). The wrapper:
//
//   • Assigns each `WebSocket` a monotonic `wsId` (`ws-1`, `ws-2`, …) and
//     surfaces them via `window.__browxWs.list()` — the registry the agent
//     queries before `ws_send`. The ws IDs are observable to the agent
//     directly through `__browxWs.list()`, but a server-side index lets the
//     server-side dispatch validate ID liveness before evaluate().
//   • Exposes `__browxWs.send(wsId, payload)`. This calls the real (pre-
//     wrap) `WebSocket.prototype.send` so app-level event listeners do NOT
//     see a fake event — only the server does.
//   • Exposes `__browxWs.intercept(pattern, mode, replacement)`. Pattern is a
//     glob (the `*` / `**` family — see `globToRegex` below; matches
//     against `socket.url` at match-time). When an inbound `message` event
//     fires on a matching socket, the wrapper consults its interceptor
//     queue BEFORE dispatching to app handlers:
//        drop    — stopImmediatePropagation; don't deliver.
//        echo    — call the real `send()` with the inbound `data`; also
//                  delivers to app handlers (the contract is "the page
//                  thinks it got the message AND a mirror went out").
//        replace — synthesise a fresh `MessageEvent` with the replacement
//                  payload, dispatch THAT, suppress the original.
//   • Tracks active interceptors so `unintercept({pattern})` removes one
//     and `unintercept({})` clears the whole set.
//
// Server-side this file mints the init script (one constant — same shape as
// `BROWX_PAGE_SCRIPT`) and exposes a registry the MCP handlers can call.

import type { Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Pattern matching — shared with the route family's semantic intent (glob,
// not regex). The route tools hand the glob straight to Playwright; here we
// need to evaluate it ourselves both in-page (against `socket.url` on every
// inbound frame) and server-side (interceptor key lookup), so we compile it
// to a regex once. `*` matches a single path segment; `**` matches any
// number of characters (including `/`); everything else is literal.
//
// Exported for unit tests + reuse by the page-side script (stringified into
// the init script so the wrapper has the same matcher as the registry).

export function globToRegex(pat: string): RegExp {
  let out = "^";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") {
      if (pat[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.+?()[]{}|".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

export type WsInterceptMode = "drop" | "echo" | "replace";

export interface WsInterceptSpec {
  /** Glob pattern matched against the WebSocket's `url` at frame time. */
  pattern: string;
  /** `"drop"`, `"echo"`, or `{ data: "<replacement payload>" }`. */
  response: "drop" | "echo" | { data: string };
}

interface ActiveInterceptor {
  pattern: string;
  mode: WsInterceptMode;
  /** Set iff `mode === "replace"`. */
  replacement?: string;
}

/** Per-session interactive-WS registry. Tracks the active interceptors so
 *  `unintercept` / `list` can answer locally; the page-side wrapper is the
 *  authoritative runtime, but each server-side call mirrors the change
 *  into this table before evaluating so a re-`add` of the same pattern
 *  cleanly replaces the prior entry on both sides. */
export class WsInteractiveRegistry {
  private interceptors = new Map<string, ActiveInterceptor>();

  /** Idempotent — installs the init script + (best-effort) re-injects into
   *  the current document so the wrapper is live BEFORE `ws_send`
   *  / `ws_intercept` is called. Safe to call multiple times: the in-page
   *  guard `if (window.__browxWs) return;` short-circuits a re-run, and
   *  `addInitScript` accumulates harmlessly across calls.
   *
   *  Called lazily by `send`/`intercept` so a session that never uses the
   *  interactive primitives pays zero overhead. */
  async install(page: Page): Promise<void> {
    await page.context().addInitScript({ content: WS_PAGE_SCRIPT });
    // re-inject for the current document — addInitScript only fires on
    // future navigations. Tolerant of detached pages.
    for (const p of page.context().pages()) {
      await p.evaluate(WS_PAGE_SCRIPT).catch(() => undefined);
    }
  }

  /** Send `message` on the page-side WS identified by `wsId`. Returns
   *  `{ ok:true, wsId, url, bytes }` on success; `{ ok:false, error }`
   *  if the wrapper didn't find the id or the socket isn't OPEN. */
  async send(
    page: Page,
    args: { wsId: string; message: string },
  ): Promise<{ ok: boolean; wsId: string; url?: string; bytes?: number; error?: string }> {
    await this.install(page);
    const { wsId, message } = args;
    const r = (await page.evaluate(
      ({ id, msg }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = (globalThis as any).__browxWs as BrowxWsApi | undefined;
        if (!w) return { ok: false, error: "__browxWs not installed (init-script race?)" };
        return w.send(id, msg);
      },
      { id: wsId, msg: message },
    )) as { ok: boolean; url?: string; bytes?: number; error?: string };
    return { ...r, wsId };
  }

  async addInterceptor(
    page: Page,
    spec: WsInterceptSpec,
  ): Promise<{ key: string; active: string[] }> {
    await this.install(page);
    const mode: WsInterceptMode = spec.response === "drop"
      ? "drop"
      : spec.response === "echo"
        ? "echo"
        : "replace";
    const replacement = typeof spec.response === "object" ? spec.response.data : undefined;
    const key = spec.pattern;
    this.interceptors.set(key, { pattern: key, mode, ...(replacement !== undefined ? { replacement } : {}) });
    await page.evaluate(
      ({ pattern, mode, replacement }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = (globalThis as any).__browxWs as BrowxWsApi | undefined;
        if (!w) return;
        w.intercept(pattern, mode, replacement);
      },
      { pattern: key, mode, replacement: replacement ?? null },
    );
    return { key, active: this.list() };
  }

  async removeInterceptor(
    page: Page,
    sel: { pattern?: string },
  ): Promise<{ removed: string[]; active: string[] }> {
    await this.install(page);
    let removed: string[];
    if (sel.pattern === undefined) {
      removed = [...this.interceptors.keys()];
      this.interceptors.clear();
    } else if (this.interceptors.has(sel.pattern)) {
      removed = [sel.pattern];
      this.interceptors.delete(sel.pattern);
    } else {
      removed = [];
    }
    await page.evaluate(
      ({ pattern }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = (globalThis as any).__browxWs as BrowxWsApi | undefined;
        if (!w) return;
        if (pattern === null) w.unintercept(undefined);
        else w.unintercept(pattern);
      },
      { pattern: sel.pattern ?? null },
    );
    return { removed, active: this.list() };
  }

  /** Server-side mirror of the active patterns — order = insertion. */
  list(): string[] {
    return [...this.interceptors.keys()];
  }

  /** Read the page-side `__browxWs.list()` registry to surface live WS
   *  endpoints + their `wsId`. Best-effort: returns `[]` if the wrapper
   *  isn't installed (`install` is the lazy installer; this method is
   *  for `ws_send` discoverability and shouldn't itself force install). */
  async listSockets(page: Page): Promise<Array<{ wsId: string; url: string; readyState: number }>> {
    const r = (await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = (globalThis as any).__browxWs as BrowxWsApi | undefined;
      if (!w) return [];
      return w.list();
    })) as Array<{ wsId: string; url: string; readyState: number }>;
    return r;
  }
}

// Page-side handle shape — declared here for the server-side `evaluate`
// callbacks; the page-side script below is the implementation.
interface BrowxWsApi {
  send(id: string, msg: string): { ok: boolean; url?: string; bytes?: number; error?: string };
  intercept(pattern: string, mode: WsInterceptMode, replacement?: string | null): void;
  unintercept(pattern?: string): void;
  list(): Array<{ wsId: string; url: string; readyState: number }>;
}

// ---------------------------------------------------------------------------
// Page-side wrapper script. Wraps `window.WebSocket` exactly once. Keep this
// in lockstep with `globToRegex` above (the matcher is reimplemented inline
// — the script must be self-contained — and the test asserts both produce
// identical regexes). browser-only JS, no TS-only syntax.

export const WS_PAGE_SCRIPT = `(() => {
  if (window.__browxWs) return;
  var NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) return;
  var nativeSend = NativeWebSocket.prototype.send;
  var sockets = new Map(); // wsId -> WebSocket
  var nextId = 1;
  var interceptors = []; // { pattern, regex, mode, replacement }

  function globToRegex(pat) {
    var out = "^";
    for (var i = 0; i < pat.length; i++) {
      var c = pat[i];
      if (c === "*") {
        if (pat[i + 1] === "*") { out += ".*"; i++; }
        else { out += "[^/]*"; }
      } else if ("\\\\^$.+?()[]{}|".indexOf(c) >= 0) {
        out += "\\\\" + c;
      } else { out += c; }
    }
    out += "$";
    return new RegExp(out);
  }

  function matchOne(url) {
    for (var i = 0; i < interceptors.length; i++) {
      if (interceptors[i].regex.test(url)) return interceptors[i];
    }
    return null;
  }

  function Wrapped(url, protocols) {
    var sock = arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
    var id = "ws-" + (nextId++);
    sockets.set(id, sock);
    sock.__browxId = id;
    // Wrap message dispatch. We replace addEventListener("message", …) AND
    // onmessage so both registration paths route through the interceptor.
    var liveListeners = [];
    var origAdd = sock.addEventListener.bind(sock);
    var origRemove = sock.removeEventListener.bind(sock);
    sock.addEventListener = function (type, listener, opts) {
      if (type === "message" && typeof listener === "function") {
        liveListeners.push(listener);
        return; // we'll dispatch ourselves
      }
      return origAdd(type, listener, opts);
    };
    sock.removeEventListener = function (type, listener, opts) {
      if (type === "message" && typeof listener === "function") {
        var i = liveListeners.indexOf(listener);
        if (i >= 0) liveListeners.splice(i, 1);
        return;
      }
      return origRemove(type, listener, opts);
    };
    var onmessageFn = null;
    Object.defineProperty(sock, "onmessage", {
      configurable: true,
      get: function () { return onmessageFn; },
      set: function (v) { onmessageFn = typeof v === "function" ? v : null; },
    });
    function dispatch(payload) {
      var ev = new MessageEvent("message", { data: payload });
      for (var i = 0; i < liveListeners.length; i++) {
        try { liveListeners[i].call(sock, ev); } catch (_) {}
      }
      if (onmessageFn) {
        try { onmessageFn.call(sock, ev); } catch (_) {}
      }
    }
    origAdd("message", function (ev) {
      var hit = matchOne(sock.url || "");
      if (!hit) { dispatch(ev.data); return; }
      if (hit.mode === "drop") return;
      if (hit.mode === "echo") {
        try { nativeSend.call(sock, ev.data); } catch (_) {}
        dispatch(ev.data);
        return;
      }
      // replace
      dispatch(hit.replacement == null ? "" : hit.replacement);
    });
    // Expose the id post-construction; the agent reads it via __browxWs.list().
    return sock;
  }
  // Preserve constants + name so feature-detection (\`'OPEN' in WebSocket\`) keeps working.
  Wrapped.CONNECTING = NativeWebSocket.CONNECTING;
  Wrapped.OPEN = NativeWebSocket.OPEN;
  Wrapped.CLOSING = NativeWebSocket.CLOSING;
  Wrapped.CLOSED = NativeWebSocket.CLOSED;
  Wrapped.prototype = NativeWebSocket.prototype;
  try { Object.defineProperty(Wrapped, "name", { value: "WebSocket" }); } catch (_) {}
  window.WebSocket = Wrapped;

  window.__browxWs = {
    send: function (id, msg) {
      var sock = sockets.get(id);
      if (!sock) return { ok: false, error: "no socket with id " + id };
      if (sock.readyState !== 1) return { ok: false, error: "socket " + id + " is not OPEN (readyState=" + sock.readyState + ")" };
      try {
        nativeSend.call(sock, msg);
        return { ok: true, url: sock.url || "", bytes: typeof msg === "string" ? msg.length : 0 };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    },
    intercept: function (pattern, mode, replacement) {
      // Replace any prior interceptor on the same pattern (server-side
      // mirror does the same).
      for (var i = interceptors.length - 1; i >= 0; i--) {
        if (interceptors[i].pattern === pattern) interceptors.splice(i, 1);
      }
      interceptors.push({
        pattern: pattern,
        regex: globToRegex(pattern),
        mode: mode,
        replacement: replacement == null ? null : replacement,
      });
    },
    unintercept: function (pattern) {
      if (pattern === undefined || pattern === null) {
        interceptors.length = 0;
        return;
      }
      for (var i = interceptors.length - 1; i >= 0; i--) {
        if (interceptors[i].pattern === pattern) interceptors.splice(i, 1);
      }
    },
    list: function () {
      var out = [];
      sockets.forEach(function (sock, id) {
        out.push({ wsId: id, url: sock.url || "", readyState: sock.readyState });
      });
      return out;
    },
  };
})();`;
