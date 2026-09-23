// In-page scripts for the `__browx` human channel.
//
// Two scripts, two JS worlds:
//
//   - `browxHumanScript(binding)` runs in a CDP ISOLATED WORLD named
//     `browxai-<random>`, one per session. It is the only place a human answer
//     can originate: the CDP binding it calls is scoped to that world, and the
//     page's own scripts share the DOM with it but not its JS globals. A human
//     reaches it from DevTools by picking that entry in the console's context
//     dropdown; browxai prints the name in its stderr prompts.
//   - `BROWX_PAGE_STUB` runs in the page's main world and is display-only. Every
//     method logs where the real channel lives and returns false. Page content
//     can call it, overwrite it, or delete it; none of that reaches the server.
//
// Both are stringified so they can be passed as script sources. Keep the
// contents browser-only JS, with no TS-only syntax.

/** Prefix of the isolated world the human channel lives in. Each session's
 *  world is `browxai-<random>`, printed in browxai's stderr prompts; the human
 *  picks that label in the DevTools console context dropdown. The random part
 *  stops anything else that can name a world (an extension called "browxai",
 *  say) from colliding with it. */
export const HUMAN_WORLD = "browxai";

const STUB_HINT =
  `[browxai] window.__browx in the page is display-only and does not answer anything. ` +
  `In DevTools, switch the console context dropdown from "top" to the "${HUMAN_WORLD}-…" ` +
  `context named in browxai's prompt, then call __browx.proceed() / confirm(true|false) / ` +
  `choose(idx) / input(text) there.`;

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
    status: function () { return { state: "display-only" }; },
  };
  try { console.info(hint); } catch (_) {}
})();`;

/** The isolated-world helper. `binding` is the per-bridge CDP binding name,
 *  installed in the session's human world only.
 *
 *  Every answer takes the prompt's ticket as its last argument (browxai prints
 *  it with the prompt), so a late answer to a prompt that already timed out
 *  cannot answer the next one. */
export function browxHumanScript(binding: string): string {
  return `(() => {
  if (globalThis.__browx) return;
  var send = globalThis[${JSON.stringify(binding)}];
  if (typeof send !== "function") return;
  function emit(name, data, ticket) {
    send(JSON.stringify({
      kind: "signal",
      name: name,
      data: data == null ? null : data,
      ticket: ticket == null ? null : String(ticket),
    }));
  }
  globalThis.__browx = {
    signal: function (name, data, ticket) { emit(String(name), data, ticket); },
    proceed: function (ticket, data) { emit("proceed", data, ticket); },
    abort: function (reason, ticket) { emit("abort", reason, ticket); },
    done: function (what, data) { emit("did", { what: what, data: data == null ? null : data }); },
    respond: function (value, ticket) { emit("respond", value, ticket); },
    confirm: function (yes, ticket) { emit("respond", { kind: "confirm", value: !!yes }, ticket); },
    choose: function (idx, ticket) { emit("respond", { kind: "choose", value: idx }, ticket); },
    input: function (text, ticket) { emit("respond", { kind: "input", value: String(text == null ? "" : text) }, ticket); },
    status: function () { return { state: "ready" }; },
  };
})();`;
}
