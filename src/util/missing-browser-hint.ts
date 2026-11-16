// Playwright's missing-browser banner says `npx playwright install`, which can
// fetch a different browser build than the playwright-core browxai ships.
// Keep the banner and add the pinned command under it.

import { playwrightInstallCommand } from "./playwright-version.js";

/** `err` with a one-line install hint appended when it is Playwright's
 *  "Executable doesn't exist" for `browser`; `err` itself otherwise. */
export function withInstallHint(browser: "firefox" | "webkit", err: unknown): unknown {
  if (!(err instanceof Error) || !err.message.includes("Executable doesn't exist")) return err;
  return new Error(
    `${err.message}\n\nbrowxai: ${browser} is not downloaded. Run \`${playwrightInstallCommand(browser)}\`.`,
    { cause: err },
  );
}

/** Playwright's wording when a headed launch finds no display: its own banner
 *  (`...without having a XServer running`) and the Chromium startup log line. */
const NO_DISPLAY = /without having a XServer running|Missing X server/;

/** `err` with a one-line hint appended when a headed launch (`headless === false`)
 *  failed because the machine has no display; `err` itself otherwise. Playwright's
 *  text names `headless: true` and `xvfb-run`, neither of which a browxai user sets. */
export function withNoDisplayHint(err: unknown, headless: boolean | undefined): unknown {
  if (headless !== false || !(err instanceof Error) || !NO_DISPLAY.test(err.message)) return err;
  return new Error(
    `${err.message}\n\nbrowxai: a headed browser needs a display, so set BROWX_HEADLESS=1 to launch headless.`,
    { cause: err },
  );
}
