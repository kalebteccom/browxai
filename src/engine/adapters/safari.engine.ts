// Safari engine registration (RFC 0004 D1 + D5). Safari is the first
// non-Playwright, no-Page engine — real Safari.app over safaridriver. Its
// `EngineEntry` is what closes the Safari LSP leak: the engine declares no `page`
// sub-interface (capabilities.ts), supplies the Safari `SubstrateBundle` (every
// selector reads the Safari-native handle, never a Page/CDP), and its `postWire`
// attaches ONLY the BiDi console bridge — omitting every Playwright-only step. So
// the 17 scattered `sess.engine !== "safari"` guards have no reason to exist, and
// the `page()`-throws fallback in safari-session.ts is never reached on the
// relocated path.

import type { BrowserSession, SessionOptions } from "../../session/types.js";
import { log } from "../../util/logging.js";
import { registerEngine } from "../registry.js";
import { capabilitiesFor } from "../capabilities.js";
import { SafaridriverHybridAdapter } from "./safaridriver-hybrid.js";
import { buildSafariSession } from "../../session/safari-session.js";
import { safariSubstrateBundle } from "../../page/substrate-bundle-safari.js";
import { safariPostWire } from "../../session/safari-post-wire.js";

async function makeSafariAdapter(opts: SessionOptions): Promise<BrowserSession> {
  const mode = opts.launchMode ?? "managed";
  if (mode === "incognito") {
    // safari runs ISOLATED automation windows via the default managed session
    // (safaridriver already isolates each session). Incognito (a separate
    // in-browser context) is a Playwright concept safaridriver has no equivalent
    // for, so refuse rather than silently launch a managed window.
    throw new Error(
      "safari-incognito-not-supported: the safari engine runs isolated automation windows via the " +
        "default managed session (safaridriver isolates each session by construction). Incognito (a " +
        "separate browser context) is a Playwright concept safaridriver has no equivalent for. Open a " +
        "managed session instead.",
    );
  }
  if (mode === "byob") {
    // safari cannot attach to a live browser at all — safaridriver hard-isolates
    // each session into a clean ephemeral automation window. Surface the adapter's
    // structured `safari-attach-not-supported`.
    await new SafaridriverHybridAdapter().attach();
    throw new Error("unreachable: safari attach always refuses");
  }
  // managed IS the safari model (no headless Safari, no separate-context
  // incognito) — an isolated automation window over safaridriver, whose page()
  // throws; Safari-capable tools route through session.safari().
  const handle = await new SafaridriverHybridAdapter().launchManaged();
  log.info("session.managed: safari session ready", {
    sessionId: handle.sessionId,
    hasBidi: handle.hasBidi,
  });
  return buildSafariSession(handle);
}

registerEngine({
  kind: "safari",
  capabilities: capabilitiesFor("safari")!,
  makeAdapter: makeSafariAdapter,
  makeSubstrates: (deps) => safariSubstrateBundle(deps),
  postWire: (entry, deps) => safariPostWire(entry, deps),
});
