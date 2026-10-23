// The playwright-core version browxai runs against, for install hints.
//
// `npx playwright-core install chromium` with no version downloads whatever
// playwright-core is newest on npm, and its Chromium revision can differ from
// the one the installed playwright-core launches. Pinning the hint to the
// installed version fetches the build that package expects.

import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);

/** The installed playwright-core version, or undefined when it cannot be read. */
export function installedPlaywrightVersion(): string | undefined {
  try {
    const pkg = requireFromHere("playwright-core/package.json") as { version?: unknown };
    return typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version)
      ? pkg.version
      : undefined;
  } catch {
    return undefined;
  }
}

/** `npx playwright-core@<installed version> install <browser>`. Pass `null` as
 *  the version, or have no readable install, for a command with no pin. */
export function playwrightInstallCommand(
  browser: string,
  version: string | null = installedPlaywrightVersion() ?? null,
): string {
  return `npx playwright-core${version ? `@${version}` : ""} install ${browser}`;
}
