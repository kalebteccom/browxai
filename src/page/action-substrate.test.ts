import { describe, it, expect } from "vitest";
import {
  PlaywrightActionSubstrate,
  SafariActionSubstrate,
  type ActionSubstrate,
} from "./action-substrate.js";
import { DIRECT_DISPATCH_ENGINE_REFUSAL } from "./actions-direct-dispatch.js";
import { RefRegistry } from "./refs.js";
import type { ActionContext } from "./actionresult.js";
import type { SafariSessionHandle } from "../engine/index.js";

// The ActionSubstrate port routing/gating. PlaywrightActionSubstrate is trivial
// delegation to actions.* (covered by the per-engine keystones); these cover the
// Safari adapter's curated-subset routing + the in-adapter gating that replaced
// the per-handler `if (engine === "safari")` branches.

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
    const sub: ActionSubstrate = new SafariActionSubstrate(handle, new RefRegistry());
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

  it('refuses click({dispatch:"direct"}) with the named reason — Safari has no CDP', async () => {
    const { handle } = safariHandle();
    const sub = new SafariActionSubstrate(handle, new RefRegistry());
    const r = await sub.click({ target: { selector: "#send" }, dispatch: "direct" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(DIRECT_DISPATCH_ENGINE_REFUSAL);
    expect(r.error).toContain('"safari"');
  });
});

// The engine gate for `dispatch:"direct"` lives at this seam, keyed on the
// ActionContext carrying a CDP accessor — never on an engine name.
describe("PlaywrightActionSubstrate — the dispatch:'direct' engine gate", () => {
  const ctxFor = (cdp: boolean): ActionContext =>
    ({ ...(cdp ? { cdp: () => ({}) as never } : {}) }) as unknown as ActionContext;

  it("refuses on an engine whose context carries no CDP accessor", async () => {
    const sub = new PlaywrightActionSubstrate(() => ctxFor(false), "firefox");
    const r = await sub.click({ target: { selector: "#send" }, dispatch: "direct" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(DIRECT_DISPATCH_ENGINE_REFUSAL);
    expect(r.error).toContain('"firefox"');
  });

  it("does not refuse when the option is unset, on any engine", async () => {
    let reached = false;
    const sub = new PlaywrightActionSubstrate(() => {
      reached = true;
      return ctxFor(false);
    }, "webkit");
    await sub.click({ target: { selector: "#send" } }).catch(() => undefined);
    expect(reached).toBe(true);
  });
});
