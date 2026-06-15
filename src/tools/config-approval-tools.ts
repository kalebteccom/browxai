import type { ToolHost } from "./host.js";

/**
 * Config-store + pre-approval tools — the browxai-managed layered config store
 * (`get_config` / `set_config` / `reset_config`) and the session-independent
 * pre-approval grants (`approve_actions` / `list_approvals`). Registered through
 * the shared `ToolHost` seam.
 */
export function registerConfigApprovalTools(host: ToolHost): void {
  const {
    z,
    register,
    caps,
    configStore,
    approvals,
    pluginRecords,
  } = host;

  // ---------- config store ----------

  const CONFIG_PATCH_SCHEMA = {
    testAttributes: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    confirmRequired: z.array(z.string()).optional(),
    allowedOrigins: z.array(z.string()).optional(),
    blockedOrigins: z.array(z.string()).optional(),
    headless: z.boolean().optional(),
    actionTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    disableWebSecurity: z.boolean().optional(),
    defaultDevice: z.string().optional(),
    defaultViewport: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .optional(),
    hideOverlaySelectors: z.array(z.string()).optional(),
    plugins: z.array(z.string()).optional(),
    unstable: z.record(z.unknown()).optional(),
  };

  register(
    "get_config",
    {
      batchable: true,
      description:
        "Inspect browxai configuration. Default returns the fully *resolved* view (precedence: built-in defaults < env [legacy BROWX_*] < user < project < session). Pass `scope` to see one raw pre-merge layer. Config is browxai-managed — change it with `set_config`, never by hand-editing files or env.",
      inputSchema: {
        scope: z
          .enum(["defaults", "env", "user", "project", "session", "resolved"])
          .optional()
          .describe("Which layer to show. Omit or 'resolved' for the merged view."),
      },
    },
    async ({ scope }) => {
      let body: Record<string, unknown>;
      if (!scope || scope === "resolved") {
        const resolved = configStore.resolve();
        // `capabilities` in the resolved view is the LIVE enforced set — what
        // tool gating actually uses — not the freshly re-resolved config.
        // Those diverge after a `set_config({capabilities})` until a restart;
        // reporting the re-resolved value here would lie to the agent.
        const live = [...caps.enabled].sort();
        const persisted = [...resolved.capabilities].sort();
        // the LIVE enabled plugin set is whatever the runtime
        // loaded at server start (status === "loaded"). Persisted plugins
        // come from the resolved config layer. They diverge after a
        // `set_config({plugins})` until a restart — same posture as
        // capabilities.
        const livePlugins = pluginRecords
          .filter((p) => p.status === "loaded")
          .map((p) => p.manifest.name)
          .sort();
        const persistedPlugins = [...resolved.plugins].sort();
        body = {
          scope: "resolved",
          config: { ...resolved, capabilities: live, plugins: livePlugins },
        };
        if (live.join(",") !== persisted.join(",")) {
          body.capabilitiesPendingRestart = {
            active: live,
            persisted,
            note: "`capabilities` was changed via set_config (or env) but is resolved ONCE at server start — the difference takes effect only after a browxai server RESTART. Tool gating enforces `active`.",
          };
        }
        if (livePlugins.join(",") !== persistedPlugins.join(",")) {
          body.pluginsPendingRestart = {
            active: livePlugins,
            persisted: persistedPlugins,
            note: "`plugins` was changed via set_config but is resolved ONCE at server start — the difference takes effect only after a browxai server RESTART. Plugin tool registration enforces `active`.",
          };
        }
      } else {
        body = { scope, config: configStore.getLayer(scope) };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "set_config",
    {
      description:
        "Persist a config patch into the `user` or `project` layer of the browxai-managed config store (`<workspace>/config.json`). This is the ONLY supported way to set persistent config — no env vars, no hand-edited files. Arrays replace; `unstable.*` shallow-merges. Takes effect for sessions opened after this call (the default session re-resolves lazily). Refuses defaults/env/session scopes.",
      inputSchema: {
        scope: z.enum(["user", "project"]).describe("Which persistent layer to write."),
        patch: z
          .object(CONFIG_PATCH_SCHEMA)
          .describe("Partial config — only the keys you want to override."),
      },
    },
    async ({ scope, patch }) => {
      configStore.setLayer(scope, patch);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { ok: true, scope, written: Object.keys(patch), resolved: configStore.resolve() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  register(
    "reset_config",
    {
      description:
        "Clear a persistent config layer (`user` or `project`) entirely. The built-in defaults + env layer remain.",
      inputSchema: { scope: z.enum(["user", "project"]).describe("Persistent layer to clear.") },
    },
    async ({ scope }) => {
      configStore.resetLayer(scope);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { ok: true, cleared: scope, resolved: configStore.resolve() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ---------- session pre-approvals ----------

  register(
    "approve_actions",
    {
      batchable: true,
      description:
        'session-scoped pre-approval for one or more confirm-required scopes. Lets a non-Claude MCP client run without a human at DevTools to issue page-side `__browx.confirm(true)`. The client calls this once at session start with the scopes to pre-approve (e.g. `["byob_action"]`) and an optional TTL; confirm hooks for those scopes auto-approve within the window. Each grant + consume is logged for audit. Falls back to page-side confirm when no grant covers the scope. Pre-approval is **not** a security boundary — it\'s an unblock for headless flows; tighten by capping `ttlSeconds` per-session.',
      inputSchema: {
        scopes: z
          .array(z.enum(["navigate_off_allowlist", "byob_action", "file_download", "file_upload"]))
          .min(1)
          .describe("Confirm scope names to grant. Same vocabulary as BROWX_CONFIRM_REQUIRED."),
        ttlSeconds: z
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60)
          .optional()
          .describe(
            "Lifetime of the grant in seconds. Default 3600 (1 hour). Hard cap 86400 (24h).",
          ),
      },
    },
    async ({ scopes, ttlSeconds }) => {
      const ttl = ttlSeconds ?? 3600;
      for (const scope of scopes) approvals.grant(scope, ttl);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                granted: scopes,
                ttlSeconds: ttl,
                expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
                note: "Each call into a granted scope is logged. Subsequent approve_actions calls for the same scope reset the TTL.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  register(
    "list_approvals",
    {
      batchable: true,
      description:
        "List live pre-approvals from `approve_actions` — scope, grantedAt, expiresAt, uses, remainingMs. Audit helper.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ approvals: approvals.list() }, null, 2),
        },
      ],
    }),
  );
}
