// SDK transport registry (RFC 0004 P4 / D6) — the add-only `Map<TransportMode,
// TransportFactory>` that replaces the `switch (mode)` in `createBrowxai`.
//
// The `SdkTransport` PORT (src/sdk/transport.ts) was already proven — three real
// implementations drive it (in-process / stdio-child / socket). The only piece
// that was a switch is the SELECTION: which factory builds the transport for a
// given `opts.transport`. This registry resolves the SAME factory each `case`
// did, so a fourth transport becomes a `registerTransport(...)` call in its own
// transport file rather than a new `case` in the composition root — and the
// dependency-cruiser layering rule keeps `createBrowxai` from growing per-
// transport imports.
//
// Behavior-preservation: `openTransport(mode, opts)` constructs the transport
// with the EXACT argument shape the old `case` passed (the socket endpoint guard
// included), so `sdk.keystone.test.ts` drives all three transports unchanged.

import type { BrowxaiSdkOptions } from "./types.js";
import type { SdkTransport } from "./transport.js";

/** The transport selector — derived from the real SDK option union so the
 *  registry key stays in lockstep with the public surface (a new option value
 *  is a compile error here until a factory is registered for it). */
export type TransportMode = NonNullable<BrowxaiSdkOptions["transport"]>;

/** One transport's construction surface. `open` receives the full SDK options
 *  and reads only the fields its transport needs — the same mapping the old
 *  `switch` arm performed inline. */
export interface TransportFactory {
  open(opts: BrowxaiSdkOptions): Promise<SdkTransport>;
}

const TRANSPORTS = new Map<TransportMode, TransportFactory>();

/** Register a transport factory under its mode. Add-only: each transport file
 *  registers itself once at module load, so the composition root never edits a
 *  central conditional to add one. */
export function registerTransport(mode: TransportMode, factory: TransportFactory): void {
  TRANSPORTS.set(mode, factory);
}

/** Resolve + open the transport for `mode`. Throws the same structured error the
 *  old `default` arm did when the mode is unknown (no registered factory). */
export function openTransport(mode: TransportMode, opts: BrowxaiSdkOptions): Promise<SdkTransport> {
  const factory = TRANSPORTS.get(mode);
  if (!factory) {
    throw new Error(`browxai-sdk: unknown transport "${String(mode)}"`);
  }
  return factory.open(opts);
}
