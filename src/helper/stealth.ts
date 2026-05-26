// Stealth-mode init-script patches (capability `stealth`).
//
// Many sites detect Playwright/Puppeteer-driven browsers via a small set of
// well-known fingerprint giveaways the automation framework leaves on the
// page-side `navigator` / `window` objects. The most commonly-checked surface:
//
//   - `navigator.webdriver === true`               — the WebDriver protocol flag
//   - `navigator.plugins.length === 0`             — headless / fresh-profile tell
//   - `window.chrome` undefined / missing `runtime` — non-Chrome user-agent tell
//   - `navigator.languages` empty                  — headless Chromium default
//
// What this module does: registers a per-context `addInitScript` that overrides
// the above accessors BEFORE any page script runs. We do NOT bundle a
// general-purpose anti-fingerprinting library (e.g. puppeteer-extra-stealth) —
// that surface is vast and an arms race; the four patches above cover the
// observed default detectors and are the conservative minimum.
//
// Posture: same class as `eval` / `network-body` / `secrets` / `extensions` —
// off-by-default capability, loud-warned at boot. Legal/ToS exposure is real:
// many sites' terms of service explicitly prohibit "circumventing automated-
// access detection". The loud warning names that explicitly.
//
// Non-destructive within the running page: `Object.defineProperty` with
// `configurable:true` so a page that wants to inspect or replace the override
// still can (we're spoofing detection, not lying to legitimate code).

import type { BrowserContext } from "playwright-core";
import { log } from "../util/logging.js";

const SCRIPT_TAG = "__browx_stealth";

/** Build the page-side init script that applies the stealth patches. Pure —
 *  takes no input, returns the script string. Wrapped in an IIFE so the
 *  helpers don't leak into the page's globals. Idempotent: an early-return
 *  guard skips re-application if it ran in the same realm. */
export function buildStealthScript(): string {
  return `(() => {
  if (window.${SCRIPT_TAG}) return;
  Object.defineProperty(window, ${JSON.stringify(SCRIPT_TAG)}, { value: true, configurable: true });
  // 1. navigator.webdriver — the load-bearing Playwright fingerprint.
  try {
    Object.defineProperty(navigator, "webdriver", {
      get: function () { return false; },
      configurable: true,
    });
  } catch (e) { /* best-effort */ }
  // 2. navigator.plugins — headless / fresh-profile tell. Surface a
  //    plausible non-empty PluginArray-like (length 1 with a "Chrome PDF
  //    Viewer" entry mirrors real Chrome defaults).
  try {
    var fake = [{ name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" }];
    Object.defineProperty(navigator, "plugins", {
      get: function () { return fake; },
      configurable: true,
    });
  } catch (e) { /* best-effort */ }
  // 3. navigator.languages — headless Chromium emits []; real browsers
  //    populate at least the page-locale entry.
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, "languages", {
        get: function () { return ["en-US", "en"]; },
        configurable: true,
      });
    }
  } catch (e) { /* best-effort */ }
  // 4. window.chrome — non-Chrome UA tell. Many detectors check
  //    \`typeof window.chrome === "object" && !!window.chrome.runtime\`.
  try {
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", {
        value: { runtime: {} },
        configurable: true,
        writable: true,
      });
    } else if (!window.chrome.runtime) {
      try { window.chrome.runtime = {}; } catch (e) { /* best-effort */ }
    }
  } catch (e) { /* best-effort */ }
})();`;
}

/** Register the stealth init script on a context and apply it to any
 *  already-open pages. Mirrors the overlay-hide pattern: `addInitScript`
 *  for future navigations + `page.evaluate` for the currently-loaded page. */
export async function applyStealth(context: BrowserContext): Promise<void> {
  const script = buildStealthScript();
  await context.addInitScript({ content: script });
  for (const page of context.pages()) {
    await page.evaluate(script).catch(() => undefined);
  }
  log.info("stealth: active (navigator.webdriver / plugins / languages / chrome patches engaged)");
}
