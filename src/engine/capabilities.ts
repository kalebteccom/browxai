// Per-engine capability declarations — the ENGINE dimension that composes with
// the per-tool capability system in util/capabilities.ts. An adapter declares
// which port sub-interfaces it implements and whether it exposes the `Deep`
// (raw-CDP) escape hatch; the per-tool gate consults this to refuse a CDP-hard
// tool on an engine that can't run it.
//
// In P0 Chromium declares EVERYTHING — every sub-interface plus `deep` — so no
// tool is newly gated. Firefox/WebKit declarations land with their adapters and
// will drop the sub-interfaces / deep-ops they can't support.

import type { EngineCapabilities, EngineKind, EngineSubInterface } from "./types.js";

const ALL_SUB_INTERFACES: readonly EngineSubInterface[] = [
  "lifecycle",
  "navigation",
  "snapshot",
  "input",
  "network",
  "storage",
  "script",
  "emulation",
  "capture",
];

/** Chromium supports the whole port surface, including the CDP escape hatch.
 *  Declaring everything is what makes P0 byte-identical: the engine dimension
 *  is present but gates nothing. */
export const CHROMIUM_CAPABILITIES: EngineCapabilities = {
  engine: "chromium",
  subInterfaces: new Set(ALL_SUB_INTERFACES),
  deep: true,
};

const DECLARATIONS: Partial<Record<EngineKind, EngineCapabilities>> = {
  chromium: CHROMIUM_CAPABILITIES,
};

/** The capability declaration for an engine, or undefined for engines whose
 *  adapter hasn't landed yet (firefox/webkit in P0). */
export function capabilitiesFor(engine: EngineKind): EngineCapabilities | undefined {
  return DECLARATIONS[engine];
}
