// Server-side overlay neutraliser. Dev-build chrome (HMR widgets, devtools
// iframes), cookie/consent banners and similar overlays intercept coordinate
// clicks and pollute the snapshot. Rather than have every agent hand-roll
// node removal in `eval_js` each session, the operator declares the offending
// selectors once (config `hideOverlaySelectors`) and the server injects a
// CSS-only init script that neutralises them on every navigation.
//
// Non-destructive by design: a `<style>` rule sets `pointer-events:none;
// display:none` — no node removal, no agent-supplied JS. The selectors come
// from operator-managed config (config.json / set_config), never the page.

import type { BrowserContext } from "playwright-core";
import { log } from "../util/logging.js";

const STYLE_ID = "__browx_overlay_hide";

/** Build the init-script body for the given selectors. Selectors are embedded
 *  as JSON string literals (no expression interpolation) and written via
 *  `style.textContent` (not parsed as HTML), so a hostile selector can at
 *  worst break its own CSS rule — it cannot escape into script. */
export function buildOverlayHideScript(selectors: string[]): string {
  return `(() => {
  var SELS = ${JSON.stringify(selectors)};
  if (!SELS.length) return;
  var css = SELS.map(function (s) {
    return s + "{pointer-events:none !important;display:none !important;}";
  }).join("\\n");
  var ID = ${JSON.stringify(STYLE_ID)};
  var inject = function () {
    if (document.getElementById(ID)) return;
    var st = document.createElement("style");
    st.id = ID;
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  };
  inject();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inject);
  }
})();`;
}

/** Register the overlay-hide init script on a context and apply it to any
 *  already-open pages. No-op when `selectors` is empty (feature off). */
export async function applyOverlayHide(
  context: BrowserContext,
  selectors: string[],
): Promise<void> {
  if (!selectors.length) return;
  const script = buildOverlayHideScript(selectors);
  await context.addInitScript({ content: script });
  for (const page of context.pages()) {
    await page.evaluate(script).catch(() => undefined);
  }
  log.info("overlay-hide: active", { count: selectors.length });
}
