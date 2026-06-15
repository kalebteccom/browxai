// The Playwright post-creation wiring (RFC 0004 D1 + D5). The four Playwright
// engines (chromium / firefox / webkit / android) register `playwrightPostWire`
// as their `EngineEntry.postWire`; safari registers its own minimal BiDi-console
// post-wire (safari.engine.ts). This is where the 17 scattered
// `sess.engine !== "safari"` guards in session-registry.ts collapse into ONE call
// — the engine that needs the Playwright bookkeeping owns it, the engine that
// does not (safari, and the synthetic in-memory engine) simply omits it.
//
// Every attach below is byte-identical to its pre-relocation form and runs in the
// EXACT same source order (console → bridge → dialog → permission → notification →
// fs-picker → downloads → overlay → stealth → device-emulation → ws-interactive →
// workers). The post-creation attaches are side-effects on the Playwright context;
// running them once the SessionEntry is assembled (rather than inline during
// construction) is observably identical because no navigation — and thus no
// console/network/dialog event — fires during session creation.
//
// Host deps (caps / configStore / workspace) are threaded in per server: the
// composition root (`buildSessionRegistry`) owns them and passes its OWN set as the
// `deps` argument to `playwrightPostWire(entry, deps)`. They are NOT a module-global
// — a module-global would let a second `createServer()` in the same process (the
// in-process SDK transport composes one server per transport) overwrite the first
// server's caps gate / workspace sandbox-root, so server A could start installing
// server B's action-gated wrappers + stealth scripts on A's OWN sessions. Threading
// explicitly keeps each server's post-wire bound to its own boundary. The
// per-session policy states + bridge are read off the SessionEntry.

import { log } from "../util/logging.js";
import type { SessionEntry } from "./registry.js";
import type { PostWireDeps } from "../engine/registry.js";
import { attachDialogPolicy } from "./dialog.js";
import {
  attachPermissionPolicy,
  applyCdpBaseline as applyPermissionCdpBaseline,
} from "./permission.js";
import { attachNotificationPolicy } from "./notification.js";
import { attachFsPickerPolicy, type FsPickerFile } from "./fs-picker.js";
import { attachDeviceEmulation } from "./device-emu.js";
import { reapplyAll as reapplyEmulation } from "./emulation.js";
import { attachDownloadCapture } from "../page/downloads.js";
import { applyOverlayHide } from "../helper/overlay-hide.js";
import { applyStealth } from "../helper/stealth.js";

/** Attach the full Playwright post-creation bookkeeping to a freshly-built
 *  SessionEntry, using the per-server `deps` (caps / configStore / workspace) the
 *  composition root threads in. Returns the promise the session factory awaits, so
 *  every context attach completes before the session is handed to a tool call —
 *  byte-identical to the pre-relocation inline awaits. */
export async function playwrightPostWire(entry: SessionEntry, deps: PostWireDeps): Promise<void> {
  const { caps, configStore, workspace } = deps;
  const sess = entry.session;
  const ctx = sess.page().context();
  const br = entry.bridge;

  // console — attach to the current + future pages. (Safari's console arrives
  // over BiDi in its own post-wire; every Playwright engine attaches here.)
  entry.console.attach(sess.page());

  // browser bridge — the page-side __browx signalling channel.
  await br.attach(ctx);

  // dialog policy — install per-page on current + future pages.
  attachDialogPolicy(ctx, entry.dialog);

  // permission policy — install per-context binding + init-script wrappers, plus
  // the CDP baseline (Browser.setPermission per supported name). The ask-human
  // handler routes through the bridge — `__browx.confirm(true|false)` from
  // page-side DevTools releases the wait. Best-effort: attach failures still leave
  // the CDP baseline below in place.
  await attachPermissionPolicy(ctx, entry.permission, async (permission, origin) => {
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
  });
  await applyPermissionCdpBaseline(ctx, entry.permission).catch(() => undefined);

  // notification-construction policy — per-context wrapper + binding around
  // `new Notification(...)`. Default `allow` preserves browser default.
  await attachNotificationPolicy(ctx, entry.notification, async (n) => {
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

  // File System Access picker policy — per-context binding + init-script stubs.
  // The server-side write target for `createWritable()` is workspace-rooted and
  // validated against `workspace.root` at `fs_picker_respond` time.
  await attachFsPickerPolicy(ctx, entry.fsPicker, workspace.root, async (api, suggestedName) => {
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
  }).catch(() => undefined);

  // Per-session download capture — always attach the context listener; when
  // capture is off it just discards Playwright's temp file.
  attachDownloadCapture(ctx, entry.downloads);

  // resolve overlay selectors fresh per session so a
  // `set_config({hideOverlaySelectors})` applies without a server restart.
  await applyOverlayHide(ctx, configStore.resolve().hideOverlaySelectors);

  // Per-context stealth init-script patches (capability `stealth`). Off by
  // default; when on, overrides navigator.webdriver / plugins / languages /
  // window.chrome on every page before page scripts run.
  if (caps.enabled.has("stealth")) {
    await applyStealth(ctx).catch((err) => {
      log.warn(
        `stealth: failed to apply init script — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // Per-session device-emulation: attach the synthetic Web Bluetooth/USB/HID
  // catalogs + the per-page reapply of locale/timezone/UA overrides.
  await attachDeviceEmulation(ctx, entry.webDeviceEmulation).catch(() => undefined);
  ctx.on("page", (newPage) => {
    // Best-effort: a new tab fires here. Create its own CDP session to route
    // locale/timezone/UA overrides. Errors swallowed — re-apply never breaks a
    // navigation.
    (async () => {
      try {
        const newCdp = await sess.page().context().newCDPSession(newPage);
        await reapplyEmulation(sess.page().context(), newPage, newCdp, entry.deviceEmulation);
      } catch {
        /* best-effort */
      }
    })().catch(() => undefined);
  });

  // ws-interactive — install the page-side WS wrapper EAGERLY (capability-gated
  // on `action`) so a page that constructs `new WebSocket(...)` during initial
  // document parse hits the wrapped constructor.
  if (caps.enabled.has("action")) {
    await entry.wsInteractive.install(sess.page()).catch(() => undefined);
  }

  // workers — same eager-install posture (capability-gated on `read`): the
  // page-side Worker-constructor wrapper must be live before any document parse.
  if (caps.enabled.has("read")) {
    await entry.workers.installPageWrapper(sess.page()).catch(() => undefined);
  }
}
