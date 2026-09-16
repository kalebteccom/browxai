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
  it("is a managed, browser-owning safari session", () => {
    const { handle } = fakeHandle();
    const sess = buildSafariSession(handle);
    expect(sess.mode).toBe("managed");
    expect(sess.ownsBrowser).toBe(true);
    expect(sess.engine).toBe("safari");
  });

  it("omits the page member entirely — the engine backs none", () => {
    const { handle } = fakeHandle();
    const sess = buildSafariSession(handle);
    // Absent, not present-and-throwing. A present member is the L5 violation RFC
    // 0004 named, and it made `requirePage`'s `!session.page` guard false on the
    // one engine it exists for, so the structured refusal below was dead code.
    expect(sess.page).toBeUndefined();
    expect("page" in sess).toBe(false);
  });

  it("requirePage refuses with the engine-naming message, not a Safari throw", () => {
    const { handle } = fakeHandle();
    const sess = buildSafariSession(handle);
    // The replacement message is strictly better than the one it replaced: it
    // names the engine, says the engine declares no `page` sub-interface, and
    // points at the capability substrates. `replay/session.ts` catches it to fall
    // back to an action-only archive, the same as before.
    expect(() => requirePage(sess)).toThrow(/engine "safari" backs no Playwright Page/);
    expect(() => requirePage(sess)).toThrow(/declares no `page` sub-interface/);
    expect(() => requirePage(sess)).toThrow(/capability substrate/);
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
