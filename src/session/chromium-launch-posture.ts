// How a chromium session picks its browser binary and which Playwright default
// switches it keeps. Both are launch-time decisions with no page contact.
//
// Binary: with no `channel` anywhere (per-session, config `channel`,
// `BROWX_CHANNEL`) a launch targets the operator's installed Google Chrome. When
// Chrome is not installed the launch is refused with `chrome-not-installed`:
// Playwright's bundled Chromium runs only when the operator asks for it with
// `channel: "chromium"` (or `BROWX_CHANNEL=chromium`). Any other channel is taken
// as given and a missing binary is Playwright's error.
//
// Extensions load through `--load-extension`, which branded Chrome ignores, so a
// launch with extensions and no channel is refused with `extensions-need-chromium`
// until the session names `channel: "chromium"`.
//
// Switch: Playwright adds `--enable-automation` to every chromium launch. That
// switch is what puts Chrome into its automation-controlled mode (the infobar,
// `navigator.webdriver`). browxai drops it. No other flag is added or removed to
// change what a page can observe: no `--disable-blink-features`, no navigator
// patching, no injected scripts, no user-agent rewriting.

import { docsUrl } from "../util/docs-links.js";
import { playwrightInstallCommand } from "../util/playwright-version.js";
import type { SessionOptions } from "./types.js";

/** `channel` value that forces Playwright's bundled Chromium build. */
export const BUNDLED_CHANNEL = "chromium";

/** Playwright channel for the operator's installed Google Chrome. */
export const INSTALLED_CHROME_CHANNEL = "chrome";

/** Env var that restores Playwright's `--enable-automation` switch. */
export const AUTOMATION_SWITCH_ENV = "BROWX_AUTOMATION_SWITCH";

/** The codes a chromium launch refuses with before or instead of starting a browser. */
export type LaunchChannelCode = "chrome-not-installed" | "extensions-need-chromium";

/** A launch refused over the browser it would run on. `message` starts with
 *  `<code>: `, so a caller that only sees the text still reads the code. */
export class LaunchChannelRefusal extends Error {
  readonly code: LaunchChannelCode;
  constructor(code: LaunchChannelCode, detail: string, options?: { cause?: unknown }) {
    super(`${code}: ${detail}`, options);
    this.name = "LaunchChannelRefusal";
    this.code = code;
  }
}

const OPT_IN =
  `set BROWX_CHANNEL=${BUNDLED_CHANNEL} (or \`channel: "${BUNDLED_CHANNEL}"\` in open_session or ` +
  "the config) to use Playwright's bundled Chromium";

/** The refusal for a default launch on a machine with no installed Google Chrome. */
export function chromeNotInstalled(cause?: unknown): LaunchChannelRefusal {
  return new LaunchChannelRefusal(
    "chrome-not-installed",
    "no installed Google Chrome was found, and a chromium session with no channel " +
      `launches only that. Install Google Chrome, or ${OPT_IN}. See ` +
      docsUrl.troubleshootingChromeNotInstalled,
    cause === undefined ? undefined : { cause },
  );
}

/** The refusal for a launch that loads extensions and names no channel. */
export function extensionsNeedChromium(): LaunchChannelRefusal {
  return new LaunchChannelRefusal(
    "extensions-need-chromium",
    "loading extensions needs Playwright's bundled Chromium, because Google Chrome " +
      `ignores --load-extension. Open the session with \`channel: "${BUNDLED_CHANNEL}"\`, or ` +
      `set BROWX_CHANNEL=${BUNDLED_CHANNEL}, then install the extension again. See ` +
      docsUrl.troubleshootingExtensionsNeedChromium,
  );
}

/** True when `channel` names the bundled build (`"chromium"`, any case and
 *  surrounding whitespace). */
export function isBundledChannel(channel: string | undefined): boolean {
  return channel?.trim().toLowerCase() === BUNDLED_CHANNEL;
}

export interface ChannelPlan {
  /** Playwright channel to launch, or undefined for the bundled build. */
  channel?: string;
  /** True when `channel` is only the default, so a missing install is refused
   *  with `chrome-not-installed`. False for an explicit channel, whose missing
   *  install is Playwright's own error. */
  defaulted: boolean;
}

/** The channel a launch targets, given the caller's `channel` (already layered
 *  from the per-session spec, config and `BROWX_CHANNEL`). Throws
 *  `extensions-need-chromium` for an extension launch with no channel. */
export function planChromiumChannel(
  opts: Pick<SessionOptions, "channel" | "extensionPaths">,
): ChannelPlan {
  const requested = opts.channel?.trim();
  if (isBundledChannel(requested)) return { defaulted: false };
  if (requested) return { channel: requested, defaulted: false };
  if (opts.extensionPaths && opts.extensionPaths.length > 0) {
    throw extensionsNeedChromium();
  }
  return { channel: INSTALLED_CHROME_CHANNEL, defaulted: true };
}

/** True when `err` is Playwright's refusal to launch a channel whose browser is
 *  not on the machine. Playwright raises it while resolving the executable, before
 *  any process is spawned, so the refusal leaves no browser behind. */
export function isChannelNotInstalled(err: unknown, channel: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes(`Chromium distribution '${channel}' is not found`) ||
    message.includes(`Chromium distribution '${channel}' is not supported`)
  );
}

/** True when `err` is Playwright's refusal to launch the bundled browser because
 *  its download is missing ("Executable doesn't exist at ..."). */
export function isBundledBrowserMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Executable doesn't exist");
}

/** Playwright's own missing-browser text points at `npx playwright install`, which
 *  names neither the Chrome option nor the package browxai ships. Append what to
 *  do here; the original message stays intact above it. */
function withNoBrowserHint(err: unknown): unknown {
  if (!isBundledBrowserMissing(err) || !(err instanceof Error)) return err;
  return new Error(
    `${err.message}\n\nbrowxai: channel "${BUNDLED_CHANNEL}" launches the bundled Chromium, and it is ` +
      `not downloaded. Run \`${playwrightInstallCommand("chromium")}\`, or drop the channel to ` +
      "launch the installed Google Chrome. `browxai doctor` shows which of the two is present.",
    { cause: err },
  );
}

async function launchBundled<T>(
  launch: (channelOption: { channel?: string }) => Promise<T>,
): Promise<T> {
  try {
    return await launch({});
  } catch (err) {
    throw withNoBrowserHint(err);
  }
}

/** Run `launch` on the planned channel. A default launch whose Chrome is not
 *  installed is refused with `chrome-not-installed`; nothing falls back to the
 *  bundled build. A bundled launch that finds no download gets a hint on how to
 *  get one. Any other error propagates. */
export async function launchWithChannelPlan<T>(
  plan: ChannelPlan,
  launch: (channelOption: { channel?: string }) => Promise<T>,
): Promise<T> {
  if (!plan.channel) return launchBundled(launch);
  try {
    return await launch({ channel: plan.channel });
  } catch (err) {
    if (plan.defaulted && isChannelNotInstalled(err, plan.channel)) throw chromeNotInstalled(err);
    throw err;
  }
}

/** Playwright launch option that drops `--enable-automation`. Empty when
 *  `BROWX_AUTOMATION_SWITCH` is `1` / `true`, which leaves Playwright's default. */
export function automationSwitchOptions(env: NodeJS.ProcessEnv = process.env): {
  ignoreDefaultArgs?: string[];
} {
  const v = env[AUTOMATION_SWITCH_ENV]?.trim().toLowerCase();
  if (v === "1" || v === "true") return {};
  return { ignoreDefaultArgs: ["--enable-automation"] };
}
