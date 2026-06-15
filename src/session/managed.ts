// Managed-profile launch. Normal Chrome flags, sandbox on, profile dir rooted at
// $BROWX_WORKSPACE/profile/. Never `cwd`, never the human's daily-driver profile,
// never lowered-security flags.
//
// Post-RFC-0004-P1 this factory keeps only its MODE concern: it resolves the
// engine and hands off to the EngineRegistry, whose `makeAdapter` owns the
// per-engine managed-launch body (the `engine === "…"` chain that used to live
// here is now data-driven, one registration per engine). The per-engine launch
// + session construction is byte-identical — only relocated into the engine
// modules (see src/engine/adapters/*.engine.ts + src/session/launch-options.ts).

import { engineEntry } from "../engine/registry.js";
import type { EngineKind } from "../engine/index.js";
import "../engine/register-engines.js";
import type { BrowserSession, SessionOptions } from "./types.js";

export async function openManagedSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const engine: EngineKind = opts.browserType ?? "chromium";
  return engineEntry(engine).makeAdapter({ ...opts, launchMode: "managed" });
}
