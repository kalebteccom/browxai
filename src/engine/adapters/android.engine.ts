// Android engine registration (RFC 0004 D1). Android is real Chrome-on-Android
// attached over adb + CDP — it IS Chromium, so it reuses the shared Playwright
// substrate bundle (CDP present → the verbatim CDP snapshot/network substrates)
// and the full Playwright post-wire. It is ATTACH-ONLY: managed / incognito launch
// (spawning a browser we own) is not a thing on the user's phone, so those modes
// surface the adapter's structured `android-launch-not-supported`. BYOB attaches
// over adb via `openAndroidByobSession` (endpoint discovered, not URL-configured).

import type { BrowserSession, SessionOptions } from "../../session/types.js";
import { registerEngine } from "../registry.js";
import { capabilitiesFor } from "../capabilities.js";
import { AndroidCdpAdapter } from "./android-cdp.js";
import { playwrightSubstrateBundle } from "../../page/substrate-bundle.js";
import { playwrightPostWire } from "../../session/playwright-post-wire.js";
import { openAndroidByobSession } from "../../session/byob-attach.js";

async function makeAndroidAdapter(opts: SessionOptions): Promise<BrowserSession> {
  const mode = opts.launchMode ?? "managed";
  if (mode === "byob") {
    return openAndroidByobSession();
  }
  // managed / incognito — spawning a browser we own is not a thing on a phone;
  // the adapter's launch path returns the structured `android-launch-not-supported`
  // refusal (it throws, never returns).
  await new AndroidCdpAdapter().launch();
  throw new Error("unreachable: android launch always refuses");
}

registerEngine({
  kind: "android",
  capabilities: capabilitiesFor("android")!,
  makeAdapter: makeAndroidAdapter,
  makeSubstrates: (deps) => playwrightSubstrateBundle(deps),
  postWire: (entry, deps) => playwrightPostWire(entry, deps),
});
