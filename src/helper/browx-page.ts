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
  function viaAttribute(kind, name, data) {
    try {
      document.documentElement.setAttribute(
        "data-browx-signal",
        JSON.stringify({ kind: kind, name: name, data: data == null ? null : data, ts: Date.now() })
      );
    } catch (_) {}
  }
  function send(kind, name, data) {
    // when our bridge has detached (set window.__browx_no_binding = true),
    // skip the now-detached __browx_send exposeBinding glue entirely — it would
    // emit "Function __browx_send is not exposed" console errors on every call.
    if (window.__browx_no_binding || typeof window.__browx_send !== "function") {
      viaAttribute(kind, name, data);
      return;
    }
    try { window.__browx_send(JSON.stringify({ kind: kind, name: name, data: data == null ? null : data })); }
    catch (e) { /* binding may have been clobbered (CDP multi-attach); fall back to DOM-attribute path */
      viaAttribute(kind, name, data);
    }
  }
  window.__browx = {
    signal: function (name, data) { send("signal", name, data); },
    proceed: function (data) { send("signal", "proceed", data == null ? null : data); },
    abort: function (reason) { send("signal", "abort", reason == null ? null : reason); },
    done: function (what, data) { send("signal", "did", { what: what, data: data == null ? null : data }); },
    // typed responses to await_human({kind:"confirm|choose|input"}). The
    // human reads the prompt from the runbook / terminal stderr, then calls one
    // of these from DevTools (or a future shadow-DOM banner UI will call them).
    respond: function (value) { send("signal", "respond", value); },
    confirm: function (yes) { send("signal", "respond", { kind: "confirm", value: !!yes }); },
    choose: function (idx) { send("signal", "respond", { kind: "choose", value: idx }); },
    input: function (text) { send("signal", "respond", { kind: "input", value: String(text == null ? "" : text) }); },
    status: function () { return { state: "ready" }; },
  };
  try { console.info("[browxai] __browx ready. window.__browx.proceed() releases any awaiting tool. For await_human kinds: confirm(true|false) / choose(idx) / input(text)."); } catch (_) {}
})();`;
