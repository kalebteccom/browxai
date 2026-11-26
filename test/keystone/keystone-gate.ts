// The one place a keystone decides to skip. Every skip carries a reason, which the
// skip reporter (skip-reporter.ts) prints after the run, so a skipped keystone is
// visible in the log next to the ones that ran.
//
// Two kinds of gate:
//
//   - engineGate: a Playwright-managed browser binary (chromium, firefox, webkit).
//     With BROWX_REQUIRE_BROWSER=1 a missing binary throws at module load, so the
//     file fails. CI sets it on the browser shards, where all three are installed.
//     Without it a missing binary skips, so a machine with no browser still runs
//     the rest of the lane.
//   - hostGate: something no CI box has (an Android device, an iOS simulator,
//     macOS safaridriver, a running Electron app, a non-Windows host). These skip
//     with the reason given and BROWX_REQUIRE_BROWSER does not touch them.
//
// test/architecture/keystone-skips.test.ts fails on any other skip call under
// test/keystone, so a new skip has to come through here and name its reason.

import { existsSync } from "node:fs";
import { describe } from "vitest";
import { chromium, firefox, webkit } from "playwright-core";

declare module "vitest" {
  interface TaskMeta {
    /** Why the keystone did not run. Set by `gatedDescribe` on every test it skips. */
    skipReason?: string;
  }
}

export type Gate = { run: true } | { run: false; reason: string };

const ENGINES = { chromium, firefox, webkit } as const;
export type PlaywrightEngine = keyof typeof ENGINES;

export const REQUIRE_BROWSER_ENV = "BROWX_REQUIRE_BROWSER";

export interface EngineGateDeps {
  env?: NodeJS.ProcessEnv;
  executablePath?: (engine: PlaywrightEngine) => string;
  exists?: (path: string) => boolean;
}

/** The engine's binary path, or "" when Playwright cannot name one. */
function playwrightPath(engine: PlaywrightEngine): string {
  try {
    return ENGINES[engine].executablePath();
  } catch {
    return "";
  }
}

/** Whether `engine`'s binary is installed. Throws when it is not and
 *  BROWX_REQUIRE_BROWSER=1, so the keystone file fails at collection. */
export function engineGate(
  engine: PlaywrightEngine,
  deps: EngineGateDeps = {},
): Gate & { path: string } {
  const env = deps.env ?? process.env;
  const path = (deps.executablePath ?? playwrightPath)(engine);
  if (path && (deps.exists ?? existsSync)(path)) return { run: true, path };
  const missing = path ? `no ${engine} binary at ${path}` : `Playwright names no ${engine} binary`;
  if (env[REQUIRE_BROWSER_ENV] === "1") {
    throw new Error(
      `${REQUIRE_BROWSER_ENV}=1 and ${missing}. Install it with \`pnpm exec playwright-core install ${engine}\`.`,
    );
  }
  return { run: false, reason: `${missing} (pnpm exec playwright-core install ${engine})`, path };
}

/** A skip for something the host lacks: `reason` is printed when `available` is false. */
export function hostGate(available: boolean, reason: string): Gate {
  return available ? { run: true } : { run: false, reason };
}

/** `describe` when the gate runs; otherwise a skipped `describe` whose tests carry
 *  the gate's reason in `meta.skipReason`. */
export function gatedDescribe(gate: Gate): (name: string, fn: () => void) => void {
  return (name, fn) => {
    if (gate.run) describe(name, fn);
    else describe(name, { skip: true, meta: { skipReason: gate.reason } }, fn);
  };
}
