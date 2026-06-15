// Shared launch-option building + session finalization for the Playwright-backed
// engines (chromium / firefox / webkit). Extracted VERBATIM from the per-engine
// branches of managed.ts / incognito.ts so the per-engine `EngineEntry.makeAdapter`
// (in adapters/<engine>.engine.ts) builds the exact same options + session object
// the old `if (engine === "…")` chains did — byte-identical, only relocated.
//
// The engine-specific divergences that DON'T collapse (firefox channel resolution,
// the chromium-only `args` splice, the disable-web-security warning text) stay in
// the engine modules; what lives here is the shared shape every Playwright engine
// builds identically.

import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  CDPSession,
  Page,
} from "playwright-core";
import { log } from "../util/logging.js";
import { resolveWorkspace } from "../util/workspace.js";
import type { EngineKind } from "../engine/index.js";
import type { BrowserSession, SessionOptions } from "./types.js";

/** Resolve the managed-launch profile dir + the shared context options, building
 *  the `--disable-web-security` + extension launch args exactly as the managed
 *  factory did. The chromium-only `args` splice (insecure + extension flags) is
 *  returned separately so the chromium engine can fold it into its
 *  launchPersistent options without firefox/webkit ever seeing Chromium `--` flags. */
export function buildManagedLaunch(
  engine: EngineKind,
  opts: SessionOptions,
): {
  profileDir: string;
  options: BrowserContextOptions & { headless: boolean; acceptDownloads: boolean };
  chromiumArgs: string[];
} {
  const workspace = resolveWorkspace();
  const profileDir = opts.profileDir ?? workspace.sub("profile");

  // opt-in web-security-off. Off by default (safe-by-default is the
  //  non-negotiable); when the gated `disableWebSecurity` config flag
  // is set, lower it here with a loud per-launch warning. The `--disable-*`
  // flag form is Chromium-only — on Firefox SOP-off would ride
  // `firefoxUserPrefs` instead, which the Juggler lane doesn't wire today, so
  // we surface that rather than silently ignore the flag.
  const insecureArgs: string[] = [];
  if (opts.disableWebSecurity) {
    if (engine !== "chromium") {
      log.warn(
        `⚠  session.managed: disableWebSecurity is not wired on the ${engine} engine — ` +
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
  const chromiumArgs = [...insecureArgs, ...extensionArgs];
  log.info("session.managed: launching", { profileDir, headless: !!opts.headless, engine });
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
  return { profileDir, options, chromiumArgs };
}

/** Apply a managed session's post-launch storageState seeding (the persistent-mode
 *  clear-then-seed path) and build the `BrowserSession` object — verbatim from the
 *  managed factory's tail. */
export async function finalizeManagedSession(
  engine: EngineKind,
  opts: SessionOptions,
  profileDir: string,
  handles: { context: BrowserContext; page: Page; cdp?: CDPSession },
): Promise<BrowserSession> {
  const { context, page } = handles;
  const cdpHandle = handles.cdp;
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

/** Build the incognito ephemeral launch options — the `--disable-web-security`
 *  splice, exactly as the incognito factory did (chromium-only). */
export function buildIncognitoLaunchOptions(
  engine: EngineKind,
  opts: SessionOptions,
): { headless: boolean; args?: string[] } {
  log.info("session.incognito: launching ephemeral browser", {
    headless: !!opts.headless,
    engine,
  });
  // opt-in web-security-off (off by default; loud per-launch warning). The
  // --disable-* flag form is Chromium-only; on the firefox engine we warn
  // rather than silently apply a flag Firefox doesn't accept.
  const insecureArgs: string[] = [];
  if (opts.disableWebSecurity) {
    if (engine !== "chromium") {
      log.warn(
        `⚠  session.incognito: disableWebSecurity is not wired on the ${engine} engine — ` +
          "the --disable-web-security flag form is Chromium-only. Launching with SOP/CORS ON.",
      );
    } else {
      insecureArgs.push("--disable-web-security", "--disable-site-isolation-trials");
      log.warn(
        "⚠  session.incognito: disableWebSecurity is ON — launching with --disable-web-security. " +
          "SOP/CORS is OFF for the whole browser session. Use only against test/dev targets.",
      );
    }
  }
  return {
    headless: !!opts.headless,
    // No lowered-security flags unless the gated flag is explicitly on. The
    // firefox/webkit ephemeral launches never carry Chromium `--` args (their
    // adapters take only `{ headless }`), so the splice is chromium-only by
    // construction — the engine module passes only what its adapter accepts.
    ...(insecureArgs.length ? { args: insecureArgs } : {}),
  };
}

/** Build the incognito ephemeral context options — verbatim from the incognito
 *  factory (device, downloads, storageState, recordHar, recordVideo). */
export function buildIncognitoContextOptions(opts: SessionOptions): BrowserContextOptions {
  return {
    ...(opts.device ?? {}),
    // Accept downloads at the context level so the per-session
    // `DownloadsRegistry` (off-by-default) can intercept them on demand.
    // The registry discards artefacts when capture is off — `acceptDownloads`
    // being true is purely the prerequisite for Playwright to emit the
    // `download` event that the registry's listener hangs off.
    acceptDownloads: true,
    // Seed the ephemeral context with a storage state if one was supplied
    // (the Playwright-native primitive for "open a fresh browser already
    // logged in as X"). No-op when unset.
    ...(opts.storageState ? { storageState: opts.storageState } : {}),
    // HAR recording at context creation (native Playwright primitive).
    // Finalized on context.close(). No-op when unset.
    ...(opts.recordHar ? { recordHar: opts.recordHar } : {}),
    // Video recording at context creation (native Playwright primitive).
    // Finalized on context.close(). The dir is workspace-rooted by
    // construction; the registry's teardown calls
    // `page.video().saveAs(targetPath)` for a deterministic filename.
    ...(opts.recordVideo ? { recordVideo: opts.recordVideo } : {}),
  };
}

/** Build the incognito `BrowserSession` object — verbatim from the incognito
 *  factory's tail (note the `mode: "managed"` coarse axis + the browser close). */
export function finalizeIncognitoSession(
  engine: EngineKind,
  handles: { browser?: Browser; context: BrowserContext; page: Page; cdp?: CDPSession },
): BrowserSession {
  const { browser, context, page } = handles;
  const cdpHandle = handles.cdp;
  let closed = false;
  return {
    mode: "managed", // BrowserSession.mode is the coarse owned/not-owned axis;
    // the fine-grained "incognito" label lives on SessionEntry.mode. We own it.
    ownsBrowser: true,
    engine,
    page: () => page,
    // chromium mints a CDP session; firefox has none (`cdp` stays absent).
    ...(cdpHandle ? { cdp: () => cdpHandle } : {}),
    close: async () => {
      if (closed) return;
      closed = true;
      log.info("session.incognito: closing (ephemeral context + browser discarded)");
      if (cdpHandle) await cdpHandle.detach().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    },
  };
}
