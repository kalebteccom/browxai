// BYOB / attach session — the MODE-concern entry point. Post-RFC-0004-P1 this
// keeps only its mode concern: it resolves the engine and hands off to the
// EngineRegistry, whose `makeAdapter` owns the per-engine attach body (android
// over adb; chromium over CDP; firefox/webkit/safari structured refusals — all in
// adapters/<engine>.engine.ts). The `engine === "…"` dispatch chain that used to
// live here is now data-driven — byte-identical, only relocated.
//
// The attach PRIMITIVES (`attachByobChromium` / `openAndroidByobSession` /
// `assertByobAttach`) live in byob-attach.ts so the engine-registration graph does
// not cycle back through this module's `engineEntry` import; they are re-exported
// here for back-compat with existing importers.

import { engineEntry } from "../engine/registry.js";
import type { EngineKind } from "../engine/index.js";
import "../engine/register-engines.js";
import type { BrowserSession, SessionOptions } from "./types.js";

export {
  attachByobChromium,
  openAndroidByobSession,
  assertByobAttach,
} from "./byob-attach.js";

/** BYOB / attach session — resolves the engine and hands off to the
 *  EngineRegistry's per-engine attach body. */
export async function openByobSession(
  opts: SessionOptions & { attachCdp?: string },
): Promise<BrowserSession> {
  const engine: EngineKind = opts.browserType ?? "chromium";
  return engineEntry(engine).makeAdapter({ ...opts, launchMode: "byob" });
}
