// RFC 0004 P3 / D3 (SRP) — the persistent-session extension context rebuild,
// extracted verbatim out of `extensions-batch-tools.ts` so each tool module stays
// under the size budget. Chromium cannot add/remove extensions on a live context,
// so install/reload/uninstall close the BrowserSession, relaunch with the updated
// `--load-extension` flags, and splice the new inner pieces onto the existing
// SessionEntry. The per-server boundary deps (caps / configStore / workspace /
// launch options) are threaded in EXPLICITLY — never a module-global — preserving
// the composition root's per-server isolation. Behaviour is byte-identical to the
// prior in-closure helper; only the dependency wiring is made explicit.

import { DEFAULT_SESSION_ID, type SessionEntry } from "../session/registry.js";
import { openManagedSession } from "../session/managed.js";
import { resolveDevice } from "../session/device.js";
import { reapplyAll as reapplyEmulation } from "../session/emulation.js";
import { attachDialogPolicy } from "../session/dialog.js";
import {
  attachPermissionPolicy,
  applyCdpBaseline as applyPermissionCdpBaseline,
} from "../session/permission.js";
import { attachNotificationPolicy } from "../session/notification.js";
import { attachFsPickerPolicy, type FsPickerFile } from "../session/fs-picker.js";
import { attachDeviceEmulation } from "../session/device-emu.js";
import { RefRegistry } from "../page/refs.js";
import { snapshotSubstrateFor } from "../page/snapshot-substrate-select.js";
import { networkSubstrateFor } from "../page/network-substrate-select.js";
import { WsInteractiveRegistry } from "../page/ws-interactive.js";
import { WorkersRegistry } from "../page/workers.js";
import { ConsoleBuffer } from "../page/console.js";
import { BrowxBridge } from "../helper/bridge.js";
import { applyOverlayHide } from "../helper/overlay-hide.js";
import { applyStealth } from "../helper/stealth.js";
import { requireCdp } from "../engine/index.js";
import { log } from "../util/logging.js";
import type { CapabilityConfig } from "../util/capabilities.js";
import type { ConfigStore, ResolvedConfig } from "../util/config-store.js";
import type { Workspace } from "../util/workspace.js";
import type { StartOptions } from "../server.js";

/** The per-server boundary deps the rebuild threads in (was the closure the
 *  in-module helper held over `buildHost`'s scope). Passed explicitly so a second
 *  server in the same process can't cross-wire this server's sessions. */
export interface ExtensionRebuildDeps {
  caps: CapabilityConfig;
  configStore: ConfigStore;
  workspace: Workspace;
  opts: StartOptions;
  resolvedConfig: ResolvedConfig;
}

/** Rebuild the persistent session's browser context with the entry's current
 *  extension list reflected as launch flags. Closes the existing BrowserSession +
 *  bridge, relaunches via `openManagedSession`, and replaces the entry's inner
 *  pieces in-place so the registry mapping (sessionId → entry) stays valid. Caller
 *  MUST have verified the entry is `persistent` and not headless (via the
 *  extension-refusal check). */
export async function rebuildPersistentForExtensions(
  e: SessionEntry,
  deps: ExtensionRebuildDeps,
): Promise<void> {
  const { caps, configStore, workspace, opts, resolvedConfig } = deps;
    const headless = opts.headless ?? resolvedConfig.headless;
    const disableWebSecurity = configStore.resolve().disableWebSecurity === true;
    const profileName = e.launchProfile ?? e.id;
    const profileDir =
      e.id === DEFAULT_SESSION_ID && !e.launchProfile
        ? workspace.sub("profile")
        : workspace.sub(`profiles/${profileName}`);
    const extensionPaths = e.extensions.loaded.filter((x) => x.enabled).map((x) => x.path);
    // Preserve the engine across the rebuild (extensions are Chromium-only, so
    // this is chromium today; reading it before close keeps the rebuild engine-
    // faithful for when a second engine lands).
    const rebuildEngine = e.session.engine;
    // Tear down the current session BEFORE relaunching — Chromium will not
    // open a second persistent context on the same profile dir.
    await e.bridge.detach().catch(() => undefined);
    await e.session.close().catch(() => undefined);
    // Resolve device fresh from the current resolved config (no spec stored
    // post-creation; the device-emulation state on `e.deviceEmulation` is
    // re-applied below).
    const device = resolveDevice({
      device: resolvedConfig.defaultDevice,
      viewport: resolvedConfig.defaultViewport,
    });
    const sess = await openManagedSession({
      headless,
      profileDir,
      device,
      disableWebSecurity,
      browserType: rebuildEngine,
      ...(extensionPaths.length ? { extensionPaths } : {}),
    });
    // Rebuild the per-session inner pieces. The secrets / dialog policy /
    // device-emulation state survive on the entry (intentional — they are
    // operator-supplied across rebuilds); buffers and refs are replaced
    // since they referenced the now-closed CDP session.
    const consoleBuf = new ConsoleBuffer();
    consoleBuf.attach(sess.page());
    // Re-select the network substrate on the rebuilt context (extensions are
    // chromium-only, so this stays the CDP substrate — but routing through the
    // selector keeps the rebuild engine-agnostic and the entry's substrate live).
    const networkSub = networkSubstrateFor(sess);
    await networkSub.attach();
    const networkBuf = networkSub.http;
    const wsBuf = networkSub.ws;
    consoleBuf.setSecrets(e.secrets);
    networkSub.setSecrets(e.secrets);
    const br = new BrowxBridge();
    await br.attach(sess.page().context());
    attachDialogPolicy(sess.page().context(), e.dialog);
    // Re-attach permission policy on the rebuilt context. The state's
    // wired-contexts WeakSet ensures the new context is treated as fresh
    // (the old one was torn down), so the binding + init-script install
    // afresh and the CDP baseline is re-applied.
    await attachPermissionPolicy(
      sess.page().context(),
      e.permission,
      async (permission, origin) => {
        log.info(
          `permission ask-human: ${permission}${origin ? ` (${origin})` : ""} → call __browx.confirm(true|false) in DevTools to respond`,
        );
        try {
          const sig = await br.awaitSignal("respond", 300_000);
          const data = sig.data as { kind?: string; value?: unknown } | null;
          if (data && data.kind === "confirm" && data.value === true) return "allow";
          return "deny";
        } catch {
          return "deny";
        }
      },
    );
    await applyPermissionCdpBaseline(sess.page().context(), e.permission).catch(() => undefined);
    // Re-attach notification-constructor policy on the rebuilt context. The
    // state's wired-contexts WeakSet ensures the new context is treated as
    // fresh (the old one was torn down), so the binding + init-script install
    // afresh and the sync-decision hint is re-seeded.
    await attachNotificationPolicy(sess.page().context(), e.notification, async (n) => {
      log.info(
        `notification ask-human: ${JSON.stringify({ title: n.title, origin: n.origin })} → call __browx.confirm(true|false) in DevTools to respond`,
      );
      try {
        const sig = await br.awaitSignal("respond", 300_000);
        const data = sig.data as { kind?: string; value?: unknown } | null;
        if (data && data.kind === "confirm" && data.value === true) return "allow";
        return "deny";
      } catch {
        return "deny";
      }
    });
    // Re-attach fs-picker policy on the rebuilt context. WeakSet inside the
    // state treats the new context as fresh — binding + init script are
    // re-installed, write-target handles for the previous context are
    // garbage-collected with it.
    await attachFsPickerPolicy(
      sess.page().context(),
      e.fsPicker,
      workspace.root,
      async (api, suggestedName) => {
        log.info(
          `fs-picker ask-human: ${api}${suggestedName ? ` (${suggestedName})` : ""} → call __browx.respond({files:[…]}) in DevTools (or fs_picker_respond) to answer`,
        );
        try {
          const sig = await br.awaitSignal("respond", 300_000);
          const data = sig.data as { kind?: string; value?: unknown } | null;
          if (
            data &&
            data.kind === "fs_picker_respond" &&
            Array.isArray((data.value as { files?: unknown })?.files)
          ) {
            return (data.value as { files: FsPickerFile[] }).files;
          }
          return null;
        } catch {
          return null;
        }
      },
    ).catch(() => undefined);
    await applyOverlayHide(sess.page().context(), configStore.resolve().hideOverlaySelectors);
    // Re-apply per-context stealth init-script (capability `stealth`) on the
    // rebuilt context. Stealth must engage on every navigation post-rebuild,
    // not just on the original launch.
    if (caps.enabled.has("stealth")) {
      await applyStealth(sess.page().context()).catch((err) => {
        log.warn(
          `stealth: rebuild failed to apply init script — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    // Re-apply per-primitive device emulation state to the fresh context's
    // pages (locale/timezone/UA via CDP, geolocation/colour-scheme/reduced-
    // motion/permissions via Playwright). Best-effort — failures don't
    // abort the rebuild.
    try {
      await reapplyEmulation(
        sess.page().context(),
        sess.page(),
        requireCdp(sess),
        e.deviceEmulation,
      );
    } catch {
      /* best-effort */
    }
    // Re-attach Web Bluetooth / WebUSB / WebHID device-emulation wrappers on
    // the rebuilt context. The state's wired-contexts WeakSet treats the new
    // context as fresh — binding + init script reinstall, current catalog is
    // re-served verbatim on the next page-side requestDevice.
    await attachDeviceEmulation(sess.page().context(), e.webDeviceEmulation).catch(() => undefined);
    sess
      .page()
      .context()
      .on("page", (newPage) => {
        (async () => {
          try {
            const newCdp = await sess.page().context().newCDPSession(newPage);
            await reapplyEmulation(sess.page().context(), newPage, newCdp, e.deviceEmulation);
          } catch {
            /* best-effort */
          }
        })().catch(() => undefined);
      });
    // Splice the new pieces onto the existing entry — sessionId still maps
    // here so every caller holding `entry` keeps working.
    e.session = sess;
    e.console = consoleBuf;
    e.networkSubstrate = networkSub;
    e.network = networkBuf;
    e.ws = wsBuf;
    e.bridge = br;
    e.refs = new RefRegistry();
    // The rebuild minted a fresh CDP session on the new context; re-derive the
    // snapshot substrate so it captures the live handle (extensions are
    // chromium-only, so this stays the CDP substrate).
    e.snapshotSubstrate = snapshotSubstrateFor(sess);
    // Interactive-WS state is page-side; the rebuild destroyed the wrapper
    // and any active interceptors with it. Discard the server-side mirror
    // so it doesn't claim live interceptors that no longer exist, then
    // re-install the wrapper before any nav so the new context's first
    // page sees the wrapped WebSocket constructor.
    e.wsInteractive = new WsInteractiveRegistry();
    if (caps.enabled.has("action")) {
      await e.wsInteractive.install(sess.page()).catch(() => undefined);
    }
    // workers visibility. Rebuild destroyed the page-side wrapper
    // and any SW attachments; discard the server-side mirror and re-install.
    e.workers.dispose();
    e.workers = new WorkersRegistry();
    if (caps.enabled.has("read")) {
      await e.workers.installPageWrapper(sess.page()).catch(() => undefined);
    }
}
