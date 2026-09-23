import type { ToolHost } from "./host.js";
import { capabilityMissing, type Capability } from "../util/capabilities.js";

/**
 * Config-store + pre-approval tools — the browxai-managed layered config store
 * (`get_config` / `set_config` / `reset_config`) and the session-independent
 * pre-approval grants (`approve_actions` / `list_approvals`). Registered through
 * the shared `ToolHost` seam.
 */
export function registerConfigApprovalTools(host: ToolHost): void {
  // NOTE: `pluginRecords` is NOT destructured here — `host.pluginRecords` is a
  // LIVE getter (host-build.ts) populated AFTER this tool is registered (the
  // plugin runtime starts later). Destructuring would snapshot the empty
  // pre-load array, so get_config would always report `plugins: []`. Read it
  // live inside the handler instead.
  const { z, register, caps, configStore, approvals, gateCheck } = host;

  // ---------- config store ----------

  const refusal = (body: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
  });

  const CONFIG_PATCH_SCHEMA = {
    testAttributes: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    confirmRequired: z.array(z.string()).optional(),
    allowedOrigins: z.array(z.string()).optional(),
    blockedOrigins: z.array(z.string()).optional(),
    headless: z.boolean().optional(),
    actionTimeoutMs: z.number().int().positive().max(3_600_000).optional(),
    disableWebSecurity: z.boolean().optional(),
    channel: z.string().optional(),
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
        const livePlugins = host.pluginRecords
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
        'Persist a config patch into the `user` or `project` layer of the browxai-managed config store (`<workspace>/config.json`). Arrays replace; `unstable.*` shallow-merges. Takes effect for sessions opened after this call (the default session re-resolves lazily). Refuses defaults/env/session scopes. `capabilities` can only NARROW: a patch naming a capability outside the active set is refused with `error: "capabilities-not-widenable"`, and a saved list is clamped to BROWX_CAPABILITIES at every server start.',
      inputSchema: {
        scope: z.enum(["user", "project"]).describe("Which persistent layer to write."),
        patch: z
          .object(CONFIG_PATCH_SCHEMA)
          .describe("Partial config — only the keys you want to override."),
      },
    },
    async ({ scope, patch }) => {
      // A saved `capabilities` list is clamped to BROWX_CAPABILITIES at every
      // start, so it can only narrow. Refuse a widening patch outright, so the
      // caller learns that now instead of at the next restart.
      const widening = (patch.capabilities ?? []).filter((c) =>
        capabilityMissing(c as Capability, caps),
      );
      if (widening.length) {
        return refusal({
          ok: false,
          error: "capabilities-not-widenable",
          widening,
          activeCapabilities: [...caps.enabled].sort(),
          hint: "`set_config` can only narrow `capabilities` to a subset of the active set. Enabling a capability is the operator's decision: add it to BROWX_CAPABILITIES and restart the server.",
        });
      }
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
      capability: "self-approval",
      description:
        'Pre-approve one or more confirm-required scopes for a TTL window, so confirm hooks for those scopes pass without asking the human. Requires the off-by-default `self-approval` capability: the confirm hooks exist to stop the agent\'s own actions, and this tool lets the agent answer them itself, so the operator has to opt in at server start. Refused with `requiredCapability: "self-approval"` when the capability is not active. Each grant + consume is logged for audit. Falls back to asking the human when no grant covers the scope. Keep `ttlSeconds` short.',
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
      const g = gateCheck("approve_actions");
      if (g) return g;
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
