// The Safari post-creation wiring (RFC 0004 D1 + D5). Safari attaches NOTHING
// Playwright-bound — it has no Page, no CDP, no BrowserContext. Its only
// post-creation step is the BiDi console bridge: Safari's console arrives over the
// experimental WebDriver-BiDi `log.entryAdded` stream (when the cap negotiated),
// not via a Playwright page. Subscribed here at session creation so load-time logs
// are caught; strictly optional (when BiDi did not negotiate, the buffer stays
// empty and `console_read` still works, returning nothing).
//
// This is the `else` leg of the old `if (sess.engine !== "safari")` console guard
// in session-registry.ts:303-313 — relocated verbatim into the engine that owns
// it, so the caller no longer branches on the engine name.

import type { SessionEntry } from "./registry.js";
import type { PostWireDeps } from "../engine/registry.js";

/** Attach Safari's BiDi console bridge to the entry's console buffer. Returns the
 *  promise the session factory awaits (the BiDi `subscribe` is async). Takes the
 *  per-server `PostWireDeps` to honour the standardized `postWire(entry, deps)`
 *  contract, but ignores them: Safari attaches only its BiDi console bridge, none of
 *  the Playwright caps/configStore/workspace-gated steps. */
export async function safariPostWire(entry: SessionEntry, _deps: PostWireDeps): Promise<void> {
  const handle = entry.session.safari?.();
  if (handle?.bidi) {
    const bidi = handle.bidi;
    await bidi.subscribe(["log.entryAdded"]).catch(() => undefined);
    bidi.on("log.entryAdded", (p) => {
      const level = typeof p.level === "string" ? p.level : "info";
      const text = typeof p.text === "string" ? p.text : "";
      entry.console.ingest(level, text);
    });
  }
}
