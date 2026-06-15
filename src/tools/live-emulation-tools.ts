import { requireCdp } from "../engine/index.js";
import {
  applyLocaleCdp,
  clearLocaleCdp,
  applyTimezoneCdp,
  clearTimezoneCdp,
  applyUserAgentCdp,
  clearUserAgentCdp,
  applyPermissions,
  clearPermissions,
  BYOB_EMULATION_WARNING,
  type ReducedMotion,
} from "../session/emulation.js";
import type { SessionEntry } from "../session/registry.js";
import { setTabVisibility } from "../page/visibility.js";
import { estimateTokens } from "../util/tokens.js";
import type { EmulationResult } from "../page/emulation-substrate.js";
import type { ToolHost } from "./host.js";
import { SESSION_ARG } from "./schemas.js";

/**
 * Per-primitive live emulation — the seven sibling mutators that each set ONE
 * live knob on the session (`set_locale` / `set_timezone` / `set_geolocation` /
 * `set_color_scheme` / `set_reduced_motion` / `set_user_agent` /
 * `grant_permissions`) plus `tab_visibility`. State persists on the SessionEntry.
 * Registered through the shared `ToolHost` seam.
 */
export function registerLiveEmulationTools(host: ToolHost): void {
  const { z, register, gateCheck, engineGate, entryFor, emulationFor } = host;

  // ---------- Per-primitive device emulation ----------
  //
  // Seven sibling tools (deliberately NOT a bundled `emulate({…})`) — each
  // mutates ONE Playwright/CDP knob on the live session: `set_locale`,
  // `set_timezone`, `set_geolocation`, `set_color_scheme`, `set_reduced_motion`,
  // `set_user_agent`, `grant_permissions`. State persists on the SessionEntry
  // so new pages within the same context re-apply automatically. CONTEXT-
  // time-only Playwright settings (locale, timezone, UA) are routed through
  // their CDP equivalents (`Emulation.setLocaleOverride`,
  // `Emulation.setTimezoneOverride`, `Network.setUserAgentOverride`) — those
  // DO take effect mid-session. The other four use Playwright's stable
  // mutators. BYOB / attached sessions surface a warning that overrides
  // applied via CDP outlive browxai's detach.

  /** Wrap an emulation-tool result with the standard envelope (`ok`, `applied`,
   *  `state` snapshot, `tokensEstimate`, plus BYOB warning when applicable). */
  const emulationResult = (
    e: SessionEntry,
    applied: Record<string, unknown>,
    extra: { warnings?: string[]; note?: string } = {},
  ): { content: Array<{ type: "text"; text: string }> } => {
    const warnings: string[] = [...(extra.warnings ?? [])];
    if (e.mode === "attached") warnings.push(BYOB_EMULATION_WARNING);
    const body: Record<string, unknown> = {
      ok: true,
      session: e.id,
      applied,
      state: {
        locale: e.deviceEmulation.locale ?? null,
        timezoneId: e.deviceEmulation.timezoneId ?? null,
        geolocation: e.deviceEmulation.geolocation ?? null,
        colorScheme: e.deviceEmulation.colorScheme ?? null,
        reducedMotion: e.deviceEmulation.reducedMotion ?? null,
        userAgent: e.deviceEmulation.userAgent ?? null,
        permissions: Object.fromEntries(e.deviceEmulation.permissions),
      },
    };
    if (warnings.length) body.warnings = warnings;
    if (extra.note) body.note = extra.note;
    body.tokensEstimate = estimateTokens(JSON.stringify(body));
    return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
  };

  /** Standard emulation failure envelope. */
  const emulationError = (toolName: string, err: unknown) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            action: { type: toolName },
            error: err instanceof Error ? err.message : String(err),
            tokensEstimate: 0,
          },
          null,
          2,
        ),
      },
    ],
  });

  /** Render an EmulationSubstrate refusal as the standard failure envelope (the
   *  Safari adapter has no live surface for the knob). Carries the adapter's
   *  `hint` so the agent knows where the override IS available. */
  const emulationRefusal = (toolName: string, refusal: EmulationResult & { kind: "refusal" }) => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ok: false,
            action: { type: toolName },
            error: refusal.error,
            ...(refusal.hint ? { hint: refusal.hint } : {}),
            tokensEstimate: 0,
          },
          null,
          2,
        ),
      },
    ],
  });

  register(
    "set_locale",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Override the session's browser locale (`navigator.language`, `Intl.*` defaults, `Accept-Language` header). Persists across navigation + new tabs in the same session. Pass `locale: null` to clear the override and restore the browser default. NOTE: Playwright's `BrowserContext.locale` is creation-time-only, so this primitive is implemented via CDP `Emulation.setLocaleOverride` — which DOES take effect mid-session on existing pages. BYOB caveat: the CDP override persists on the attached Chrome until it navigates/restarts after detach.",
      inputSchema: {
        locale: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            'BCP-47 locale tag, e.g. "en-US", "de-DE", "ja-JP". Pass null (or omit) to clear the override and restore the browser default.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ locale, session }) => {
      const g = gateCheck("set_locale");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("set_locale", e);
      if (eg) return eg;
      try {
        if (locale === null || locale === undefined) {
          await clearLocaleCdp(requireCdp(e.session));
          e.deviceEmulation.locale = undefined;
          return emulationResult(e, { locale: null });
        }
        await applyLocaleCdp(requireCdp(e.session), locale);
        e.deviceEmulation.locale = locale;
        return emulationResult(e, { locale });
      } catch (err) {
        return emulationError("set_locale", err);
      }
    },
  );

  register(
    "set_timezone",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Override the session's IANA timezone for `Date`, `Intl.DateTimeFormat`, etc. Persists across navigation + new tabs. Pass `timezoneId: null` to clear. NOTE: Playwright's `BrowserContext.timezoneId` is creation-time-only, so this primitive uses CDP `Emulation.setTimezoneOverride` (mid-session-capable). BYOB caveat: the CDP override persists on attached Chrome after detach.",
      inputSchema: {
        timezoneId: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            'IANA timezone, e.g. "America/New_York", "Europe/London", "Asia/Tokyo". Pass null (or omit) to clear.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ timezoneId, session }) => {
      const g = gateCheck("set_timezone");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("set_timezone", e);
      if (eg) return eg;
      try {
        if (timezoneId === null || timezoneId === undefined) {
          await clearTimezoneCdp(requireCdp(e.session));
          e.deviceEmulation.timezoneId = undefined;
          return emulationResult(e, { timezoneId: null });
        }
        await applyTimezoneCdp(requireCdp(e.session), timezoneId);
        e.deviceEmulation.timezoneId = timezoneId;
        return emulationResult(e, { timezoneId });
      } catch (err) {
        return emulationError("set_timezone", err);
      }
    },
  );

  register(
    "set_geolocation",
    {
      capability: "action",
      batchable: true,
      description:
        "Override the session's HTML5 Geolocation reading. The page MUST also be granted the `geolocation` permission via `grant_permissions` for `navigator.geolocation.*` to deliver this value (browsers gate it). Uses Playwright's `context.setGeolocation()` which mutates a live context — no CDP fallback needed. Pass no coords (or `latitude:null`) to clear.",
      inputSchema: {
        latitude: z
          .union([z.number(), z.null()])
          .optional()
          .describe("Latitude in degrees [-90, 90]. Pass null (or omit) to clear the override."),
        longitude: z.number().optional().describe("Longitude in degrees [-180, 180]."),
        accuracy: z
          .number()
          .nonnegative()
          .optional()
          .describe("Accuracy radius in metres. Default 0."),
        ...SESSION_ARG,
      },
    },
    async ({ latitude, longitude, accuracy, session }) => {
      const g = gateCheck("set_geolocation");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const isClear = latitude === null || latitude === undefined;
        if (isClear) {
          const r = await emulationFor(e).setGeolocation(null);
          if (r.kind === "refusal") return emulationRefusal("set_geolocation", r);
          e.deviceEmulation.geolocation = undefined;
          return emulationResult(e, { geolocation: null });
        }
        if (longitude === undefined) {
          return emulationError(
            "set_geolocation",
            new Error("longitude is required when latitude is set"),
          );
        }
        const coords = { latitude, longitude, accuracy };
        const r = await emulationFor(e).setGeolocation(coords);
        if (r.kind === "refusal") return emulationRefusal("set_geolocation", r);
        e.deviceEmulation.geolocation = coords;
        const warnings: string[] = [];
        const grantedHere = e.deviceEmulation.permissions.get("") ?? [];
        const grantedAll = [...e.deviceEmulation.permissions.values()].flat();
        if (![...grantedHere, ...grantedAll].includes("geolocation")) {
          warnings.push(
            'set_geolocation: pages need the `geolocation` permission for navigator.geolocation to deliver this — call grant_permissions({ permissions: ["geolocation"] }) for the relevant origin.',
          );
        }
        return emulationResult(e, { geolocation: coords }, { warnings });
      } catch (err) {
        return emulationError("set_geolocation", err);
      }
    },
  );

  register(
    "set_color_scheme",
    {
      capability: "action",
      batchable: true,
      description:
        "Override the session's `prefers-color-scheme` media query — drives dark-mode rendering. Mutates a live page via Playwright's `page.emulateMedia({colorScheme})`; takes effect immediately (CSS media queries re-evaluate). Pass `\"no-preference\"` to clear the override.",
      inputSchema: {
        scheme: z
          .enum(["light", "dark", "no-preference"])
          .describe(
            "`light` / `dark` force the scheme; `no-preference` clears the override and restores the system default.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ scheme, session }) => {
      const g = gateCheck("set_color_scheme");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const r = await emulationFor(e).setColorScheme(scheme);
        if (r.kind === "refusal") return emulationRefusal("set_color_scheme", r);
        e.deviceEmulation.colorScheme = scheme === "no-preference" ? undefined : scheme;
        return emulationResult(e, { colorScheme: scheme });
      } catch (err) {
        return emulationError("set_color_scheme", err);
      }
    },
  );

  register(
    "set_reduced_motion",
    {
      capability: "action",
      batchable: true,
      description:
        "Override the session's `prefers-reduced-motion` media query — useful when an animation-heavy page is unstable to drive, or to verify a reduced-motion code path. Mutates a live page via Playwright's `page.emulateMedia({reducedMotion})`. Pass `on:false` to clear.",
      inputSchema: {
        on: z.boolean().describe("true → `reduce`; false → `no-preference` (clears the override)."),
        ...SESSION_ARG,
      },
    },
    async ({ on, session }) => {
      const g = gateCheck("set_reduced_motion");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const motion: ReducedMotion = on ? "reduce" : "no-preference";
        const r = await emulationFor(e).setReducedMotion(motion);
        if (r.kind === "refusal") return emulationRefusal("set_reduced_motion", r);
        e.deviceEmulation.reducedMotion = on ? "reduce" : undefined;
        return emulationResult(e, { reducedMotion: motion });
      } catch (err) {
        return emulationError("set_reduced_motion", err);
      }
    },
  );

  register(
    "set_user_agent",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        "Override the session's User-Agent (HTTP header + `navigator.userAgent`). Persists across navigation + new tabs. Pass `userAgent: null` to clear. NOTE: Playwright's `BrowserContext.userAgent` is creation-time-only, so this primitive uses CDP `Network.setUserAgentOverride` (mid-session-capable; updates both the network header and the JS-visible value). BYOB caveat: the CDP override persists on attached Chrome after detach.",
      inputSchema: {
        userAgent: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            "Full User-Agent string. Pass null (or omit) to clear and restore the browser default.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ userAgent, session }) => {
      const g = gateCheck("set_user_agent");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("set_user_agent", e);
      if (eg) return eg;
      try {
        if (userAgent === null || userAgent === undefined) {
          await clearUserAgentCdp(requireCdp(e.session));
          e.deviceEmulation.userAgent = undefined;
          return emulationResult(e, { userAgent: null });
        }
        await applyUserAgentCdp(requireCdp(e.session), userAgent);
        e.deviceEmulation.userAgent = userAgent;
        return emulationResult(e, { userAgent });
      } catch (err) {
        return emulationError("set_user_agent", err);
      }
    },
  );

  register(
    "grant_permissions",
    {
      capability: "action",
      batchable: true,
      description:
        "Grant browser permissions for the session — `geolocation`, `notifications`, `clipboard-read`, `clipboard-write`, `camera`, `microphone`, `midi`, `background-sync`, `accelerometer`, `gyroscope`, `magnetometer`, `ambient-light-sensor`, `payment-handler`, etc. (Chromium permission names). Mutates a live context via Playwright `context.grantPermissions`. Optionally scope to a specific `origin`; otherwise grants for the current page's origin. Pass `permissions: []` (or omit) to clear all grants for the session — Playwright does not expose per-origin revocation, so clearing is context-wide.",
      inputSchema: {
        permissions: z
          .array(z.string())
          .optional()
          .describe(
            "List of Chromium permission names. Pass empty array (or omit) to clear ALL grants (context-wide; per-origin revocation isn't supported by the underlying platform).",
          ),
        origin: z
          .string()
          .optional()
          .describe(
            'Origin to scope the grant to (e.g. "https://example.com"). Omit to use the current page\'s origin.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({ permissions, origin, session }) => {
      const g = gateCheck("grant_permissions");
      if (g) return g;
      const e = await entryFor(session);
      try {
        if (!permissions || permissions.length === 0) {
          const hadOrigin = origin !== undefined;
          await clearPermissions(e.session.page().context(), e.deviceEmulation, origin);
          const note = hadOrigin
            ? "Per-origin permission revocation isn't supported by Playwright; cleared ALL grants for the session context."
            : "Cleared ALL permission grants for the session context.";
          return emulationResult(e, { permissions: [], origin: origin ?? null }, { note });
        }
        await applyPermissions(e.session.page().context(), e.deviceEmulation, permissions, origin);
        return emulationResult(e, { permissions, origin: origin ?? null });
      } catch (err) {
        return emulationError("grant_permissions", err);
      }
    },
  );

  register(
    "tab_visibility",
    {
      capability: "navigation",
      description:
        'Background or foreground the session\'s tab — the only way to reproduce the bug class that only fires when the tab is hidden (throttled setTimeout, paused requestAnimationFrame so framework enter/animation hooks never run, and on-return a visibilitychange/focus handler replays stale state). `state:"background"` overrides document.visibilityState/hidden + dispatches visibilitychange, AND best-effort takes front focus away from the page so real timer/rAF throttling applies (real throttling is best-effort under headless). `state:"background"` with `holdMs` is the headline form: background, hold hidden for holdMs, then auto-foreground — reproducing the background→return transition in one call. `state:"foreground"` restores visibility and re-focuses the tab.',
      inputSchema: {
        state: z
          .enum(["background", "foreground"])
          .describe("background = hide/deprioritise the tab; foreground = restore + re-focus."),
        holdMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe(
            "background only: hold hidden this long (ms), then auto-foreground. Cap 120000.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ state, holdMs, session }) => {
      const g = gateCheck("tab_visibility");
      if (g) return g;
      const e = await entryFor(session);
      const result = await setTabVisibility(
        e.session.page(),
        e.session.page().context(),
        state,
        holdMs,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
