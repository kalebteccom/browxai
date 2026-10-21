// Chromium engine registration (RFC 0004 D1). Registers the one `EngineEntry`
// for the chromium engine — the byte-identity-critical path. No adapter LOGIC
// moves here: the Playwright launch calls stay in `PlaywrightChromiumAdapter`,
// the substrate selection delegates to the existing CDP/Playwright selectors, and
// the post-wire is the full Playwright bookkeeping set (the always-true branch the
// three factories ran for every non-Safari engine). This is pure wiring
// relocation behind the registry — the chromium CDP path is verbatim.

import type { BrowserSession, SessionOptions } from "../../session/types.js";
import { registerEngine } from "../registry.js";
import { capabilitiesFor } from "../capabilities.js";
import { playwrightSubstrateBundle } from "../../page/substrate-bundle.js";
import { playwrightPostWire } from "../../session/playwright-post-wire.js";
import {
  buildManagedLaunch,
  buildIncognitoContextOptions,
  buildIncognitoLaunchOptions,
  finalizeManagedSession,
  finalizeIncognitoSession,
} from "../../session/launch-options.js";
import {
  automationSwitchOptions,
  launchWithChannelPlan,
  planChromiumChannel,
} from "../../session/chromium-launch-posture.js";
import { PlaywrightChromiumAdapter } from "./playwright-chromium.js";
import { attachByobDesktop } from "../../session/byob-attach.js";

/** Build a chromium `BrowserSession` for the requested launch mode. The
 *  per-engine launch dispatch the three factories carried (`engine === "…"`)
 *  collapses to this one method; the mode is threaded via `opts.launchMode`
 *  (defaulting to managed). Every option-built value + adapter call is the verbatim
 *  pre-seam chromium path, so the chromium keystone stays byte-identical. */
async function makeChromiumAdapter(opts: SessionOptions): Promise<BrowserSession> {
  const mode = opts.launchMode ?? "managed";
  if (mode === "byob") {
    return attachByobDesktop(opts);
  }
  const plan = planChromiumChannel(opts);
  if (mode === "incognito") {
    const adapter = new PlaywrightChromiumAdapter();
    const { browser, context, page, cdp } = await launchWithChannelPlan(plan, (channelOption) =>
      adapter.launchEphemeral({
        launchOptions: {
          ...buildIncognitoLaunchOptions("chromium", opts),
          ...automationSwitchOptions(),
          ...channelOption,
        },
        contextOptions: buildIncognitoContextOptions(opts),
      }),
    );
    return finalizeIncognitoSession("chromium", { browser, context, page, cdp });
  }
  const { profileDir, options, chromiumArgs } = buildManagedLaunch("chromium", opts);
  const adapter = new PlaywrightChromiumAdapter();
  const { context, page, cdp } = await launchWithChannelPlan(plan, (channelOption) =>
    adapter.launchPersistent({
      profileDir,
      options: {
        ...options,
        ...(chromiumArgs.length ? { args: chromiumArgs } : {}),
        ...automationSwitchOptions(),
        ...channelOption,
      },
    }),
  );
  return finalizeManagedSession("chromium", opts, profileDir, { context, page, cdp });
}

registerEngine({
  kind: "chromium",
  capabilities: capabilitiesFor("chromium")!,
  makeAdapter: makeChromiumAdapter,
  makeSubstrates: (deps) => playwrightSubstrateBundle(deps),
  postWire: (entry, deps) => playwrightPostWire(entry, deps),
});
