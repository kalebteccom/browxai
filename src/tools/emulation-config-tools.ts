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
import { BYOB_DEVICE_EMU_WARNING, type DeviceApi } from "../session/device-emu.js";
import type { SessionEntry } from "../session/registry.js";
import { setTabVisibility } from "../page/visibility.js";
import { estimateTokens } from "../util/tokens.js";
import type { EmulationResult } from "../page/emulation-substrate.js";
import {
  resolveCaptchaProvider,
  submitToProvider,
  unconfiguredFailure,
  type CaptchaType,
} from "../page/solve-captcha.js";
import { applyCredentialToRegistry, type ProviderCredentialInternal } from "../util/credentials.js";
import type { ToolHost } from "./host.js";
import { SESSION_ARG } from "./schemas.js";

/**
 * Device-emulation + config-store + pre-approval + secrets/captcha/credentials
 * tools — the off-by-default capability surface plus the browxai-managed config
 * store and session pre-approvals. Synthetic Web Bluetooth/USB/HID device
 * catalogs (`emulate_bluetooth` / `emulate_usb` / `emulate_hid`), per-primitive
 * live emulation (`set_locale` / `set_timezone` / `set_geolocation` /
 * `set_color_scheme` / `set_reduced_motion` / `set_user_agent` /
 * `grant_permissions` / `tab_visibility`), config (`get_config` / `set_config` /
 * `reset_config`), pre-approvals (`approve_actions` / `list_approvals`), and the
 * secrets / captcha / credentials seams (`register_secret` / `solve_captcha` /
 * `get_totp` / `get_credential`). Every block registers through the shared
 * `ToolHost` seam.
 */
export function registerEmulationConfigTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    engineGate,
    entryFor,
    emulationFor,
    caps,
    configStore,
    approvals,
    credentialsResolved,
    pluginRecords,
  } = host;

  // ---------- Web Bluetooth / WebUSB / WebHID device emulation
  // (capability `device-emulation`) ----------
  //
  // Three sibling mutators (`emulate_bluetooth` / `emulate_usb` / `emulate_hid`)
  // plus a read-side companion (`device_requests`). All four gate behind the
  // off-by-default `device-emulation` capability — same posture class as
  // `eval` / `network-body` / `secrets` / `extensions` / `stealth` / `captcha`.
  // The page-side init-script wrappers install eagerly at session creation
  // (so a page that calls `requestDevice()` on initial document parse never
  // hangs); the check binding short-circuits to `refused` when the capability
  // is off, so a server without `device-emulation` still surfaces "page
  // asked but capability was off" on `device_requests`.
  //
  // Shared input schema — the SyntheticDevice union (every field optional;
  // wrappers default missing fields to deterministic placeholders so the
  // page sees a complete shape). A single shape covers all three APIs;
  // each wrapper picks the fields its spec exposes.
  const SYNTHETIC_DEVICE_SCHEMA = z.object({
    name: z
      .string()
      .optional()
      .describe(
        'Display name. Bluetooth: `.name`; USB: `.productName`; HID: `.productName`. Default `"browxai-virtual"`.',
      ),
    id: z
      .string()
      .optional()
      .describe(
        'Bluetooth: stable device id (UUID-style string). Default `"browxai-<api>-<index>"`.',
      ),
    vendorId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB / HID: 16-bit USB-IF vendor id. Default `0x0000`."),
    productId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB / HID: 16-bit product id. Default `0x0000`."),
    manufacturerName: z
      .string()
      .optional()
      .describe('USB: human-readable manufacturer string. Default `"browxai virtual"`.'),
    serialNumber: z
      .string()
      .optional()
      .describe('USB: serial number string. Default `"BROWX-VIRTUAL"`.'),
    deviceClass: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device class. Default `0xFF` (vendor-specific)."),
    deviceSubclass: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device subclass. Default `0x00`."),
    deviceProtocol: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("USB: 8-bit device protocol. Default `0x00`."),
    services: z
      .array(z.string())
      .optional()
      .describe(
        "Bluetooth: GATT primary service UUIDs the device advertises. Surfaced on the synthetic device as `device.uuids`. v1 does NOT emulate GATT service exchange — `gatt.getPrimaryService()` rejects.",
      ),
    collections: z
      .array(z.unknown())
      .optional()
      .describe(
        "HID: report-descriptor collection topology exposed on `device.collections`. Pass-through — the page sees whatever shape you supplied.",
      ),
  });

  const registerEmulateApi = (toolName: string, api: DeviceApi, hint: string): void => {
    register(
      toolName,
      {
        description:
          `Stage a synthetic ${api === "bluetooth" ? "Web Bluetooth" : api === "usb" ? "WebUSB" : "WebHID"} device catalog for this session. The page-side wrapper around \`navigator.${api}.requestDevice()\` resolves with the agent-supplied device(s) the next time the page calls it. ${hint} ` +
          `Pass \`{devices: [...]}\` to install a non-empty catalog (the next requestDevice call ${api === "hid" ? "resolves with the matching device list" : "resolves with the first matching device"}); pass \`{devices: []}\` or omit \`devices\` to clear the catalog (the next call ${api === "hid" ? "resolves with `[]` — the user-dismissed shape for HID" : "rejects with `NotFoundError` — the user-dismissed shape for the picker"}). Persists across navigation: the init-script is re-injected on every new document within the session. Captured page-side calls surface on \`device_requests({session})\`. ` +
          `**Gated behind the off-by-default \`device-emulation\` capability** — the wrappers tell the page it found physical devices that don't exist, a posture-broadening change distinct from the surrounding policies. v1 covers the picker-clear path only — ${api === "bluetooth" ? "GATT service exchange (`getPrimaryService()`) rejects" : api === "usb" ? "transfer endpoints (`transferIn`/`transferOut`) resolve with zero-byte results" : "input/output reports (`oninputreport`, `sendReport()`) are stubs"}. Same posture class as \`eval\` / \`network-body\` / \`secrets\` / \`extensions\` / \`stealth\` / \`captcha\` — see docs/threat-model.md. Returns \`{ok, session, api, catalog:{devices:[…]}, warnings?, tokensEstimate}\`.`,
        inputSchema: {
          devices: z
            .array(SYNTHETIC_DEVICE_SCHEMA)
            .optional()
            .describe(
              `Synthetic devices to expose. Omit or pass \`[]\` to clear the catalog. ${api === "hid" ? "All entries are returned to the page on every requestDevice() call." : "Only the first entry is returned to the page on requestDevice() (Bluetooth/USB pickers are single-result)."}`,
            ),
          ...SESSION_ARG,
        },
      },
      async (args) => {
        const g = gateCheck(toolName);
        if (g) return g;
        const e = await entryFor(args.session);
        try {
          const devices = args.devices ?? [];
          const catalog = e.webDeviceEmulation.set(api, devices);
          const warnings: string[] = [];
          if (e.mode === "attached") warnings.push(BYOB_DEVICE_EMU_WARNING);
          const body: Record<string, unknown> = {
            ok: true,
            session: e.id,
            api,
            catalog,
          };
          if (warnings.length) body.warnings = warnings;
          body.tokensEstimate = estimateTokens(JSON.stringify(body));
          return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
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
  };

  registerEmulateApi(
    "emulate_bluetooth",
    "bluetooth",
    "The synthetic `BluetoothDevice` carries `{id, name, uuids, gatt}`; `gatt.connect()` resolves with a stub server whose `getPrimaryService()` rejects (no GATT emulation in v1) — enough for pages that gate flow on the picker-clear, not enough for pages that go on to exchange characteristic data.",
  );
  registerEmulateApi(
    "emulate_usb",
    "usb",
    "The synthetic `USBDevice` carries vendor/product/class/manufacturer/serial fields; `open()` / `selectConfiguration()` / `claimInterface()` resolve; transfer endpoints (`transferIn` / `transferOut` / `controlTransferIn` / `controlTransferOut`) resolve with zero-byte payloads (no synthetic data flow).",
  );
  registerEmulateApi(
    "emulate_hid",
    "hid",
    "The synthetic `HIDDevice` carries vendor/product/productName/collections; `open()` / `sendReport()` / `sendFeatureReport()` resolve; `receiveFeatureReport()` resolves with an empty DataView; `oninputreport` is never fired (no synthetic device traffic).",
  );

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

  // ---------- secrets registry (capability `secrets`) ----------

  register(
    "register_secret",
    {
      description:
        'Register a sensitive value the agent will use without ever seeing the real string in any tool result. **Gated behind the off-by-default `secrets` capability** — same posture class as `eval` / `network-body` / `disableWebSecurity`. Pair: the agent calls `fill({value:"<NAME>"})` / `press({key:"<NAME>"})` and the runtime substitutes the registered real value AT dispatch (so the page receives the actual string), while EVERY egress sink — `ActionResult.network`, `network_read`, `network_body`, `ws_read`, `console_read`, `snapshot`, `find` evidence — strips occurrences of the real value back to `<NAME>` before returning to the agent. `name` must match `/^[A-Z][A-Z0-9_]*$/` (uppercase identifier — the `<NAME>` mask is the stable contract). Optional `scope` (URL substring, case-insensitive) narrows the *dispatch* side: a scoped secret won\'t be substituted into a `fill` whose page URL doesn\'t contain the scope (refuses with a clear error). Per-session registry, capped at 32 entries. `screenshot` is a PARTIAL sink: when the page\'s text content contains a registered value, a warning is appended; pixel-level redaction (region-blur) is deferred — call snapshot/find for verified-clean evidence instead. NEVER re-emits or logs the real value.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'Agent-facing alias, e.g. "PASSWORD" / "OTP" / "SESSION_TOKEN". Uppercase identifier — `<NAME>` mask format.',
          ),
        value: z
          .string()
          .describe(
            "The real secret value. Stored per-session in memory only; never persisted, never logged.",
          ),
        scope: z
          .string()
          .optional()
          .describe(
            "Optional URL substring (case-insensitive). When set, dispatch-side substitution refuses if the current page URL doesn't contain the scope (prevents cross-origin leak). Egress masking is global regardless.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({
      name,
      value,
      scope,
      session,
    }: {
      name: string;
      value: string;
      scope?: string;
      session?: string;
    }) => {
      const g = gateCheck("register_secret");
      if (g) return g;
      const e = await entryFor(session);
      try {
        e.secrets.register({ name, value, ...(scope ? { scope } : {}) });
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
      const body = {
        ok: true,
        registered: name,
        scope: scope ?? null,
        // never echo the value back. Echo only the registered names — useful
        // for the agent to confirm what aliases are live without leaking.
        names: e.secrets.names(),
        tokensEstimate: estimateTokens(
          JSON.stringify({ ok: true, registered: name, scope, names: e.secrets.names() }),
        ),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---------- captcha solver delegation (capability `captcha`) ----------
  //
  // `solve_captcha` is a delegation seam — it POSTs the captcha challenge to a
  // provider configured per-deployment via environment variables
  // (BROWX_CAPTCHA_PROVIDER + BROWX_CAPTCHA_API_KEY, optional
  // BROWX_CAPTCHA_API_BASE / BROWX_CAPTCHA_TIMEOUT_MS / BROWX_CAPTCHA_POLL_MS).
  // browxai does NOT bundle a solver and does NOT auto-purchase credits — when
  // the capability is on but no provider is configured the tool returns a
  // structured failure with a clear "no provider configured" hint. Loud-warned
  // at boot (see the `captcha` warning above). Targets the 2Captcha-
  // compatible HTTP API for v0.2.0 (`/in.php` submit + `/res.php` poll);
  // CapMonster Cloud mirrors the same shape. Other providers can be added by
  // extending src/page/solve-captcha.ts.

  register(
    "solve_captcha",
    {
      description:
        "Delegate a captcha challenge to a configured external provider (2Captcha / CapMonster / etc — provider speaks the 2Captcha-compatible REST API). **Gated behind the off-by-default `captcha` capability** — same posture class as `eval` / `network-body` / `secrets` / `extensions` / `stealth`. SOLVING CAPTCHAS MAY VIOLATE THE TARGET SITE'S TERMS OF SERVICE; the operator carries the legal exposure. " +
        "Provider config is per-deployment via environment variables: BROWX_CAPTCHA_PROVIDER (`2captcha` or `capmonster`) + BROWX_CAPTCHA_API_KEY; optional BROWX_CAPTCHA_API_BASE / BROWX_CAPTCHA_TIMEOUT_MS / BROWX_CAPTCHA_POLL_MS. **browxai does NOT bundle a solver and does NOT auto-purchase credits** — when the capability is on but no provider is configured the tool returns a structured `ok:false` with a clear `no provider configured` hint. " +
        "For widget captchas (`recaptcha2`, `recaptcha3`, `hcaptcha`, `turnstile`), supply the page's site-key via `siteKey` OR `selector` (when given, the server reads `data-sitekey` from the selected element on the current page). For `image`, supply `imageBase64` (raw base64, no data URL prefix). Returns `{ok, provider, solution, taskId, elapsedMs}` on success — the agent then types `solution` into the hidden form field / invokes the page's recaptcha callback. We do NOT auto-submit the solution; how to wire it into the page is per-site.",
      inputSchema: {
        type: z
          .enum(["recaptcha2", "recaptcha3", "hcaptcha", "turnstile", "image"])
          .describe(
            "Captcha kind. `recaptcha2` = checkbox or invisible v2; `recaptcha3` = score-based v3; `hcaptcha` = hCaptcha widget; `turnstile` = Cloudflare Turnstile; `image` = base64 image upload (caller provides `imageBase64`).",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for the captcha widget element on the current page. When given, the server reads `data-sitekey` (or equivalent) from the element to populate `siteKey`. Either `selector` or `siteKey` is required for widget captchas.",
          ),
        siteKey: z
          .string()
          .optional()
          .describe(
            "Explicit site-key for the captcha widget (alternative to `selector`). Required for widget captchas when `selector` is not given.",
          ),
        imageBase64: z
          .string()
          .optional()
          .describe(
            "Raw base64-encoded image bytes (no `data:image/...;base64,` prefix). Required for `image` type; ignored for widget types.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({
      type,
      selector,
      siteKey,
      imageBase64,
      session,
    }: {
      type: CaptchaType;
      selector?: string;
      siteKey?: string;
      imageBase64?: string;
      session?: string;
    }) => {
      const g = gateCheck("solve_captcha");
      if (g) return g;
      // Resolve provider config fresh per call so an operator can rotate
      // creds via env without restarting the server (env is the source of
      // truth — set_config doesn't override; secrets shouldn't live in the
      // config store).
      const cfg = resolveCaptchaProvider(process.env);
      if (!cfg.ok) {
        if (cfg.reason === "unconfigured") {
          const body = unconfiguredFailure();
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
        const body = {
          ok: false,
          provider: null,
          error: cfg.error ?? "captcha provider config is incomplete",
          hint: "Set BROWX_CAPTCHA_PROVIDER and BROWX_CAPTCHA_API_KEY together. browxai does NOT bundle a solver and does NOT auto-purchase credits.",
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
      }
      const e = await entryFor(session);
      let pageUrl: string;
      try {
        pageUrl = e.session.page().url();
      } catch {
        const body = {
          ok: false,
          provider: cfg.config.provider,
          error: "session has no active page",
          hint: "Call open_session + navigate first.",
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
      }
      // Resolve siteKey: explicit > selector-derived. For `image` neither is
      // needed (imageBase64 is the payload).
      let resolvedSiteKey = siteKey;
      if (!resolvedSiteKey && selector && type !== "image") {
        try {
          const handle = await e.session.page().$(selector);
          if (handle) {
            // Read `data-sitekey` first (recaptcha/hcaptcha/turnstile
            // convention); fall back to a few common alternatives.
            resolvedSiteKey =
              (await handle.getAttribute("data-sitekey")) ??
              (await handle.getAttribute("data-site-key")) ??
              (await handle.getAttribute("sitekey")) ??
              undefined;
            await handle.dispose().catch(() => undefined);
          }
        } catch {
          /* fall through — explicit failure below if still no key */
        }
        if (!resolvedSiteKey) {
          const body = {
            ok: false,
            provider: cfg.config.provider,
            error: `solve_captcha: could not read a site-key attribute from selector "${selector}"`,
            hint: "Pass `siteKey` explicitly, or pass a `selector` that points at an element carrying `data-sitekey` (the standard reCAPTCHA / hCaptcha / Turnstile widget attribute).",
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
        }
      }
      const result = await submitToProvider(
        {
          type,
          pageUrl,
          ...(resolvedSiteKey ? { siteKey: resolvedSiteKey } : {}),
          ...(imageBase64 ? { imageBase64 } : {}),
        },
        cfg.config,
      );
      // Mask the solution through the per-session secrets registry so a
      // solver-issued token containing a registered value (unlikely but
      // defensible) doesn't bypass the egress layer.
      const masked = e.secrets.applyMaskDeep(result);
      const body = { ...masked, tokensEstimate: estimateTokens(JSON.stringify(masked)) };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---------- credentials hook (capability `credentials`) ----------
  //
  // Pluggable TOTP / username+password lookup against an operator-configured
  // vault. Off-by-default; loud-warned at boot. Provider is per-deployment,
  // NEVER bundled. `get_credential` ADDITIONALLY requires the `secrets`
  // capability (auto-registers the looked-up password into the secrets-mask
  // registry under `<PASSWORD_<account>>` — without `secrets`, the lookup
  // refuses rather than leak cleartext into the result).

  register(
    "get_totp",
    {
      description:
        "Look up a one-time TOTP code from the deployment's configured credentials vault. **Gated behind the off-by-default `credentials` capability** — same posture class as `eval` / `network-body` / `secrets`. Provider is selected per-deployment via `BROWX_CREDENTIALS_PROVIDER` (`oathtool` default — no paid dependency, seeds via env or file; or `1password` / `bitwarden` / `lastpass` via their respective CLIs the operator installs out-of-band). Returns `{ok, code, provider}` on success; `{ok:false, error, hint, provider}` on failure (missing seed / CLI not on PATH / CLI not logged in — actionable hint included). TOTP codes are NOT masked through the secrets registry: a TOTP is single-use and short-lived, so masking buys little while complicating verify-step flows — the code is returned in plaintext so the agent can pass it to `fill({value: code})` or compare against on-page text. `account` semantics depend on the provider (oathtool: a key from `BROWX_OATHTOOL_SEEDS`; 1password/bitwarden/lastpass: an item name / id the CLI accepts).",
      inputSchema: {
        account: z
          .string()
          .describe(
            "Provider-specific account identifier (oathtool seed key / 1password item name / bitwarden item id / lastpass item name).",
          ),
      },
    },
    async ({ account }: { account: string }) => {
      const g = gateCheck("get_totp");
      if (g) return g;
      const result = await credentialsResolved.provider.getTotp(account);
      const body = {
        ...result,
        tokensEstimate: estimateTokens(JSON.stringify(result)),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "get_credential",
    {
      description:
        'Look up a `{username, password}` pair from the deployment\'s configured credentials vault. **Gated behind the off-by-default `credentials` capability** AND additionally requires the `secrets` capability (without it the lookup refuses — returning a password in cleartext would leak it into the transcript on first reference). On success, the password is AUTO-REGISTERED into the per-session secrets registry under `<PASSWORD_<account>>` (account name sanitised to `/^[A-Z][A-Z0-9_]*$/`); the agent then passes `fill({value: "<PASSWORD_acct>"})` and the runtime materialises the real value AT Playwright dispatch. The returned object carries `{ok, username, aliasName, provider}` — **never the cleartext password**. Pair with `get_totp` for the 2FA half. `oathtool` provider does NOT support `get_credential` (TOTP-only) — pair with a credential-bearing provider. `account` semantics are provider-specific (1password: item name; bitwarden: item id; lastpass: item name).',
      inputSchema: {
        account: z
          .string()
          .describe(
            "Provider-specific account identifier — see the per-provider notes in docs/tool-reference.md.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ account, session }: { account: string; session?: string }) => {
      const g = gateCheck("get_credential");
      if (g) return g;
      const e = await entryFor(session);
      const raw = (await credentialsResolved.provider.getCredential(
        account,
      )) as ProviderCredentialInternal;
      // `applyCredentialToRegistry` enforces the `secrets`-capability
      // pairing rule and strips `_password` before the result leaves this
      // module — so the response we serialise never contains cleartext.
      const registry = caps.enabled.has("secrets") ? e.secrets : null;
      const result = applyCredentialToRegistry(raw, registry, account);
      const body = {
        ...result,
        tokensEstimate: estimateTokens(JSON.stringify(result)),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );
}
