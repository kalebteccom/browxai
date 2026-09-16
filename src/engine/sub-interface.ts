// The ONE reader of an engine's declared sub-interface set (RFC 0004 D5).
//
// Page-availability, network-availability and the rest are declared exactly once,
// as `EngineCapabilities.subInterfaces`. Everything that needs to know consults
// this function, so there is never a second spelling of the same fact — no
// `engine === "safari"` literal, no `try { session.page() } catch` probe, no
// `if (session.page)` presence check. A probe is a weaker oracle: the accessor
// and the declaration can disagree, and a caught throw carries no marker saying
// the check never ran.
//
// Two sources, one declaration. The runtime registry (`capability-registry.ts`)
// is authoritative because `registerEngine` writes it, and it is the only source
// that covers an engine registered at runtime with no entry in the static table
// (the architecture suite's synthetic engine). The static table
// (`capabilities.ts`) is the SAME record — every adapter registers
// `capabilitiesFor(kind)` verbatim — read before registration has run, which is
// what makes a unit test that constructs a bare session object resolve correctly
// without booting the engine adapters. An engine with neither is undeclared, and
// an undeclared engine declares nothing.

import type { EngineKind, EngineSubInterface } from "./types.js";
import { capabilitiesFor } from "./capabilities.js";
import { engineCapabilities } from "./capability-registry.js";

/** Whether `engine` declares the `sub` sub-interface. False for an engine with no
 *  capability declaration at all — undeclared is not a claim of support. */
export function engineDeclares(engine: EngineKind, sub: EngineSubInterface): boolean {
  const caps = engineCapabilities(engine) ?? capabilitiesFor(engine);
  return caps?.subInterfaces.has(sub) ?? false;
}
