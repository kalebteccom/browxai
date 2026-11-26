import type { EngineKind } from "../engine/index.js";

/** What a caller passes to `createServer`. Declared here, beside the tool modules
 *  that read it, so none of them imports the composition root that composes them;
 *  `src/server.ts` re-exports it. */
export interface StartOptions {
  attachCdp?: string;
  headless?: boolean;
  /** Browser engine for sessions this server launches. Defaults to
   *  `"chromium"`. All eight kinds are wired today (see src/engine/); a
   *  future-declared engine without an adapter is rejected at the launch path
   *  with a clear `engine-not-yet-supported` error.
   *
   *  `electron` is the one you rarely pass: the desktop CDP-attach lane resolves
   *  it from the protocol, so `attachCdp` pointed at a running Electron app
   *  yields an electron session whether or not this says so. Passing it changes
   *  the DEFAULT session mode to `attached` (electron is attach-only). */
  browserType?: EngineKind;
}
