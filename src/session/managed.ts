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
  // Optional Chromium extension launch flags. Empty/unset → no flags.
  // Extensions are a LAUNCH-time concern in Chromium; the `extensions`-capability
  // tools mutate this list and rebuild the context. Headed-only (the tool layer
  // refuses on `headless:true` sessions, so by the time we reach this point the
  // launch is already headed) and persistent-only (`incognito` / `attached` are
  // refused upstream).
  const extensionArgs: string[] = [];
  if (opts.extensionPaths && opts.extensionPaths.length > 0) {
    const joined = opts.extensionPaths.join(",");
    extensionArgs.push(`--disable-extensions-except=${joined}`, `--load-extension=${joined}`);
    log.info("session.managed: loading extensions", {
      count: opts.extensionPaths.length,
      paths: opts.extensionPaths,
    });
  }
  const allArgs = [...insecureArgs, ...extensionArgs];
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !!opts.headless,
    // device/viewport emulation applied at context creation.
    ...(opts.device ?? {}),
    // No `--no-sandbox`. `--disable-web-security` only when the gated
    // flag is explicitly enabled (loud-warned above); otherwise safe-by-default.
    // `--load-extension` + `--disable-extensions-except` only when the
    // session has registered extensions (capability `extensions`);
    // `--disable-web-security` only when explicitly enabled (loud-warned).
    ...(allArgs.length ? { args: allArgs } : {}),
    // HAR recording at context creation (native Playwright primitive).
    // Finalized on context.close(). No-op when unset.
    ...(opts.recordHar ? { recordHar: opts.recordHar } : {}),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  // Persistent contexts don't take `storageState` at creation (their state
  // lives on disk). When a caller asks for it on a managed session we apply
  // it post-create via `setStorageState` — which CLEARS the profile's
  // existing cookies/localStorage/IndexedDB first. Loud-warn so the override
  // is visible.
  if (opts.storageState) {
    log.warn(
      "session.managed: applying storageState to a persistent profile — " +
      "this CLEARS existing cookies/localStorage/IndexedDB on the profile " +
      `at "${profileDir}" before seeding. Use incognito mode for a fresh ` +
      "context without touching a persistent profile.",
    );
    await context.setStorageState(opts.storageState);
  }

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
