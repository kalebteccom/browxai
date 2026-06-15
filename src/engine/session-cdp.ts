// CDP-presence assertion for the now-optional `cdp()` member.
//
// `BrowserSession.cdp()` used to be mandatory; making it optional is what un-
// gates multi-engine (the eager `newCDPSession` throws off-Chromium). The ~19
// CDP-hard tools and the network/a11y substrate still need the raw handle on
// Chromium — they route through `requireCdp`, which returns the handle on an
// engine that has it (Chromium: always) and throws a structured, engine-naming
// error on one that doesn't, rather than letting `undefined.send(...)` blow up
// opaquely. On the Chromium hot path this is a single truthiness check and a
// direct delegate — no allocation, no indirection.

import type { CDPSession } from "playwright-core";

/** A session shape carrying the optional CDP accessor + its engine tag. The
 *  full `BrowserSession` satisfies this; the helper takes the narrow shape so
 *  it doesn't pull the whole session interface into the engine module. */
export interface CdpCapable {
  readonly engine: string;
  cdp?(): CDPSession;
}

/** Return the session's raw CDP handle. Throws a structured error naming the
 *  engine when the session has no CDP escape hatch. On Chromium `cdp` is always
 *  present, so this never throws there — keep it a direct delegate on the hot
 *  path. */
export function requireCdp(session: CdpCapable): CDPSession {
  if (!session.cdp) {
    throw new Error(
      `engine "${session.engine}" has no CDP escape hatch — this operation needs raw CDP ` +
        "(perf / coverage / heap / network tap / a11y substrate) and is only available on " +
        "chromium today.",
    );
  }
  return session.cdp();
}
