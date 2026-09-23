// In-page scripts for the `__browx` human channel.
//
// Two scripts, two JS worlds:
//
//   - `browxHumanScript(binding)` runs in a CDP ISOLATED WORLD named
//     `HUMAN_WORLD`. It is the only place a human answer can originate: the
//     CDP binding it calls exists in that world alone, and the page's own
//     scripts share the DOM with it but not its JS globals. A human reaches it
//     from DevTools by picking the `browxai` entry in the console's context
//     dropdown.
//   - `BROWX_PAGE_STUB` runs in the page's main world and is display-only. Every
//     method logs where the real channel lives and returns false. Page content
//     can call it, overwrite it, or delete it; none of that reaches the server.
//
// Both are stringified so they can be passed as script sources. Keep the
// contents browser-only JS, with no TS-only syntax.

/** Name of the isolated world the human channel lives in. This is the label a
 *  human picks in the DevTools console context dropdown. */
export const HUMAN_WORLD = "browxai";

const STUB_HINT =
  `[browxai] window.__browx in the page is display-only and does not answer anything. ` +
  `In DevTools, switch the console context dropdown from "top" to "${HUMAN_WORLD}", ` +
  `then call __browx.proceed() / confirm(true|false) / choose(idx) / input(text) there.`;

export const BROWX_PAGE_STUB = `(() => {
  if (window.__browx) return;
  var hint = ${JSON.stringify(STUB_HINT)};
  var warned = false;
  function displayOnly() {
    if (!warned) {
      warned = true;
      try { console.warn(hint); } catch (_) {}
    }
    return false;
  }
  window.__browx = {
    signal: displayOnly,
    proceed: displayOnly,
    abort: displayOnly,
    done: displayOnly,
    respond: displayOnly,
    confirm: displayOnly,
    choose: displayOnly,
    input: displayOnly,
    status: function () { return { state: "display-only", humanWorld: ${JSON.stringify(HUMAN_WORLD)} }; },
  };
  try { console.info(hint); } catch (_) {}
})();`;

/** The isolated-world helper. `binding` is the per-bridge CDP binding name,
 *  installed in `HUMAN_WORLD` only. */
export function browxHumanScript(binding: string): string {
  return `(() => {
  if (globalThis.__browx) return;
  var send = globalThis[${JSON.stringify(binding)}];
  if (typeof send !== "function") return;
  function emit(name, data) {
    send(JSON.stringify({ kind: "signal", name: name, data: data == null ? null : data }));
  }
  globalThis.__browx = {
    signal: function (name, data) { emit(String(name), data); },
    proceed: function (data) { emit("proceed", data); },
    abort: function (reason) { emit("abort", reason); },
    done: function (what, data) { emit("did", { what: what, data: data == null ? null : data }); },
    respond: function (value) { emit("respond", value); },
    confirm: function (yes) { emit("respond", { kind: "confirm", value: !!yes }); },
    choose: function (idx) { emit("respond", { kind: "choose", value: idx }); },
    input: function (text) { emit("respond", { kind: "input", value: String(text == null ? "" : text) }); },
    status: function () { return { state: "ready" }; },
  };
})();`;
}
