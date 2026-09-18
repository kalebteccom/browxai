// Electron detection over a FAKED CDP transport. The real signal is one
// `Browser.getVersion` round trip at the browser level, so a fake that answers
// that one command exercises the whole decision — no browser, no Electron app.
//
// The user-agent strings below are VERBATIM captures, not hand-written: the VS
// Code one came off a live attach to VS Code 1.122.1 / Electron 39.8.8 on
// 127.0.0.1:9333, and the Chrome one off Playwright's bundled Chrome for Testing.
// A hand-written UA would let this file agree with a regex that never matched
// anything real, which is the only way a detection test can be worse than none.

import { describe, it, expect, vi } from "vitest";
import type { Browser } from "playwright-core";
import { profileAttachedBrowser } from "./electron-detect.js";

/** Measured: VS Code 1.122.1 on Electron 39.8.8, macOS. */
const VSCODE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Code/1.122.1 Chrome/142.0.7444.265 Electron/39.8.8 Safari/537.36";
/** Measured: desktop Chromium, same machine. Note it carries the SAME Chrome
 *  token — which is why `product` and `browser.version()` cannot tell them apart
 *  and the UA is the only place the protocol says it. */
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/142.0.7444.265 Safari/537.36";

/** A `Browser` that answers exactly the one command the detector sends. */
function fakeBrowser(spec: { userAgent?: string; fail?: "session" | "send" }): Browser {
  const detach = vi.fn(async () => {});
  const send = vi.fn(async (method: string) => {
    if (spec.fail === "send") throw new Error(`Protocol error (${method}): boom`);
    return { product: "Chrome/142.0.7444.265", userAgent: spec.userAgent };
  });
  return {
    newBrowserCDPSession: async () => {
      if (spec.fail === "session") throw new Error("CDP session is only available in Chromium");
      return { send, detach };
    },
  } as unknown as Browser;
}

describe("profileAttachedBrowser — which app is on the other end", () => {
  it("reads Electron, its version and the app name off the user agent", async () => {
    const profile = await profileAttachedBrowser(fakeBrowser({ userAgent: VSCODE_UA }));
    expect(profile.engine).toBe("electron");
    expect(profile.detail.electron).toBe("39.8.8");
    expect(profile.detail.app).toBe("Code/1.122.1");
  });

  it("declares Electron cannot create targets, so the pool refuses instead of calling", async () => {
    const profile = await profileAttachedBrowser(fakeBrowser({ userAgent: VSCODE_UA }));
    expect(profile.canCreateTargets).toBe(false);
  });

  it("warns about the live logged-in app and the EDR signature, naming the app", async () => {
    const profile = await profileAttachedBrowser(fakeBrowser({ userAgent: VSCODE_UA }));
    expect(profile.warning).toContain("Code/1.122.1");
    expect(profile.warning).toContain("T1539");
    expect(profile.warning).toMatch(/navigate. is REFUSED/);
  });

  it("reads ordinary Chrome as chromium, with target creation intact", async () => {
    const profile = await profileAttachedBrowser(fakeBrowser({ userAgent: CHROME_UA }));
    expect(profile.engine).toBe("chromium");
    expect(profile.canCreateTargets).toBe(true);
    expect(profile.warning).toContain("EXTERNAL Chrome over CDP");
  });

  it("falls back to chromium when the browser-level CDP session cannot open", async () => {
    // The direction to be wrong in. A probe that cannot answer must leave an
    // ordinary Chromium attach exactly as it was, never guess electron.
    const profile = await profileAttachedBrowser(fakeBrowser({ fail: "session" }));
    expect(profile.engine).toBe("chromium");
    expect(profile.canCreateTargets).toBe(true);
  });

  it("falls back to chromium when Browser.getVersion itself errors", async () => {
    const profile = await profileAttachedBrowser(fakeBrowser({ fail: "send" }));
    expect(profile.engine).toBe("chromium");
  });

  it("falls back to chromium when the endpoint answers with no user agent", async () => {
    const profile = await profileAttachedBrowser(fakeBrowser({}));
    expect(profile.engine).toBe("chromium");
  });

  it("still detects Electron when the app token is missing from the UA", async () => {
    // An app that rewrote its UA but kept the Electron token: the engine is the
    // load-bearing part, the app name is only for the banner.
    const ua = "Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0.0.0 Electron/30.0.1 Safari/537.36";
    const profile = await profileAttachedBrowser(fakeBrowser({ userAgent: ua }));
    expect(profile.engine).toBe("electron");
    expect(profile.detail.electron).toBe("30.0.1");
    expect(profile.detail.app).toBe("an Electron app");
  });

  it("does not match the bare word Electron in a non-version position", async () => {
    const ua = `${CHROME_UA} ElectronCompatible/1.0`;
    expect((await profileAttachedBrowser(fakeBrowser({ userAgent: ua }))).engine).toBe("chromium");
  });

  it("detaches the probe session so it never leaks onto the attached app", async () => {
    // The probe opens a browser-level CDP session on the operator's running app.
    // Leaving it attached would hold protocol state on something browxai does not
    // own for the life of the process.
    const detached: boolean[] = [];
    const browser = {
      newBrowserCDPSession: async () => ({
        send: async () => ({ userAgent: VSCODE_UA }),
        detach: async () => {
          detached.push(true);
        },
      }),
    } as unknown as Browser;
    await profileAttachedBrowser(browser);
    expect(detached).toEqual([true]);
  });
});
