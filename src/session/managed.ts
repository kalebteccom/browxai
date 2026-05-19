// Managed-profile launch. Normal Chrome flags, sandbox on, profile dir rooted at
// $BROWX_WORKSPACE/profile/. Never `cwd`, never the human's daily-driver profile,
// never lowered-security flags.

import { chromium } from "playwright-core";
import { log } from "../util/logging.js";
import { resolveWorkspace } from "../util/workspace.js";
import type { BrowserSession, SessionOptions } from "./types.js";

export async function openManagedSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const workspace = resolveWorkspace();
  const profileDir = opts.profileDir ?? workspace.sub("profile");
  log.info("session.managed: launching", { profileDir, headless: !!opts.headless });

  // opt-in web-security-off. Off by default (safe-by-default is the
  // Phase-1 non-negotiable); when the gated `disableWebSecurity` config flag
  // is set, lower it here with a loud per-launch warning.
  const insecureArgs: string[] = [];
  if (opts.disableWebSecurity) {
    insecureArgs.push("--disable-web-security", "--disable-site-isolation-trials");
    log.warn(
      "⚠  session.managed: disableWebSecurity is ON — launching with --disable-web-security. " +
      "SOP/CORS is OFF for the whole browser session. Use only against test/dev targets.",
    );
  }
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !!opts.headless,
    // device/viewport emulation applied at context creation.
    ...(opts.device ?? {}),
    // No `--no-sandbox`. `--disable-web-security` only when the gated 
    // flag is explicitly enabled (loud-warned above); otherwise safe-by-default.
    ...(insecureArgs.length ? { args: insecureArgs } : {}),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);

  let closed = false;
  return {
    mode: "managed",
    ownsBrowser: true,
    page: () => page,
    cdp: () => cdp,
    close: async () => {
      if (closed) return;
      closed = true;
      log.info("session.managed: closing");
      await cdp.detach().catch(() => undefined);
      await context.close().catch(() => undefined);
    },
  };
}
