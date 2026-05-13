// In-page script that defines window.__browx. Injected via addInitScript so it
// runs on every navigation / new document, and evaluated directly on already-open
// pages at attach time. Tiny and self-contained — no framework, no DOM banner
// (the shadow-DOM banner UI is a Phase-1.5 polish; for now we log a one-line
// hint to the console so a human in DevTools knows the API is there).
//
// stringified so it can be passed as a script source. Keep the contents
// browser-only JS — no TS-only syntax.

export const BROWX_PAGE_SCRIPT = `(() => {
  if (window.__browx) return;
  function send(kind, name, data) {
    if (typeof window.__browx_send !== "function") return;
    try { window.__browx_send(JSON.stringify({ kind: kind, name: name, data: data == null ? null : data })); }
    catch (e) { /* binding may have been clobbered (CDP multi-attach); fall back to DOM-attribute path */
      try {
        document.documentElement.setAttribute(
          "data-browx-signal",
          JSON.stringify({ kind: kind, name: name, data: data == null ? null : data, ts: Date.now() })
        );
      } catch (_) {}
    }
  }
  window.__browx = {
    signal: function (name, data) { send("signal", name, data); },
    proceed: function (data) { send("signal", "proceed", data == null ? null : data); },
    abort: function (reason) { send("signal", "abort", reason == null ? null : reason); },
    done: function (what, data) { send("signal", "did", { what: what, data: data == null ? null : data }); },
    status: function () { return { state: "ready" }; },
  };
  try { console.info("[browxai] __browx ready. window.__browx.proceed() releases any awaiting tool."); } catch (_) {}
})();`;
