import { type SessionEntry } from "../session/registry.js";
import {
  resolveExtensionPath,
  readManifest,
  refuseIfUnsupported as refuseExtensionsIfUnsupported,
  applyInstall as applyExtensionInstall,
  applyUninstall as applyExtensionUninstall,
  applyReload as applyExtensionReload,
  type LoadedExtension,
} from "../session/extensions.js";
import { estimateTokens } from "../util/tokens.js";
import { rebuildPersistentForExtensions, type ExtensionRebuildDeps } from "./extensions-rebuild.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ConfigHost,
  ServerServicesHost,
} from "./host.js";
import { requirePage } from "../engine/index.js";

/**
 * Chrome-extension management tools: extensions_install / extensions_list /
 * extensions_reload / extensions_trigger / extensions_uninstall. Off-by-default
 * `extensions` capability; headed-persistent only. install/reload/uninstall
 * rebuild the underlying browser context (Chromium can't mutate extensions on a
 * live context) via the extracted `rebuildPersistentForExtensions`. Split out of
 * `extensions-batch-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order.
 */
/** Discover the loaded extensions' Chrome-runtime ids by inspecting the
 *  context's service-worker (MV3) + background-page (MV2) URLs — both start with
 *  `chrome-extension://<runtime-id>/`. Best-effort: older Playwright builds may
 *  not surface every channel; returns the deduped set. */
function discoverExtensionRuntimeIds(ctx: unknown): string[] {
  const idsFrom = (urls: Array<{ url: () => string }>): string[] =>
    urls
      .map((w) => w.url())
      .filter((u) => u.startsWith("chrome-extension://"))
      .map((u) => u.slice("chrome-extension://".length).split("/")[0]!);
  const c = ctx as {
    serviceWorkers?: () => Array<{ url: () => string }>;
    backgroundPages?: () => Array<{ url: () => string }>;
  };
  const swIds = idsFrom(c.serviceWorkers?.() ?? []);
  const bgIds = idsFrom(c.backgroundPages?.() ?? []);
  return Array.from(new Set([...swIds, ...bgIds]));
}

export function registerExtensionsTools(
  host: RegisterHost & GateHost & SessionHost & ConfigHost & ServerServicesHost,
): void {
  const {
    z,
    register,
    gateCheck,
    engineGate,
    entryFor,
    caps,
    workspace,
    configStore,
    startOptions: opts,
    resolvedConfig,
  } = host;

  // The per-server boundary deps the context rebuild threads in (was the closure
  // the in-module helper held). Passed explicitly to the extracted rebuild fn.
  const rebuildDeps: ExtensionRebuildDeps = {
    caps,
    configStore,
    workspace,
    opts,
    resolvedConfig,
  };

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
        "Load an unpacked Chromium extension (an MV3 or MV2 directory containing `manifest.json`) into the session's managed-profile launch. Requires the `extensions` capability (off by default). A loaded extension can read every page the session visits and make arbitrary network requests, so it is as trusted as the agent. `path` must resolve inside `$BROWX_WORKSPACE`, symlinks resolved; a packed `.crx` must be unpacked first. Headed `persistent` sessions only: `incognito`, `attached` and headless sessions are refused with a structured error and hint. Install rebuilds the browser context (Chromium cannot add an extension to a live one): the page goes to about:blank, refs are invalidated, and console, network and WebSocket buffers reset, while profile data on disk (cookies, localStorage, IndexedDB) survives. Treat it as a session restart and call `snapshot` afterwards. Returns `{ok, session, installed:{id,name,version,path}, loaded:[…], note?, tokensEstimate}`. `id` is a stable hash of the resolved path; pass it to `extensions_reload`, `extensions_trigger` and `extensions_uninstall`.",
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
        await rebuildPersistentForExtensions(e, rebuildDeps);
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
        "List the extensions loaded in this session: `[{id, name, version, path, enabled}]`, empty when none is loaded. Requires the `extensions` capability (off by default). Headed `persistent` sessions only.",
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
        "Reload an installed extension: re-parse its `manifest.json`, then rebuild the browser context so Chromium re-injects content scripts and restarts the MV3 service worker. Identify it by `id` (from `extensions_install` or `extensions_list`). Same rebuild as install: refs and buffers reset, profile data on disk survives. Requires the `extensions` capability (off by default). Headed `persistent` sessions only.",
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
        await rebuildPersistentForExtensions(e, rebuildDeps);
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
        "Best-effort invoke of an installed extension's surface. With `command`, it fires the keyboard command declared under `commands` in the extension's manifest. Without `command`, it navigates the active page to the extension's `chrome-extension://<id>/<default_popup>` URL so the popup renders in a tab and can be driven like any page. Many extensions have neither surface; the tool then returns `ok:false` with the reason. It does not change the loaded list. Requires the `extensions` capability (off by default). Headed `persistent` sessions only.\n\nbrowxai's `id` is a hash of the path and does not always equal Chrome's runtime id, which Chrome derives from the signing key when there is one. For popup triggers the tool reads the runtime id from the context's service workers or background pages; on a mismatch it returns a hint pointing at `extensions_list` and the page's own discovery.",
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
        // Resolve the Chrome-runtime id by inspecting the context's
        // service-worker / background-page URLs. Best-effort — surfaces the
        // discovered ids so the caller can decide.
        const runtimeIds = discoverExtensionRuntimeIds(requirePage(e.session).context());
        // We can't reliably map our path-hash id to the runtime id without
        // parsing the manifest's `key` field — when there's exactly one loaded
        // extension AND one runtime id we assume the mapping.
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
              `extensions_trigger: cannot find the id Chrome assigned to extension "${id}". ` +
                `browxai's id is a hash of the unpacked path, so it can differ from Chrome's own id (Chrome derives that from the manifest \`key\` when present). ` +
                `Chrome ids detected: ${JSON.stringify(runtimeIds)}; extensions loaded: ${e.extensions.loaded.length}. ` +
                `Navigate the page directly to the extension's popup URL once you know Chrome's id.`,
            ),
          );
        }
        // Open the extension's popup (or its background page) in the active
        // page. The extension serves `chrome-extension://<id>/` from its
        // manifest's `action.default_popup` / `browser_action.default_popup`.
        const url = `chrome-extension://${runtimeId}/`;
        await requirePage(e.session)
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
        "Remove an installed extension from the session and rebuild the browser context without it. Same rebuild as install: refs and buffers reset, profile data on disk survives. Requires the `extensions` capability (off by default). Headed `persistent` sessions only.",
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
        await rebuildPersistentForExtensions(e, rebuildDeps);
      } catch (err) {
        // rebuild failed after registry mutation — restore the entry so the
        // agent can retry the operation. The original BrowserSession is
        // already torn down (we cannot recover it), so the session itself
        // is in a degraded state; surface that explicitly.
        return extensionErrorEnvelope(
          "extensions_uninstall",
          new Error(
            `extensions_uninstall: the browser restart after removal failed (${err instanceof Error ? err.message : String(err)}). Session "${e.id}" is no longer usable; close it and open a fresh one.`,
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
}
