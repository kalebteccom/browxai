// Electron engine registration (RFC 0004 D1). A desktop Electron application —
// VS Code, Slack, Discord — attached over the `--remote-debugging-port` it was
// launched with. It IS Chromium, so it reuses the shared Playwright substrate
// bundle (CDP present → the verbatim CDP snapshot/network substrates) and the
// full Playwright post-wire. Zero new substrate code.
//
// WHY A DISTINCT ENGINE KIND and not a flag on a chromium session. Three of the
// engine layer's existing declarations have to differ, and all three are read by
// machinery keyed on `EngineKind`:
//   - `refusedTools` names `navigate`, because loading a URL into an Electron
//     renderer runs that page inside the application's own privileged renderer
//     and discards everything the renderer held.
//   - `engineIsAttachOnly` is true: browxai never launches the app. The operator
//     launched it; browxai joins.
//   - `list_sessions` reports the engine, and an agent reading "chromium" for a
//     session that refuses `navigate` and cannot open a tab has been told the
//     wrong thing about what it is driving.
// A boolean on the session would put a second, undeclared oracle next to
// `EngineCapabilities` for facts that capability record already exists to hold —
// the exact drift `sub-interface-conformance.test.ts` was written to catch. The
// precedent is `android`, which is also Chromium-over-CDP and is also its own
// kind, for the weaker reason that only its launch shape differs.
//
// ATTACH IS SHARED. `makeAdapter`'s byob branch calls the SAME
// `attachByobDesktop` the chromium engine calls; the engine the session ends up
// on is whatever `profileAttachedBrowser` read off the protocol. So selecting
// `browserType: "electron"` is a hint about the default session MODE, never a
// claim the attach lane trusts over `Browser.getVersion`.

import type { BrowserSession, SessionOptions } from "../../session/types.js";
import { registerEngine } from "../registry.js";
import { capabilitiesFor } from "../capabilities.js";
import { playwrightSubstrateBundle } from "../../page/substrate-bundle.js";
import { playwrightPostWire } from "../../session/playwright-post-wire.js";
import { attachByobDesktop } from "../../session/byob-attach.js";

async function makeElectronAdapter(opts: SessionOptions): Promise<BrowserSession> {
  const mode = opts.launchMode ?? "managed";
  if (mode === "byob") {
    return attachByobDesktop(opts);
  }
  // managed / incognito — browxai does not own the application and will not
  // spawn one. Launching an Electron app with a debugging port is a decision
  // about the operator's own machine and their own data; it stays the operator's
  // to make, and the message says how.
  throw new Error(
    "electron-launch-not-supported: the electron engine is ATTACH-ONLY — browxai does not " +
      "launch desktop applications. Start the app yourself with a loopback debugging port " +
      "(e.g. `/Applications/Slack.app/Contents/MacOS/Slack --remote-debugging-port=9333`), " +
      "then point browxai at it with BROWX_ATTACH_CDP=http://127.0.0.1:9333 and grant the " +
      "`byob-attach` capability. Note that the port is UNAUTHENTICATED for the app's whole " +
      "lifetime and the app holds a logged-in session: see docs/threat-model.md before you do " +
      "this to an app that matters.",
  );
}

registerEngine({
  kind: "electron",
  capabilities: capabilitiesFor("electron")!,
  makeAdapter: makeElectronAdapter,
  makeSubstrates: (deps) => playwrightSubstrateBundle(deps),
  postWire: (entry, deps) => playwrightPostWire(entry, deps),
});
