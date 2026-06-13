// Managed-profile launch. Normal Chrome flags, sandbox on, profile dir rooted at
// $BROWX_WORKSPACE/profile/. Never `cwd`, never the human's daily-driver profile,
// never lowered-security flags.

import { log } from "../util/logging.js";
import { resolveWorkspace } from "../util/workspace.js";
import {
  PlaywrightChromiumAdapter,
  PlaywrightFirefoxAdapter,
  firefoxChannelFromEnv,
  type EngineKind,
} from "../engine/index.js";
import type { BrowserSession, SessionOptions } from "./types.js";

export async function openManagedSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const workspace = resolveWorkspace();
  const profileDir = opts.profileDir ?? workspace.sub("profile");
  const engine: EngineKind = opts.browserType ?? "chromium";
  log.info("session.managed: launching", { profileDir, headless: !!opts.headless, engine });

  // opt-in web-security-off. Off by default (safe-by-default is the
  //  non-negotiable); when the gated `disableWebSecurity` config flag
  // is set, lower it here with a loud per-launch warning. The `--disable-*`
  // flag form is Chromium-only — on Firefox SOP-off would ride
  // `firefoxUserPrefs` instead, which the Juggler lane doesn't wire today, so
  // we surface that rather than silently ignore the flag.
  const insecureArgs: string[] = [];
  if (opts.disableWebSecurity) {
    if (engine === "firefox") {
      log.warn(
        "⚠  session.managed: disableWebSecurity is not wired on the firefox engine — " +
          "the --disable-web-security flag form is Chromium-only. Launching with SOP/CORS ON. " +
          "Use a chromium session if you need web-security-off.",
      );
    } else {
      insecureArgs.push("--disable-web-security", "--disable-site-isolation-trials");
      log.warn(
        "⚠  session.managed: disableWebSecurity is ON — launching with --disable-web-security. " +
          "SOP/CORS is OFF for the whole browser session. Use only against test/dev targets.",
      );
    }
  }
  // Optional Chromium extension launch flags. Empty/unset → no flags.
  // Extensions are a LAUNCH-time concern in Chromium; the `extensions`-capability
  // tools mutate this list and rebuild the context. Headed-only (the tool layer
  // refuses on `headless:true` sessions, so by the time we reach this point the
  // launch is already headed) and persistent-only (`incognito` / `attached` are
  // refused upstream). The extension tools are engine-gated (Firefox has no
  // Playwright extension API), so this list is empty on the firefox path.
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
  // Launch options common to both engines. Chromium-only `args` are spliced in
  // for the chromium path only (Firefox rejects Chromium `--` flags).
  const options = {
    headless: !!opts.headless,
    // device/viewport emulation applied at context creation.
    ...(opts.device ?? {}),
    // Accept downloads at the context level — the per-session
    // `DownloadsRegistry` (off-by-default) intercepts them via the
    // `context.on("download")` event. Without `acceptDownloads:true`
    // Playwright never emits that event, so the off-by-default registry
    // can never opt in either.
    acceptDownloads: true,
    // HAR recording at context creation (native Playwright primitive).
    // Finalized on context.close(). No-op when unset.
    ...(opts.recordHar ? { recordHar: opts.recordHar } : {}),
    // Video recording at context creation (native Playwright primitive).
    // Finalized on context.close(). The dir is workspace-rooted by
    // construction; the registry's teardown calls
    // `page.video().saveAs(targetPath)` for a deterministic filename.
    ...(opts.recordVideo ? { recordVideo: opts.recordVideo } : {}),
  };

  let context;
  let page;
  let cdp;
  if (engine === "firefox") {
    const adapter = new PlaywrightFirefoxAdapter({ channel: firefoxChannelFromEnv() });
    ({ context, page } = await adapter.launchPersistent({ profileDir, options }));
  } else {
    const adapter = new PlaywrightChromiumAdapter();
    ({ context, page, cdp } = await adapter.launchPersistent({
      profileDir,
      // `--load-extension` + `--disable-extensions-except` only when the session
      // has registered extensions; `--disable-web-security` only when explicitly
      // enabled (loud-warned above). Chromium-only.
      options: { ...options, ...(allArgs.length ? { args: allArgs } : {}) },
    }));
  }
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

  const cdpHandle = cdp;
  let closed = false;
  return {
    mode: "managed",
    ownsBrowser: true,
    engine,
    page: () => page,
    // chromium mints a CDP session; firefox has none (`cdp` stays optional and
    // absent — consumers route through `requireCdp`, which refuses cleanly).
    ...(cdpHandle ? { cdp: () => cdpHandle } : {}),
    close: async () => {
      if (closed) return;
      closed = true;
      log.info("session.managed: closing");
      if (cdpHandle) await cdpHandle.detach().catch(() => undefined);
      await context.close().catch(() => undefined);
    },
  };
}
