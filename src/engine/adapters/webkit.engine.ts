// WebKit engine registration (RFC 0004 D1). Registers the one `EngineEntry` for
// the webkit engine (Playwright's bundled WebKit build — the WebKit-ENGINE
// correctness lane, NOT Safari). No adapter logic moves: launch stays in
// `PlaywrightWebKitAdapter`; the substrate bundle is the shared Playwright one
// (WebKit has a Page, no CDP → page-side snapshot walker + Playwright network
// substrate); the post-wire is the full Playwright set. BYOB attach surfaces the
// adapter's structured `webkit-attach-not-supported`.

import type { BrowserSession, SessionOptions } from "../../session/types.js";
import { registerEngine } from "../registry.js";
import { capabilitiesFor } from "../capabilities.js";
import { PlaywrightWebKitAdapter } from "./playwright-webkit.js";
import { playwrightSubstrateBundle } from "../../page/substrate-bundle.js";
import { playwrightPostWire } from "../../session/playwright-post-wire.js";
import {
  buildManagedLaunch,
  buildIncognitoContextOptions,
  finalizeManagedSession,
  finalizeIncognitoSession,
} from "../../session/launch-options.js";
import { assertByobAttach } from "../../session/byob-attach.js";

async function makeWebKitAdapter(opts: SessionOptions): Promise<BrowserSession> {
  const mode = opts.launchMode ?? "managed";
  if (mode === "byob") {
    // Playwright's WebKit build has no CDP/BiDi attach client, and real Safari
    // attach is impossible regardless. Surface the structured
    // `webkit-attach-not-supported` error (no silent fail).
    const url = assertByobAttach(opts);
    await new PlaywrightWebKitAdapter().attach(url);
    throw new Error("unreachable: webkit attach always refuses");
  }
  if (mode === "incognito") {
    const adapter = new PlaywrightWebKitAdapter();
    const { browser, context, page } = await adapter.launchEphemeral({
      launchOptions: { headless: !!opts.headless },
      contextOptions: buildIncognitoContextOptions(opts),
    });
    return finalizeIncognitoSession("webkit", { browser, context, page });
  }
  // WebKit DOES support launchPersistentContext (measured), so managed mode is
  // real. The chromium-only `args` splice never reaches it (the adapter takes
  // only the shared options).
  const { profileDir, options } = buildManagedLaunch("webkit", opts);
  const adapter = new PlaywrightWebKitAdapter();
  const { context, page } = await adapter.launchPersistent({ profileDir, options });
  return finalizeManagedSession("webkit", opts, profileDir, { context, page });
}

registerEngine({
  kind: "webkit",
  capabilities: capabilitiesFor("webkit")!,
  makeAdapter: makeWebKitAdapter,
  makeSubstrates: (deps) => playwrightSubstrateBundle(deps),
  postWire: (entry, deps) => playwrightPostWire(entry, deps),
});
