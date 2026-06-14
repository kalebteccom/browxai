// Firefox engine registration (RFC 0004 D1). Registers the one `EngineEntry` for
// the firefox engine. No adapter logic moves: the Juggler launch stays in
// `PlaywrightFirefoxAdapter`; the substrate bundle is the shared Playwright one
// (firefox has a Page, no CDP → the page-side snapshot walker + Playwright network
// substrate are selected by CDP-absence); the post-wire is the full Playwright set.
// BYOB attach surfaces the adapter's structured `firefox-attach-not-supported`.

import type { BrowserSession, SessionOptions } from "../../session/types.js";
import { registerEngine } from "../registry.js";
import { capabilitiesFor } from "../capabilities.js";
import { PlaywrightFirefoxAdapter, firefoxChannelFromEnv } from "./playwright-firefox.js";
import { playwrightSubstrateBundle } from "../../page/substrate-bundle.js";
import { playwrightPostWire } from "../../session/playwright-post-wire.js";
import {
  buildManagedLaunch,
  buildIncognitoContextOptions,
  finalizeManagedSession,
  finalizeIncognitoSession,
} from "../../session/launch-options.js";
import { assertByobAttach } from "../../session/byob-attach.js";

async function makeFirefoxAdapter(opts: SessionOptions): Promise<BrowserSession> {
  const mode = opts.launchMode ?? "managed";
  if (mode === "byob") {
    // Firefox attach is a glass-box LAUNCH over BiDi, not CDP-attach — Playwright
    // has no `connectOverBiDi` for a user's running Firefox. Surface the
    // structured `firefox-attach-not-supported` error (no silent fail).
    const url = assertByobAttach(opts);
    await new PlaywrightFirefoxAdapter().attach(url);
    throw new Error("unreachable: firefox attach always refuses");
  }
  if (mode === "incognito") {
    const adapter = new PlaywrightFirefoxAdapter({ channel: firefoxChannelFromEnv() });
    const { browser, context, page } = await adapter.launchEphemeral({
      launchOptions: { headless: !!opts.headless },
      contextOptions: buildIncognitoContextOptions(opts),
    });
    return finalizeIncognitoSession("firefox", { browser, context, page });
  }
  const { profileDir, options } = buildManagedLaunch("firefox", opts);
  const adapter = new PlaywrightFirefoxAdapter({ channel: firefoxChannelFromEnv() });
  const { context, page } = await adapter.launchPersistent({ profileDir, options });
  return finalizeManagedSession("firefox", opts, profileDir, { context, page });
}

registerEngine({
  kind: "firefox",
  capabilities: capabilitiesFor("firefox")!,
  makeAdapter: makeFirefoxAdapter,
  makeSubstrates: (deps) => playwrightSubstrateBundle(deps),
  postWire: (entry, deps) => playwrightPostWire(entry, deps),
});
