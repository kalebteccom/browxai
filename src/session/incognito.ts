// Incognito launch. A fresh browser process + an *ephemeral* BrowserContext: no
// profile dir, nothing persisted to disk, everything (cookies, storage, cache)
// discarded on close. Same safe-by-default flags as managed (no
// `--disable-web-security`, sandbox on). Use for one-off agentic driving where you
// explicitly do NOT want a profile trace.
//
// The no-trace consumer-repo contract is unaffected — there was never any
// consumer-cwd write; incognito additionally leaves no Chrome profile behind.
//
// Post-RFC-0004-P1 this factory keeps only its MODE concern: it resolves the
// engine and hands off to the EngineRegistry, whose `makeAdapter` owns the
// per-engine ephemeral-launch body (the `engine === "…"` chain that used to live
// here is now data-driven, one registration per engine). The per-engine launch +
// session construction is byte-identical — only relocated into the engine modules.

import { engineEntry } from "../engine/registry.js";
import type { EngineKind } from "../engine/index.js";
import "../engine/register-engines.js";
import type { BrowserSession, SessionOptions } from "./types.js";

export async function openIncognitoSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const engine: EngineKind = opts.browserType ?? "chromium";
  return engineEntry(engine).makeAdapter({ ...opts, launchMode: "incognito" });
}
