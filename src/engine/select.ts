// Engine selection. The launch path resolves an `EngineKind` to a Playwright
// browser-type and rejects the not-yet-implemented engines with a structured,
// RFC-naming error — the doctrine's no-silent-no-op rule: an unsupported engine
// must fail loudly, naming where the work is tracked, not quietly fall back to
// Chromium.

import { chromium, firefox, webkit, type BrowserType } from "playwright-core";
import type { EngineKind } from "./types.js";

// `android` resolves to Playwright's `chromium` BrowserType — Chrome-on-Android
// speaks full CDP, so the adapter attaches with `chromium.connectOverCDP(wsUrl)`
// over an adb-forwarded socket, reusing the exact Chromium transport (RFC D8).
const BROWSER_TYPES: Record<EngineKind, BrowserType> = {
  chromium,
  firefox,
  webkit,
  android: chromium,
};

/** Engines wired today. Chromium (P0) + Firefox (P1, Playwright's bundled
 *  Juggler build) + WebKit (P2c, Playwright's bundled WebKit build — the WebKit-
 *  ENGINE correctness lane per RFC D7, NOT Safari) + Android (P3, real Chrome-on-
 *  Android attached over adb + CDP per RFC D3/D8 — full CDP, `deep: true`). All
 *  four `EngineKind` members are implemented; the no-silent-no-op selection error
 *  remains for any future engine declared before its adapter lands. */
export const IMPLEMENTED_ENGINES: readonly EngineKind[] = [
  "chromium",
  "firefox",
  "webkit",
  "android",
];

export class EngineNotYetSupportedError extends Error {
  readonly engine: EngineKind;
  constructor(engine: EngineKind) {
    super(
      `engine-not-yet-supported: "${engine}" is declared but not yet implemented — ` +
        "chromium, firefox, webkit, and android are wired today " +
        "(see docs/rfcs/0002-multi-engine-bidi.md). " +
        'Use browserType:"chromium" (the default), "firefox", "webkit", or "android".',
    );
    this.name = "EngineNotYetSupportedError";
    this.engine = engine;
  }
}

/** Map an `EngineKind` to the Playwright `BrowserType` that drives it. Throws
 *  `EngineNotYetSupportedError` for engines without an adapter yet. The mapping
 *  is `playwright[browserType]` — the same surface every Playwright client
 *  selects on; only chromium is reachable in P0. */
export function resolveBrowserType(engine: EngineKind): BrowserType {
  if (!IMPLEMENTED_ENGINES.includes(engine)) {
    throw new EngineNotYetSupportedError(engine);
  }
  // chromium + firefox + webkit + android all reach here today (android maps to
  // the chromium BrowserType — it attaches to real Chrome-on-Android over CDP).
  return BROWSER_TYPES[engine];
}

/** Raised when the operator names an engine that browxai does not implement —
 *  the top-level `BROWX_ENGINE` / `--engine` validation error. Distinct from
 *  `EngineNotYetSupportedError` (which guards a *declared-but-unadaptered*
 *  `EngineKind` at the launch path): this one fires on an arbitrary operator
 *  string (`safari`, a typo, …) that is not even a known engine, BEFORE the
 *  server starts. The message lists the implemented engines so the fix is in
 *  the error, and names RFC 0002 for Safari's tracked-but-not-shipped status. */
export class UnknownEngineError extends Error {
  readonly value: string;
  constructor(value: string) {
    const note = value.toLowerCase() === "safari" ? " (see RFC 0002 for Safari status)" : "";
    super(
      `engine "${value}" is not available; implemented engines: ` +
        `${IMPLEMENTED_ENGINES.join(", ")}${note}`,
    );
    this.name = "UnknownEngineError";
    this.value = value;
  }
}

/** Validate an operator-supplied engine string against `IMPLEMENTED_ENGINES`.
 *  Returns the value narrowed to `EngineKind` on success; throws
 *  `UnknownEngineError` (structured, listing the valid engines) otherwise. The
 *  comparison is exact + case-sensitive: engine kinds are lowercase tokens, and
 *  silently accepting `Firefox`/`FIREFOX` would mask a misconfiguration. */
export function validateEngine(value: string): EngineKind {
  if ((IMPLEMENTED_ENGINES as readonly string[]).includes(value)) {
    return value as EngineKind;
  }
  throw new UnknownEngineError(value);
}

/** Resolve the operator's engine selection for the MCP server. Precedence:
 *  an explicit `--engine <kind>` CLI flag wins over the `BROWX_ENGINE` env var,
 *  which wins over the default `chromium`. Both inputs are validated against
 *  `IMPLEMENTED_ENGINES`; an unknown value throws `UnknownEngineError`. Returns
 *  `undefined` when neither is set, so the caller can omit `browserType` and let
 *  `server.ts` apply its own default (byte-identical to never passing the option).
 *
 *  Pure over (argv, env) so it unit-tests without a browser. Mirrors the inline
 *  env/flag idiom the rest of cli.ts uses (BROWX_HEADLESS, BROWX_ATTACH_CDP),
 *  lifted into a function only because it carries validation + precedence worth
 *  testing in isolation. */
export function resolveEngineSelection(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EngineKind | undefined {
  const flag = readEngineFlag(argv);
  if (flag !== undefined) return validateEngine(flag);
  const fromEnv = env.BROWX_ENGINE?.trim();
  if (fromEnv) return validateEngine(fromEnv);
  return undefined;
}

/** Extract the `--engine <kind>` / `--engine=<kind>` value from an argv slice,
 *  or undefined when the flag is absent. A bare trailing `--engine` with no
 *  value throws (an obvious operator mistake, not a silent no-op). */
function readEngineFlag(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--engine") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--engine requires a value, e.g. `--engine firefox`. See BROWX_ENGINE.");
      }
      return next;
    }
    if (arg.startsWith("--engine=")) {
      return arg.slice("--engine=".length);
    }
  }
  return undefined;
}
