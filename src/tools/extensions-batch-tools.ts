import { DEFAULT_SESSION_ID, type SessionEntry } from "../session/registry.js";
import { openManagedSession } from "../session/managed.js";
import { resolveDevice } from "../session/device.js";
import { reapplyAll as reapplyEmulation } from "../session/emulation.js";
import {
  resolveExtensionPath,
  readManifest,
  refuseIfUnsupported as refuseExtensionsIfUnsupported,
  applyInstall as applyExtensionInstall,
  applyUninstall as applyExtensionUninstall,
  applyReload as applyExtensionReload,
  type LoadedExtension,
} from "../session/extensions.js";
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
import { captureDomMap, diffDomMaps } from "../page/dom_diff.js";
import { sampleMetric, ELEMENT_METRICS } from "../page/sample.js";
import { ConsoleBuffer } from "../page/console.js";
import { estimateTokens } from "../util/tokens.js";
import { BrowxBridge } from "../helper/bridge.js";
import { applyOverlayHide } from "../helper/overlay-hide.js";
import { applyStealth } from "../helper/stealth.js";
import { requireCdp } from "../engine/index.js";
import { log } from "../util/logging.js";
import { runBatch } from "../util/batch.js";
import { runFlakeCheck } from "../util/flake-check.js";
import { SESSION_ARG, REF_OR_SELECTOR } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Chrome-extension management + the server-side compound primitives:
 * extensions_install / extensions_list / extensions_reload /
 * extensions_trigger / extensions_uninstall, plus await_human, batch,
 * act_and_sample, act_and_diff, flake_check. Every block is registered through
 * the shared `ToolHost` seam; the host owns the closures, this module owns the
 * registrations. The extension tools rebuild the underlying browser context on
 * mutation (Chromium can't add/remove extensions on a live context).
 */
export function registerExtensionsBatchTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    engineGate,
    entryFor,
    asTarget,
    toolHandlers,
    caps,
    workspace,
    configStore,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
    startOptions: opts,
    resolvedConfig,
  } = host;

  // ---------- extensions registry (capability `extensions`) ----------
  //
  // Per-session Chrome extension management. Off-by-default capability;
  // loud-warned at boot. The 5 tools below all gate behind `extensions` AND
  // additionally refuse on incognito / attached sessions and on headless
  // launches (see src/session/extensions.ts for the rationale).
  //
  // install/reload/uninstall mutate the session's extension list AND rebuild
  // the underlying browser context — Chromium does not support adding/
  // removing extensions on a live context. The rebuild closes the current
  // BrowserSession, relaunches `openManagedSession` with the updated
  // `--load-extension` / `--disable-extensions-except` flags, and splices
  // the new inner pieces (session, console, network, ws, bridge, refs) onto
  // the existing SessionEntry. Profile state on disk (cookies, localStorage,
  // IndexedDB) survives; in-memory refs / buffers do not.

  /** Pure refusal check for the extension tools. Returns a typed early-exit
   *  envelope when the session is incognito / attached / headless; null when
   *  the session can host extensions. */
  const extensionRefusal = (e: SessionEntry, tool: string) => {
    if (e.mode === "persistent" || e.mode === "incognito" || e.mode === "attached") {
      const headless = !!(opts.headless ?? resolvedConfig.headless);
      const r = refuseExtensionsIfUnsupported({ mode: e.mode, headless, tool });
      if (r) {
        const body = { ok: false, error: r.error, hint: r.hint };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    }
    return null;
  };

  /** Rebuild the persistent session's browser context with the entry's
   *  current extension list reflected as launch flags. Closes the existing
   *  BrowserSession + bridge, relaunches via `openManagedSession`, and
   *  replaces the entry's inner pieces in-place so the registry mapping
   *  (sessionId → entry) stays valid. Caller MUST have verified the entry
   *  is `persistent` and not headless (via `extensionRefusal`). */
  const rebuildPersistentForExtensions = async (e: SessionEntry): Promise<void> => {
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
  };

  /** Envelope helper for the extension tools. */
  const extensionEnvelope = (
    e: SessionEntry,
    extra: Record<string, unknown>,
  ): { content: Array<{ type: "text"; text: string }> } => {
    const body: Record<string, unknown> = {
      ok: true,
      session: e.id,
      loaded: e.extensions.loaded.map((x): LoadedExtension => ({ ...x })),
      ...extra,
    };
    body.tokensEstimate = estimateTokens(JSON.stringify(body));
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  };

  const extensionErrorEnvelope = (
    tool: string,
    err: unknown,
  ): { content: Array<{ type: "text"; text: string }> } => {
    const body = {
      ok: false,
      action: { type: tool },
      error: err instanceof Error ? err.message : String(err),
    };
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
            null,
            2,
          ),
        },
      ],
    };
  };

  register(
    "extensions_install",
    {
      capability: "extensions",
      deep: true,
      description:
        "Load an unpacked Chromium extension (MV3 or MV2 directory containing `manifest.json`) into the session's managed-profile launch. **Gated behind the off-by-default `extensions` capability** — same posture class as `eval` / `network-body` / `secrets`. Loaded extensions can READ every page the session visits and make ARBITRARY network requests; the extension code itself becomes trust-equivalent to the agent. " +
        "`path` is workspace-rooted (under $BROWX_WORKSPACE) — traversal / absolute-outside is rejected. Pass the UNPACKED extension directory; `.crx` packed archives must be unpacked first (the directory must contain `manifest.json`). " +
        "Headed + persistent only — incognito / attached / headless sessions REFUSE with a structured error and hint. **install REBUILDS the underlying browser context** (Chromium doesn't support adding extensions to a live context): the current page navigates to about:blank, refs invalidate, console/network/ws buffers reset. Profile state on disk (cookies, localStorage, IndexedDB) survives. Treat install as a session-restart. " +
        "Returns `{ok, session, installed:{id,name,version,path}, loaded:[…], note?, tokensEstimate}`. The `id` is a stable hash of the resolved path — pass it back to `extensions_reload` / `extensions_trigger` / `extensions_uninstall`.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Workspace-rooted directory of the unpacked extension (must contain `manifest.json`).",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ path, session }: { path: string; session?: string }) => {
      const g = gateCheck("extensions_install");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_install", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_install");
      if (refused) return refused;
      let resolved: string;
      let manifest;
      try {
        resolved = resolveExtensionPath(workspace.root, path, "extensions_install");
        manifest = readManifest(resolved, "extensions_install");
      } catch (err) {
        return extensionErrorEnvelope("extensions_install", err);
      }
      let installed;
      try {
        const r = applyExtensionInstall(
          e.extensions,
          { path: resolved, name: manifest.name, version: manifest.version },
          "extensions_install",
        );
        e.extensions.loaded = r.loaded;
        installed = e.extensions.loaded.find((x) => x.id === r.id)!;
      } catch (err) {
        return extensionErrorEnvelope("extensions_install", err);
      }
      try {
        await rebuildPersistentForExtensions(e);
      } catch (err) {
        // rebuild failed — roll back the registry so the next call doesn't
        // try to re-apply a now-doomed extension list.
        e.extensions.loaded = e.extensions.loaded.filter((x) => x.id !== installed.id);
        return extensionErrorEnvelope("extensions_install", err);
      }
      return extensionEnvelope(e, {
        installed: {
          id: installed.id,
          name: installed.name,
          version: installed.version,
          path: installed.path,
        },
        note: "browser context rebuilt — refs / console / network / ws buffers reset; on-disk profile state preserved",
      });
    },
  );

  register(
    "extensions_list",
    {
      capability: "extensions",
      deep: true,
      description:
        "List extensions currently loaded for this session. Returns `[{id, name, version, path, enabled}]`. Empty list when no extension is loaded (the default). Gated behind the off-by-default `extensions` capability — disabled sessions return a structured error before reaching this list. Headed + persistent sessions only.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }: { session?: string }) => {
      const g = gateCheck("extensions_list");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_list", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_list");
      if (refused) return refused;
      return extensionEnvelope(e, {});
    },
  );

  register(
    "extensions_reload",
    {
      capability: "extensions",
      deep: true,
      description:
        "Reload an installed extension: re-parse its `manifest.json`, then rebuild the underlying browser context so Chromium re-injects content scripts and restarts the MV3 service worker. Identify the extension by its `id` (from `extensions_install` / `extensions_list`). Same rebuild caveat as install — refs / buffers reset, on-disk profile state survives. Headed + persistent sessions only.",
      inputSchema: {
        id: z.string().describe("Extension id returned by extensions_install / extensions_list."),
        ...SESSION_ARG,
      },
    },
    async ({ id, session }: { id: string; session?: string }) => {
      const g = gateCheck("extensions_reload");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_reload", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_reload");
      if (refused) return refused;
      const target = e.extensions.loaded.find((x) => x.id === id);
      if (!target) {
        return extensionErrorEnvelope(
          "extensions_reload",
          new Error(
            `no extension with id "${id}" is loaded in this session (call extensions_list to see ids)`,
          ),
        );
      }
      let parsed;
      try {
        parsed = readManifest(target.path, "extensions_reload");
      } catch (err) {
        return extensionErrorEnvelope("extensions_reload", err);
      }
      try {
        const r = applyExtensionReload(e.extensions, id, parsed, "extensions_reload");
        e.extensions.loaded = r.loaded;
      } catch (err) {
        return extensionErrorEnvelope("extensions_reload", err);
      }
      try {
        await rebuildPersistentForExtensions(e);
      } catch (err) {
        return extensionErrorEnvelope("extensions_reload", err);
      }
      const after = e.extensions.loaded.find((x) => x.id === id);
      return extensionEnvelope(e, {
        reloaded: after
          ? { id: after.id, name: after.name, version: after.version, path: after.path }
          : null,
        note: "browser context rebuilt — content scripts re-injected; refs / buffers reset",
      });
    },
  );

  register(
    "extensions_trigger",
    {
      capability: "extensions",
      deep: true,
      description:
        "Best-effort invoke of an installed extension's surface. With `command`, attempts to fire the keyboard-command binding declared in the extension's manifest (`commands` key). Without `command`, navigates the session's active page to the extension's `chrome-extension://<id>/<default_popup>` URL so the popup renders in-tab and is driveable like any other page. Many extensions lack both surfaces; this tool returns `ok:false` with a clear reason in those cases. Read-only side-effects on the extension itself — it does not mutate the loaded list. Headed + persistent sessions only.\n\n" +
        "**Note on `id`.** browxai's id (a hash of the path) does NOT necessarily equal the Chrome-runtime id of the loaded extension — Chrome derives its id from the extension's signing key when one is present. For popup-style triggers we attempt to read the active page's `chrome-extension://` runtime id from the context's service workers / background pages; on a mismatch the tool returns a hint pointing at extensions_list and the page's own discovery.",
      inputSchema: {
        id: z.string().describe("Extension id returned by extensions_install / extensions_list."),
        command: z
          .string()
          .optional()
          .describe(
            'Optional manifest `commands` binding name to fire (e.g. "_execute_action"). Omit to open the extension\'s default_popup in the active page.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ id, command, session }: { id: string; command?: string; session?: string }) => {
      const g = gateCheck("extensions_trigger");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_trigger", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_trigger");
      if (refused) return refused;
      const target = e.extensions.loaded.find((x) => x.id === id);
      if (!target) {
        return extensionErrorEnvelope(
          "extensions_trigger",
          new Error(
            `no extension with id "${id}" is loaded in this session (call extensions_list to see ids)`,
          ),
        );
      }
      try {
        // Resolve the Chrome-runtime id of the extension by inspecting the
        // context's service-worker / background-page URLs (both start with
        // `chrome-extension://<runtime-id>/`). We don't fail when this comes
        // up empty — the result surfaces the discovered ids so the caller
        // can decide.
        const ctx = e.session.page().context();
        // service workers (MV3) — newer Playwright surfaces them; older
        // builds may not. Best-effort.
        const sw =
          (
            ctx as unknown as { serviceWorkers?: () => Array<{ url: () => string }> }
          ).serviceWorkers?.() ?? [];
        const swIds = sw
          .map((w) => w.url())
          .filter((u) => u.startsWith("chrome-extension://"))
          .map((u) => u.slice("chrome-extension://".length).split("/")[0]!);
        // background pages (MV2)
        const bgPages =
          (
            ctx as unknown as { backgroundPages?: () => Array<{ url: () => string }> }
          ).backgroundPages?.() ?? [];
        const bgIds = bgPages
          .map((p) => p.url())
          .filter((u) => u.startsWith("chrome-extension://"))
          .map((u) => u.slice("chrome-extension://".length).split("/")[0]!);
        const runtimeIds = Array.from(new Set([...swIds, ...bgIds]));
        // We can't reliably map our path-hash id to the runtime id without
        // parsing the manifest's `key` field — when there's exactly one
        // loaded extension AND one runtime id we assume the mapping.
        const runtimeId =
          runtimeIds.length === 1 && e.extensions.loaded.length === 1 ? runtimeIds[0] : undefined;
        if (command) {
          // Chrome keyboard-command bindings are user-keyboard-only; CDP has
          // no public surface to dispatch them programmatically. Return a
          // structured "not supported" rather than silently no-op.
          return extensionErrorEnvelope(
            "extensions_trigger",
            new Error(
              `extensions_trigger: keyboard command "${command}" — Chromium does not expose extension keyboard-command dispatch via CDP / Playwright. ` +
                `Workaround: invoke the extension's underlying behaviour via its content-script API or open its popup (call extensions_trigger without \`command\`).`,
            ),
          );
        }
        if (!runtimeId) {
          return extensionErrorEnvelope(
            "extensions_trigger",
            new Error(
              `extensions_trigger: cannot determine Chrome-runtime extension id for path-hash id "${id}". ` +
                `Browxai's id is a hash of the unpacked path and does NOT necessarily equal Chrome's runtime id (Chrome derives that from the manifest \`key\` when present). ` +
                `runtimeIdsDetected: ${JSON.stringify(runtimeIds)}; loaded: ${e.extensions.loaded.length}. ` +
                `Workaround: navigate the page directly to the extension popup URL once you know the runtime id.`,
            ),
          );
        }
        // Open the extension's popup (or its background page) in the active
        // page. The extension serves `chrome-extension://<id>/` from its
        // manifest's `action.default_popup` / `browser_action.default_popup`.
        const url = `chrome-extension://${runtimeId}/`;
        await e.session
          .page()
          .goto(url, { waitUntil: "domcontentloaded" })
          .catch(() => undefined);
        return extensionEnvelope(e, {
          triggered: { id, runtimeId, url, command: command ?? null },
          note: "best-effort: navigated active page to extension root; default_popup discovery depends on the extension's manifest",
        });
      } catch (err) {
        return extensionErrorEnvelope("extensions_trigger", err);
      }
    },
  );

  register(
    "extensions_uninstall",
    {
      capability: "extensions",
      deep: true,
      description:
        "Remove an installed extension from the session and rebuild the underlying browser context without it. Same rebuild caveat as install — refs / buffers reset, on-disk profile state survives. Headed + persistent sessions only.",
      inputSchema: {
        id: z.string().describe("Extension id returned by extensions_install / extensions_list."),
        ...SESSION_ARG,
      },
    },
    async ({ id, session }: { id: string; session?: string }) => {
      const g = gateCheck("extensions_uninstall");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("extensions_uninstall", e);
      if (eg) return eg;
      const refused = extensionRefusal(e, "extensions_uninstall");
      if (refused) return refused;
      let removed;
      try {
        const r = applyExtensionUninstall(e.extensions, id, "extensions_uninstall");
        e.extensions.loaded = r.loaded;
        removed = r.removed;
      } catch (err) {
        return extensionErrorEnvelope("extensions_uninstall", err);
      }
      try {
        await rebuildPersistentForExtensions(e);
      } catch (err) {
        // rebuild failed after registry mutation — restore the entry so the
        // agent can retry the operation. The original BrowserSession is
        // already torn down (we cannot recover it), so the session itself
        // is in a degraded state; surface that explicitly.
        return extensionErrorEnvelope(
          "extensions_uninstall",
          new Error(
            `(post-rebuild) ${err instanceof Error ? err.message : String(err)} — session "${e.id}" is now in a degraded state; close it and open a fresh one.`,
          ),
        );
      }
      return extensionEnvelope(e, {
        uninstalled: {
          id: removed.id,
          name: removed.name,
          version: removed.version,
          path: removed.path,
        },
        note: "browser context rebuilt without this extension — refs / buffers reset",
      });
    },
  );

  // ---------- human↔agent helper ----------

  register(
    "await_human",
    {
      capability: "human",
      description:
        "Block until the human responds in the page. Operator reads `prompt` from the server's stderr (or a future banner UI) and triggers a response from DevTools:\n" +
        "  - `acknowledge` → `__browx.proceed()` (or `signal('proceed')`)\n" +
        "  - `confirm`     → `__browx.confirm(true|false)`\n" +
        "  - `choose`      → `__browx.choose(<index-into-choices>)`\n" +
        "  - `input`       → `__browx.input('typed text')`\n" +
        "Returns `{ kind, value, timedOut }`. `pick_element` kind (in-page hover-pick overlay) is deferred to .",
      inputSchema: {
        kind: z.enum(["acknowledge", "confirm", "choose", "input"]).default("acknowledge"),
        prompt: z
          .string()
          .describe("Human-readable instruction shown to the operator (logged to stderr)."),
        choices: z
          .array(z.string())
          .optional()
          .describe(
            'For `kind:"choose"` — labels shown in the prompt; the human responds with an index into this list.',
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(3_600_000)
          .optional()
          .describe(
            "Human response window (ms). Human-paced default 300000 (5min); hard max 3600000 (1h). " +
              "there is no infinite wait — an unanswered prompt times out (the only previously " +
              "unbounded path). For unattended runs use `approve_actions` instead of a long wait.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ kind, prompt, choices, timeoutMs, session }) => {
      const g = gateCheck("await_human");
      if (g) return g;
      const e = await entryFor(session);
      // kill the only infinite path. 0/unset → 5min human-paced default,
      // hard-capped at 1h. await_human is human-paced — NOT under the 5s
      // action default — but never unbounded.
      const humanMs = Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : 300_000, 3_600_000);
      const promptBody =
        kind === "choose" && choices
          ? `${prompt}\n${choices.map((c: string, i: number) => `    [${i}] ${c}`).join("\n")}\n→ call __browx.choose(<index>) in DevTools to respond`
          : kind === "confirm"
            ? `${prompt} → call __browx.confirm(true|false)`
            : kind === "input"
              ? `${prompt} → call __browx.input('your text')`
              : `${prompt} → call __browx.proceed() to release`;
      log.info(`await_human (${kind}): ${promptBody}`);
      const signalName = kind === "acknowledge" ? "proceed" : "respond";
      try {
        const sig = await e.bridge.awaitSignal(signalName, humanMs);
        // For typed kinds the page sends `{ kind, value }`; for acknowledge it sends any/null.
        let value: unknown = sig.data;
        if (
          kind !== "acknowledge" &&
          sig.data &&
          typeof sig.data === "object" &&
          "value" in (sig.data as Record<string, unknown>)
        ) {
          value = (sig.data as { value: unknown }).value;
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ kind, value, timedOut: false }, null, 2) },
          ],
        };
      } catch (e) {
        const timedOut = e instanceof Error && e.message.includes("timed out");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  kind,
                  value: null,
                  timedOut,
                  error: timedOut ? undefined : e instanceof Error ? e.message : String(e),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---------- batch protocol primitive ----------

  const BATCH_MAX_CALLS = 32;

  register(
    "batch",
    {
      description:
        "Run a sequence of tool calls server-side and return their results as one response. Eliminates round-trip overhead for known-safe sequences (e.g. fill several fields then submit). Each call is dispatched through the same handlers as a top-level call; capability gating, confirmation hooks, and ActionResults are unchanged. Stops at the first failure unless `stopOnError: false`. Disallows nested `batch` and human-blocking tools.",
      inputSchema: {
        calls: z
          .array(
            z.object({
              tool: z.string().describe("Tool name (must be in the batch whitelist)"),
              args: z
                .record(z.unknown())
                .optional()
                .describe("Args for the inner tool, same shape as a top-level call"),
              label: z
                .string()
                .optional()
                .describe("opaque label echoed in the result entry for cross-referencing"),
              expect: z
                .object({
                  valueEquals: z.string().optional(),
                  displayTextIncludes: z.string().optional(),
                  controlDisplayTextIncludes: z.string().optional(),
                  containerTextIncludes: z.string().optional(),
                  controlChanged: z.boolean().optional(),
                })
                .optional()
                .describe(
                  "optional post-call assertions on the inner ActionResult's element probe. Failing any assertion marks the call ok=false with `error: 'expect failed: …'` and respects `stopOnError`.",
                ),
            }),
          )
          .min(1)
          .max(BATCH_MAX_CALLS)
          .describe(`Up to ${BATCH_MAX_CALLS} inner calls. Run sequentially.`),
        stopOnError: z
          .boolean()
          .optional()
          .describe(
            "Default true. When true, the first inner-call failure halts the batch. When false, every call is attempted and individual results carry their own ok/error.",
          ),
      },
    },
    async ({
      calls,
      stopOnError,
    }: {
      calls: Array<{
        tool: string;
        args?: Record<string, unknown>;
        label?: string;
        expect?: import("../util/batch.js").BatchExpect;
      }>;
      stopOnError?: boolean;
    }) => {
      const g = gateCheck("batch");
      if (g) return g;
      const report = await runBatch(calls, {
        allowed: BATCH_ALLOWED_TOOLS,
        handlers: toolHandlers,
        stopOnError,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );

  // ---------- act-then-trace ----------

  register(
    "act_and_sample",
    {
      capability: "read",
      description:
        "run ONE action and capture a metric trace *across its transition*, in one call — closes the state-capture-latency blind spot (a separate read lands after the spinner/pending UI already resolved). The sampler (fixed-enum, no agent JS) starts, the inner action dispatches concurrently, both are awaited. `action` is `{tool,args}` from the batch whitelist (no `batch`/`await_human`/recording/self); the inner tool's capability + deadline + the confirm hooks still apply. Sample target via `ref`/`selector`/`named` (or omit for the document scroller; not coords). Returns `{ action: <inner result>, ...sampleResult }`.",
      inputSchema: {
        action: z.object({
          tool: z.string().describe("Inner tool name (batch whitelist)."),
          args: z
            .record(z.unknown())
            .optional()
            .describe("Inner tool args (same shape as a top-level call)."),
        }),
        ...REF_OR_SELECTOR,
        metric: z.enum(ELEMENT_METRICS).describe("Fixed metric to trace (same enum as `sample`)."),
        durationMs: z.number().int().positive().max(30_000).describe("Trace window (ms, ≤30000)."),
        everyFrame: z
          .boolean()
          .optional()
          .describe("Sample every animation frame (rAF). Default false → fixed interval."),
        intervalMs: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Interval (ms, default 100, min 16). Ignored when everyFrame:true."),
        summary: z
          .boolean()
          .optional()
          .describe(
            "Series-omission control (summary always returned). true=omit series; false=always include; omit=auto-omit for large windows (>300 pts, sets `autoSummarised`).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("act_and_sample");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "act_and_sample") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `act_and_sample: inner tool "${innerTool}" not allowed (must be in the batch whitelist; no batch / await_human / recording / self)`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const ig = gateCheck(innerTool);
      if (ig) return ig; // enforce the inner tool's own capability gate
      const e = await entryFor(args.session);
      let sampleTarget;
      if (args.ref || args.selector || args.named || args.coords) {
        const t = asTarget(args, "act_and_sample", e.refs);
        if ("coords" in t) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error:
                      "act_and_sample: sample target can't be coords — use ref/selector/named or omit for the window",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        sampleTarget = t;
      }
      // Start the sampler, then dispatch the inner action concurrently so the
      // trace spans the transition. Sampler self-bounds via durationMs; the
      // inner action self-bounds via the anti-wedge deadline. Both await.
      const samplePromise = sampleMetric(e.session.page(), e.refs, {
        target: sampleTarget,
        metric: args.metric,
        durationMs: args.durationMs,
        everyFrame: args.everyFrame,
        intervalMs: args.intervalMs,
        summary: args.summary,
      });
      const innerArgs = { ...(args.action.args ?? {}), session: args.session };
      const [sRes, aRes] = await Promise.allSettled([
        samplePromise,
        toolHandlers[innerTool]!(innerArgs),
      ]);
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      const sampleOut =
        sRes.status === "fulfilled"
          ? sRes.value
          : { error: sRes.reason instanceof Error ? sRes.reason.message : String(sRes.reason) };
      const actionOut =
        aRes.status === "fulfilled"
          ? parseInner(aRes.value)
          : {
              ok: false,
              error: aRes.reason instanceof Error ? aRes.reason.message : String(aRes.reason),
            };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ action: actionOut, sample: sampleOut }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "act_and_diff",
    {
      capability: "read",
      description:
        "Run ONE action and report the DOM changes it caused within a `scope` — for selection-heavy UIs where the state change (which clip/row became selected) shows only as class / `aria-*` / `data-*` / inline-style changes, invisible to snapshot/find/text_search. Captures a structural DOM map before, dispatches the inner action, captures after, diffs. `action` is `{tool,args}` from the batch whitelist (no `batch`/`await_human`/recording/self); the inner tool's capability + deadline still apply. Returns `{ action: <inner result>, diff: { changed:[{path,tag,testId,classDelta,styleDelta,attrDelta}], added, removed, counts } }`.",
      inputSchema: {
        action: z.object({
          tool: z.string().describe("Inner tool name (batch whitelist)."),
          args: z.record(z.unknown()).optional().describe("Inner tool args."),
        }),
        scope: z
          .string()
          .optional()
          .describe(
            "CSS selector to bound the diff (default: document.body). Must exist before AND after the action.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("act_and_diff");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "act_and_diff") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `act_and_diff: inner tool "${innerTool}" not allowed (batch whitelist; no batch / await_human / recording / self)`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const ig = gateCheck(innerTool);
      if (ig) return ig;
      const e = await entryFor(args.session);
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      try {
        const before = await captureDomMap(e.session.page(), args.scope);
        const innerArgs = { ...(args.action.args ?? {}), session: args.session };
        const actionResp = await toolHandlers[innerTool]!(innerArgs);
        const after = await captureDomMap(e.session.page(), args.scope);
        const diff = diffDomMaps(before, after);
        // Egress sink — `diff.changed[].classDelta` / `styleDelta` / `attrDelta`
        // surface raw attribute / inline-style values (e.g. `aria-label="hunter2"`
        // or `style="background-image: url(?token=hunter2)"`). The inner-action
        // response was already masked by its own handler; the diff is the
        // remaining literal-value channel and is masked here.
        const maskedDiff = caps.enabled.has("secrets") ? e.secrets.applyMaskDeep(diff) : diff;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ action: parseInner(actionResp), diff: maskedDiff }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---------- flake-check ----------

  register(
    "flake_check",
    {
      capability: "action",
      description:
        "Run the same call sequence N times and report what shifted between runs — for diagnosing intermittent CI flakes BEFORE chasing them through logs. Inner calls are dispatched through the `batch` whitelist (capability + confirm hooks unchanged); each run uses `stopOnError:false` internally so a mid-sequence failure does NOT hide the variance picture for later steps. Returns per-step success-rate, distinct errors, distinct resolution signatures, the earliest `firstDivergence` step where ok shifted across runs, and a `cachedResolvers[]` artifact — `{step → resolved ref/selectorHint}` for steps where every run agreed AND succeeded. The artifact mirrors the `ActionDescriptor` shape for `plan` steps so a follow-up call can re-execute against a fresh snapshot. `stopOnAllGreen: K` short-circuits when K consecutive runs are all-green (skips redundant work once you've proved the sequence is stable).",
      inputSchema: {
        calls: z
          .array(
            z.object({
              tool: z.string().describe("Tool name (must be in the batch whitelist)"),
              args: z
                .record(z.unknown())
                .optional()
                .describe("Args for the inner tool, same shape as a top-level call"),
              label: z
                .string()
                .optional()
                .describe("opaque label echoed in the result entry for cross-referencing"),
              expect: z
                .object({
                  valueEquals: z.string().optional(),
                  displayTextIncludes: z.string().optional(),
                  controlDisplayTextIncludes: z.string().optional(),
                  containerTextIncludes: z.string().optional(),
                  controlChanged: z.boolean().optional(),
                })
                .optional()
                .describe(
                  "optional post-call assertions on the inner ActionResult — same shorthand vocabulary as `batch`.",
                ),
            }),
          )
          .min(1)
          .max(BATCH_MAX_CALLS)
          .describe(`Up to ${BATCH_MAX_CALLS} inner calls. Same shape and whitelist as \`batch\`.`),
        n: z
          .number()
          .int()
          .min(3)
          .max(20)
          .describe(
            "How many times to repeat the call sequence. Bounded [3, 20] — fewer than 3 can't surface intermittent flakes; more than 20 burns server time without sharpening the picture.",
          ),
        stopOnAllGreen: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Short-circuit when this many consecutive runs all-pass. Off by default."),
      },
    },
    async ({
      calls,
      n,
      stopOnAllGreen,
    }: {
      calls: Array<{
        tool: string;
        args?: Record<string, unknown>;
        label?: string;
        expect?: import("../util/batch.js").BatchExpect;
      }>;
      n: number;
      stopOnAllGreen?: number;
    }) => {
      const g = gateCheck("flake_check");
      if (g) return g;
      // Reject self-nesting + the same human-blocking / recording tools `batch`
      // already excludes. The whitelist is the source of truth.
      for (const c of calls) {
        if (!BATCH_ALLOWED_TOOLS.has(c.tool)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: `flake_check: inner tool "${c.tool}" not allowed (batch whitelist; no batch / flake_check / await_human / recording)`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }
      const report = await runFlakeCheck(calls, {
        n,
        ...(stopOnAllGreen !== undefined ? { stopOnAllGreen } : {}),
        allowed: BATCH_ALLOWED_TOOLS,
        handlers: toolHandlers,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
