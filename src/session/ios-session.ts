// The ios-app `BrowserSession` — the second no-Playwright-Page engine, and the
// first with no document at all. It wraps the native handle (a device id, an app
// id and the XCUITest driver) and OMITS `page`, exactly as the Safari session
// does and for the same reason: page-availability is declared once, as
// `caps.subInterfaces.has("page")`, and a present-but-throwing member would be a
// second oracle that can disagree with the declaration.
//
// `close()` tears down the XCUITest session and terminates the app under test. It
// does NOT shut the simulator down: booting one costs tens of seconds, the
// operator may well have booted it themselves, and a session that shuts down a
// device it did not boot is destroying state outside its own lifetime. What this
// session owns is the driver session and the app process.
//
// Factored out of the engine module so it unit-tests with a fake driver — no
// simulator, no WebDriverAgent.

import type { IosNativeHandle } from "../engine/index.js";
import type { BrowserSession } from "./types.js";

export function buildIosSession(handle: IosNativeHandle): BrowserSession {
  let closed = false;
  return {
    mode: "managed",
    ownsBrowser: true,
    engine: "ios-app",
    native: () => handle,
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}
