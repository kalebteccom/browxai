// How a chromium session picks its browser binary and which Playwright default
// switches it keeps. Both are launch-time decisions with no page contact.
//
// Binary: with no `channel` anywhere (per-session, config `channel`,
// `BROWX_CHANNEL`) a launch targets the operator's installed Google Chrome, and
// falls back to Playwright's bundled Chromium when Chrome is not installed.
// `channel: "chromium"` pins the bundled build. Any other channel is taken as
// given and a missing binary is an error.
//
// Switch: Playwright adds `--enable-automation` to every chromium launch. That
// switch is what puts Chrome into its automation-controlled mode (the infobar,
// `navigator.webdriver`). browxai drops it. No other flag is added or removed to
// change what a page can observe: no `--disable-blink-features`, no navigator
// patching, no injected scripts, no user-agent rewriting.

import { log } from "../util/logging.js";
import type { SessionOptions } from "./types.js";

/** `channel` value that forces Playwright's bundled Chromium build. */
export const BUNDLED_CHANNEL = "chromium";

/** Playwright channel for the operator's installed Google Chrome. */
export const INSTALLED_CHROME_CHANNEL = "chrome";

/** Env var that restores Playwright's `--enable-automation` switch. */
export const AUTOMATION_SWITCH_ENV = "BROWX_AUTOMATION_SWITCH";

export interface ChannelPlan {
  /** Playwright channel to launch, or undefined for the bundled build. */
  channel?: string;
  /** True when `channel` is only the default, so a missing install falls back to
   *  the bundled build. False for an explicit channel: that must not substitute. */
  fallbackToBundled: boolean;
}

/** The channel a launch targets, given the caller's `channel` (already layered
 *  from the per-session spec, config and `BROWX_CHANNEL`).
 *
 *  Extensions load through `--load-extension`, which branded Chrome no longer
 *  honours, so an extension launch with no explicit channel stays on the bundled
 *  build. */
export function planChromiumChannel(
  opts: Pick<SessionOptions, "channel" | "extensionPaths">,
): ChannelPlan {
  const requested = opts.channel?.trim();
  if (requested && requested.toLowerCase() === BUNDLED_CHANNEL) {
    return { fallbackToBundled: false };
  }
  if (requested) return { channel: requested, fallbackToBundled: false };
  if (opts.extensionPaths && opts.extensionPaths.length > 0) {
    return { fallbackToBundled: false };
  }
  return { channel: INSTALLED_CHROME_CHANNEL, fallbackToBundled: true };
}

/** True when `err` is Playwright's refusal to launch a channel whose browser is
 *  not on the machine. Playwright raises it while resolving the executable, before
 *  any process is spawned, so retrying on the bundled build starts one browser. */
export function isChannelNotInstalled(err: unknown, channel: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes(`Chromium distribution '${channel}' is not found`) ||
    message.includes(`Chromium distribution '${channel}' is not supported`)
  );
}

/** Run `launch` on the planned channel. When the plan allows a fallback and the
 *  channel's browser is not installed, log why and run `launch` again on the
 *  bundled build. Any other error propagates. */
export async function launchWithChannelPlan<T>(
  plan: ChannelPlan,
  launch: (channelOption: { channel?: string }) => Promise<T>,
): Promise<T> {
  if (!plan.channel) return launch({});
  try {
    return await launch({ channel: plan.channel });
  } catch (err) {
    if (!plan.fallbackToBundled || !isChannelNotInstalled(err, plan.channel)) throw err;
    log.warn(
      `session: no installed "${plan.channel}" browser found, launching Playwright's bundled ` +
        `Chromium instead. Install Google Chrome to run on it, or set channel "${BUNDLED_CHANNEL}" ` +
        "(or BROWX_CHANNEL=chromium) to use the bundled build without this warning.",
      { reason: err instanceof Error ? err.message.split("\n")[0] : String(err) },
    );
    return launch({});
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
