// Device-emulation state vocabulary — the plain-data half of `emulation.ts`.
//
// Split out because the EmulationSubstrate port (`src/page/emulation-substrate-types.ts`)
// names `ColorScheme` / `ReducedMotion` / `GeolocationCoords` in its method
// signatures, and `emulation.ts` imports `BrowserContext` / `CDPSession` /
// `Page` for the appliers that do the work. A port module that reaches
// playwright-core — even transitively, even type-only — is not a port, which is
// what the `ports-name-no-vendor-type` dependency-cruiser rule enforces.
// Declarations here, appliers there; `emulation.ts` re-exports every name so
// existing importers are unchanged.

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
