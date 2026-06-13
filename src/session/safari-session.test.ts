import { describe, it, expect } from "vitest";
import { buildSafariSession, NO_PLAYWRIGHT_PAGE } from "./safari-session.js";
import { openIncognitoSession } from "./incognito.js";
import { openByobSession } from "./byob.js";
import type { SafariSessionHandle } from "../engine/index.js";

// The no-Playwright-Page session seam (RFC 0002 P4): buildSafariSession wraps a
// Safari adapter handle as a BrowserSession whose page() throws; and the
// non-managed factories refuse safari (it is managed/isolated-only). All without
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
  it("is a managed, browser-owning safari session", () => {
    const { handle } = fakeHandle();
    const sess = buildSafariSession(handle);
    expect(sess.mode).toBe("managed");
    expect(sess.ownsBrowser).toBe(true);
    expect(sess.engine).toBe("safari");
  });

  it("page() throws the structured no-Playwright-Page error", () => {
    const { handle } = fakeHandle();
    const sess = buildSafariSession(handle);
    expect(() => sess.page()).toThrow(NO_PLAYWRIGHT_PAGE);
  });

  it("safari() exposes the native handle and cdp is absent", () => {
    const { handle } = fakeHandle();
    const sess = buildSafariSession(handle);
    expect(sess.safari?.()).toBe(handle);
    expect(sess.cdp).toBeUndefined();
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
