// Per-primitive device-emulation state + appliers.
//
// Sits alongside `device.ts` (which resolves a Playwright preset at *context-
// creation* time). The primitives here are the runtime-mutable surface: 7 MCP
// tools that each set ONE Playwright/CDP emulation knob on a live session, so
// agents don't have to over-specify a bundled `emulate({...})` payload on
// every call.
//
// Persistence model. Each setting's resolved value is stored on the
// `SessionEntry.deviceEmulation` bag for the session's lifetime. One re-apply
// path: new page in the same context — a `BrowserContext.on("page")` hook
// re-runs the applier so a tab opened mid-session inherits the overrides.
//
// Runtime-vs-context-time. Playwright's `BrowserContext` bakes some options
// (`locale`, `timezoneId`, `userAgent`) at creation; there is no public mutator
// for them on an existing context. CDP `Emulation.setLocaleOverride`,
// `Emulation.setTimezoneOverride`, and `Network.setUserAgentOverride` DO take
// effect post-creation, so this module routes those three through the
// per-page CDP session. The remaining four — geolocation, colour scheme,
// reduced motion, permissions — have stable Playwright mid-session mutators
// and use those. See per-applier comments for the exact mechanism.

import type { BrowserContext, CDPSession, Page } from "playwright-core";

export type ColorScheme = "light" | "dark" | "no-preference";
export type ReducedMotion = "reduce" | "no-preference";

export interface GeolocationCoords {
  latitude: number;
  longitude: number;
  /** metres; Playwright default 0. */
  accuracy?: number;
}

/** Per-origin permission grant. `origin` empty/undefined → applies to the
 *  current page's origin at apply time. */
export interface PermissionGrant {
  permissions: string[];
  origin?: string;
}

/** Mutable bag of resolved emulation state. Stored per `SessionEntry`. Any
 *  field that is `undefined` means "no override — use the browser default". */
export interface EmulationState {
  locale?: string;
  timezoneId?: string;
  geolocation?: GeolocationCoords;
  colorScheme?: ColorScheme;
  reducedMotion?: ReducedMotion;
  userAgent?: string;
  /** Per-origin permission grants, keyed by origin (empty string = "current
   *  page origin at apply time"). Each grant REPLACES the prior set for that
   *  origin — Playwright's `context.grantPermissions` is itself replace-not-
   *  merge per call, so we mirror its semantics. */
  permissions: Map<string, string[]>;
}

export function newEmulationState(): EmulationState {
  return { permissions: new Map() };
}

/** Re-apply every set knob to a freshly attached page/context. Used on
 *  `BrowserContext.on("page")` and on session re-attach. Best-effort: each
 *  applier swallows its own error and the next still runs.
 *
 *  `cdpFor(page)` returns the CDP session for the page — owned by the caller
 *  (the registry creates one CDP session per primary page). For secondary
 *  pages opened via `on("page")`, the caller passes a freshly-created CDP. */
export async function reapplyAll(
  context: BrowserContext,
  page: Page,
  cdp: CDPSession,
  state: EmulationState,
): Promise<void> {
  if (state.locale !== undefined) await applyLocaleCdp(cdp, state.locale).catch(() => undefined);
  if (state.timezoneId !== undefined)
    await applyTimezoneCdp(cdp, state.timezoneId).catch(() => undefined);
  if (state.userAgent !== undefined)
    await applyUserAgentCdp(cdp, state.userAgent).catch(() => undefined);
  if (state.geolocation !== undefined)
    await applyGeolocation(context, state.geolocation).catch(() => undefined);
  if (state.colorScheme !== undefined)
    await applyColorScheme(page, state.colorScheme).catch(() => undefined);
  if (state.reducedMotion !== undefined)
    await applyReducedMotion(page, state.reducedMotion).catch(() => undefined);
  for (const [origin, perms] of state.permissions) {
    const opts = origin ? { origin } : undefined;
    await context.grantPermissions(perms, opts).catch(() => undefined);
  }
}

// ---------------- locale (CDP-only mid-session) ----------------

/** `Emulation.setLocaleOverride` — installs an `Accept-Language` override AND
 *  patches `navigator.language` / `Intl` for the duration of the page. Passing
 *  empty string clears the override (CDP semantics). */
export async function applyLocaleCdp(cdp: CDPSession, locale: string): Promise<void> {
  await cdp.send("Emulation.setLocaleOverride", { locale });
}

export async function clearLocaleCdp(cdp: CDPSession): Promise<void> {
  // Per CDP, omitting `locale` clears the override. Playwright's send() is
  // strict-typed so we pass empty-string which the protocol treats as clear.
  await cdp.send("Emulation.setLocaleOverride", { locale: "" });
}

// ---------------- timezone (CDP-only mid-session) ----------------

export async function applyTimezoneCdp(cdp: CDPSession, timezoneId: string): Promise<void> {
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId });
}

export async function clearTimezoneCdp(cdp: CDPSession): Promise<void> {
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "" });
}

// ---------------- geolocation (Playwright context mutator) ----------------

export async function applyGeolocation(
  context: BrowserContext,
  coords: GeolocationCoords,
): Promise<void> {
  await context.setGeolocation({
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: coords.accuracy ?? 0,
  });
}

export async function clearGeolocation(context: BrowserContext): Promise<void> {
  await context.setGeolocation(null);
}

// ---------------- colour scheme (Playwright page mutator) ----------------

export async function applyColorScheme(page: Page, scheme: ColorScheme): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
}

// ---------------- reduced motion (Playwright page mutator) ----------------

export async function applyReducedMotion(page: Page, motion: ReducedMotion): Promise<void> {
  await page.emulateMedia({ reducedMotion: motion });
}

// ---------------- user agent (CDP-only mid-session) ----------------

export async function applyUserAgentCdp(cdp: CDPSession, userAgent: string): Promise<void> {
  await cdp.send("Network.setUserAgentOverride", { userAgent });
}

export async function clearUserAgentCdp(cdp: CDPSession): Promise<void> {
  // Empty-string clears the override per CDP.
  await cdp.send("Network.setUserAgentOverride", { userAgent: "" });
}

// ---------------- permissions ----------------

/** Replace the grant for a single origin (or "" = current page origin).
 *  Updates the state bag, then issues the Playwright call. */
export async function applyPermissions(
  context: BrowserContext,
  state: EmulationState,
  permissions: string[],
  origin?: string,
): Promise<void> {
  const key = origin ?? "";
  state.permissions.set(key, [...permissions]);
  const opts = origin ? { origin } : undefined;
  await context.grantPermissions(permissions, opts);
}

export async function clearPermissions(
  context: BrowserContext,
  state: EmulationState,
  origin?: string,
): Promise<void> {
  // Playwright doesn't expose per-origin permission revocation — only the
  // context-wide `clearPermissions`. We mirror that semantics: clearing wipes
  // every grant in the state bag and the context.
  state.permissions.clear();
  if (origin !== undefined) {
    // Caller asked to clear ONE origin; we issued a full clear because the
    // platform doesn't support partial — surface as a warning at the tool layer.
  }
  await context.clearPermissions();
}

/** Distinct-warning helper. BYOB / attached sessions push CDP overrides into
 *  Chrome that browxai does NOT own and CANNOT undo on detach in every case
 *  (the human's browser keeps the override until they navigate / restart).
 *  Tools surface this string in their result `warnings` whenever an emulation
 *  override is applied to an attached session. */
export const BYOB_EMULATION_WARNING =
  "BYOB caveat: this emulation override is applied via CDP to an attached " +
  "(not-owned) Chrome and will PERSIST on that browser after browxai " +
  "detaches. The human's Chrome must navigate / restart to fully clear it.";
