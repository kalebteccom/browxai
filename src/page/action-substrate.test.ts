import { describe, it, expect } from "vitest";
import { SafariActionSubstrate } from "./action-substrate.js";
import { RefRegistry } from "./refs.js";
import type { SafariSessionHandle } from "../engine/index.js";

// The ActionSubstrate port routing/gating. PlaywrightActionSubstrate is trivial
// delegation to actions.* (covered by the per-engine keystones); these cover the
// Safari adapter's curated-subset routing + the in-adapter gating that replaced
// the per-handler `if (engine === "safari")` branches (RFC 0003).

function safariHandle(): { handle: SafariSessionHandle; navigated: string[] } {
  const navigated: string[] = [];
  const handle = {
    sessionId: "S",
    webDriver: {
      currentUrl: async () => "about:blank",
      navigate: async (_s: string, url: string) => {
        navigated.push(url);
      },
      findElement: async () => null,
    },
  } as unknown as SafariSessionHandle;
  return { handle, navigated };
}

describe("SafariActionSubstrate", () => {
  it("tags the safari engine", () => {
    const { handle } = safariHandle();
    expect(new SafariActionSubstrate(handle, new RefRegistry()).engine).toBe("safari");
  });

  it("routes navigate to the WebDriver client", async () => {
    const { handle, navigated } = safariHandle();
    const sub = new SafariActionSubstrate(handle, new RefRegistry());
    const r = await sub.navigate({ url: "https://example.com/" });
    expect(r.ok).toBe(true);
    expect(navigated).toEqual(["https://example.com/"]);
  });

  it("gates the actions outside the curated subset cleanly (in the adapter, not the handler)", async () => {
    const { handle } = safariHandle();
    const sub = new SafariActionSubstrate(handle, new RefRegistry());
    for (const r of [
      await sub.hover({ target: { selector: "#x" } }),
      await sub.select({ target: { selector: "#x" }, values: ["a"] }),
      await sub.scroll({}),
      await sub.goBack({}),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/not supported on the Safari engine/);
    }
  });

  it("press without a target refuses (page-level press has no WebDriver element)", async () => {
    const { handle } = safariHandle();
    const sub = new SafariActionSubstrate(handle, new RefRegistry());
    const r = await sub.press({ key: "Enter" });
    expect(r.ok).toBe(false);
  });
});
