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
