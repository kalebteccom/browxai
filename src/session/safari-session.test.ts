import { describe, it, expect } from "vitest";
import { buildSafariSession } from "./safari-session.js";
import { requirePage } from "../engine/index.js";
import { openIncognitoSession } from "./incognito.js";
import { openByobSession } from "./byob.js";
import type { SafariSessionHandle } from "../engine/index.js";

// The no-Playwright-Page session seam: buildSafariSession wraps a Safari adapter
// handle as a BrowserSession that OMITS the `page` member; and the non-managed
// factories refuse safari (it is managed/isolated-only). All without
// safaridriver.

function fakeHandle(): { handle: SafariSessionHandle; closed: () => boolean } {
  let closeCount = 0;
  const handle = {
    engine: "safari",
    sessionId: "SID",
    hasBidi: false,
    close: async () => {
      closeCount++;
    },
  } as unknown as SafariSessionHandle;
  return { handle, closed: () => closeCount > 0 };
}

describe("buildSafariSession", () => {
  it("requirePage refuses with the engine-naming message, not a Safari throw", () => {
    const { handle } = fakeHandle();
    const sess = buildSafariSession(handle);
    // The replacement message is strictly better than the one it replaced: it
    // names the engine, says it has no browser page, and
    // lists the engines that have one. `replay/session.ts` catches it to fall
    // back to an action-only archive, the same as before.
    expect(() => requirePage(sess)).toThrow(/engine "safari" has no browser page/);
    expect(() => requirePage(sess)).toThrow(/has no browser page/);
    expect(() => requirePage(sess)).toThrow(/Use a chromium, firefox, webkit or android session/);
  });

  it("close() tears the handle down once (idempotent)", async () => {
    const { handle, closed } = fakeHandle();
    const sess = buildSafariSession(handle);
    await sess.close();
    await sess.close();
    expect(closed()).toBe(true);
  });
});

describe("safari is managed/isolated-only", () => {
  it("incognito refuses safari (no separate-context concept)", async () => {
    await expect(openIncognitoSession({ browserType: "safari" })).rejects.toThrow(
      /safari-incognito-not-supported/,
    );
  });

  it("byob refuses safari (attach-to-live impossible by design)", async () => {
    await expect(openByobSession({ browserType: "safari" })).rejects.toThrow(
      /safari-attach-not-supported/,
    );
  });
});
