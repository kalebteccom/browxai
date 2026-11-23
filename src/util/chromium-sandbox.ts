// The `chromiumSandbox` config key: whether Chromium's OS sandbox is on for the
// browsers browxai launches through Playwright.
//
// `auto` (default) turns the sandbox on when the host can run it and falls back to
// `--no-sandbox`, with a warning, when it cannot. `on` requires the sandbox: a launch
// that cannot start with it fails. `off` keeps Playwright's default, which adds
// `--no-sandbox`. The launch logic is in src/session/chromium-sandbox-launch.ts.
//
// The key is a policy key. `set_config` is an MCP tool, so an agent can call it, and
// `off` removes an OS-level boundary. Saved and session layers may only move toward
// `on`, never below the level the server's environment set (src/util/config-ceiling.ts).

export const CHROMIUM_SANDBOX_MODES = ["auto", "on", "off"] as const;
export type ChromiumSandboxMode = (typeof CHROMIUM_SANDBOX_MODES)[number];

/** Env var that sets the mode. */
export const CHROMIUM_SANDBOX_ENV = "BROWX_CHROMIUM_SANDBOX";

export function isChromiumSandboxMode(value: unknown): value is ChromiumSandboxMode {
  return typeof value === "string" && (CHROMIUM_SANDBOX_MODES as readonly string[]).includes(value);
}

/** Parse a `BROWX_CHROMIUM_SANDBOX` value. Unset or blank gives `undefined`; an
 *  unknown value throws, so a typo stops the server at start. */
export function parseChromiumSandbox(
  raw: string | undefined,
  source = CHROMIUM_SANDBOX_ENV,
): ChromiumSandboxMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (isChromiumSandboxMode(value)) return value;
  throw new Error(
    `${source}: unknown value ${JSON.stringify(raw?.trim())}. Valid: ${CHROMIUM_SANDBOX_MODES.join(", ")}. ` +
      "Fix the spelling or remove the entry, then restart the server.",
  );
}

const STRICTNESS: Record<ChromiumSandboxMode, number> = { off: 0, auto: 1, on: 2 };

/** True when `mode` asks for less sandboxing than `floor`. */
export function sandboxBelow(mode: ChromiumSandboxMode, floor: ChromiumSandboxMode): boolean {
  return STRICTNESS[mode] < STRICTNESS[floor];
}
