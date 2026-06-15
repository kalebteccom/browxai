// A minimal engine→capabilities side-table, decoupled from the full EngineRegistry
// so the engine gate (`tool-gate.ts`) can read an engine's declared capabilities
// WITHOUT importing `registry.ts` (which pulls in the substrate-port types and would
// form an import cycle tool-gate → registry → page/*-substrate → engine/index →
// tool-gate). This module imports only the capability TYPES, so it sits cleanly
// beneath both the registry (which writes it on `registerEngine`) and the gate
// (which reads it).

import type { EngineKind, EngineCapabilities } from "./types.js";

const CAPS = new Map<EngineKind, EngineCapabilities>();

/** Record an engine's declared capabilities. Called by `registerEngine`. */
export function setEngineCapabilities(kind: EngineKind, caps: EngineCapabilities): void {
  CAPS.set(kind, caps);
}

/** Non-throwing capability lookup — `undefined` when the engine has not
 *  registered. The engine gate consults this so the registry's capability record
 *  is the source of truth (RFC 0004 P1), which is what gates a runtime-only
 *  engine (the synthetic contract-test engine) correctly without a per-engine edit
 *  to capabilities.ts or tool-gate.ts. */
export function engineCapabilities(kind: EngineKind): EngineCapabilities | undefined {
  return CAPS.get(kind);
}
