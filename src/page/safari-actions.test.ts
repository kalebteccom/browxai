import { describe, it, expect } from "vitest";
import { safariNavigate, safariClick, safariFill, safariPress } from "./safari-actions.js";
import { RefRegistry } from "./refs.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { ActionTarget } from "./locator.js";

// The Safari action helpers drive the Safari-native WebDriver Classic client and
// return the engine-blind ActionResult shape. The real path is covered by the
// Safari keystone (mac only); this gives CI coverage with a mock handle.

function fakeHandle(urls: string[]): { handle: SafariSessionHandle; navigated: string[] } {
  const navigated: string[] = [];
  let call = 0;
  const handle = {
    sessionId: "S",
    webDriver: {
      currentUrl: async () => urls[Math.min(call++, urls.length - 1)] ?? "",
      navigate: async (_sid: string, url: string) => {
        navigated.push(url);
      },
    },
  } as unknown as SafariSessionHandle;
  return { handle, navigated };
}

/** A mock WebDriver client recording element interactions for the action tests. */
function fakeElementHandle(found: string | null): {
  handle: SafariSessionHandle;
  calls: { clicked: string[]; cleared: string[]; typed: Array<[string, string]> };
} {
  const calls = {
    clicked: [] as string[],
    cleared: [] as string[],
    typed: [] as Array<[string, string]>,
  };
  const handle = {
    sessionId: "S",
    webDriver: {
      findElement: async (_sid: string, _using: string, selector: string) =>
        found ? `EL(${selector})` : null,
      elementClick: async (_sid: string, el: string) => {
        calls.clicked.push(el);
      },
      elementClear: async (_sid: string, el: string) => {
        calls.cleared.push(el);
      },
      elementValue: async (_sid: string, el: string, text: string) => {
        calls.typed.push([el, text]);
      },
      elementProperty: async () => "typed-back",
    },
  } as unknown as SafariSessionHandle;
  return { handle, calls };
}

describe("safariNavigate", () => {
  it("navigates via WebDriver Classic and reports the before/after URL change", async () => {
    const { handle, navigated } = fakeHandle(["about:blank", "https://example.com/"]);
    const r = await safariNavigate(handle, "https://example.com/");
    expect(navigated).toEqual(["https://example.com/"]);
    expect(r.ok).toBe(true);
    expect(r.action).toEqual({ type: "navigate", url: "https://example.com/" });
    expect(r.navigation).toMatchObject({
      changed: true,
      from: "about:blank",
      to: "https://example.com/",
      kind: "full_load",
    });
  });

  it("reports changed:false + kind:null when the URL does not change", async () => {
    const { handle } = fakeHandle(["https://example.com/", "https://example.com/"]);
    const r = await safariNavigate(handle, "https://example.com/");
    expect(r.navigation.changed).toBe(false);
    expect(r.navigation.kind).toBeNull();
  });

  it("surfaces an honest warning that the envelope deltas are not captured on Safari", async () => {
    const { handle } = fakeHandle(["a", "b"]);
    const r = await safariNavigate(handle, "b");
    expect(r.warnings.join(" ")).toMatch(/not captured on the Safari engine/i);
    expect(r.network.summary).toEqual({ total: 0, byType: {}, failed: 0 });
  });
});

describe("Safari element actions (click / fill / press)", () => {
  const selectorTarget: ActionTarget = { selector: "#go" };

  it("click resolves the selector to a WebDriver element and clicks it", async () => {
    const { handle, calls } = fakeElementHandle("found");
    const r = await safariClick(handle, new RefRegistry(), selectorTarget);
    expect(r.ok).toBe(true);
    expect(calls.clicked).toEqual(["EL(#go)"]);
  });

  it("fill clears then sends keys and reads the value back via element property", async () => {
    const { handle, calls } = fakeElementHandle("found");
    const r = await safariFill(handle, new RefRegistry(), selectorTarget, "hello");
    expect(r.ok).toBe(true);
    expect(calls.cleared).toEqual(["EL(#go)"]);
    expect(calls.typed).toEqual([["EL(#go)", "hello"]]);
    expect(r.element?.value).toBe("typed-back");
  });

  it("press maps a named key to its single-char WebDriver code", async () => {
    const { handle, calls } = fakeElementHandle("found");
    await safariPress(handle, new RefRegistry(), selectorTarget, "Enter");
    expect(calls.typed[0]?.[0]).toBe("EL(#go)");
    const sent = calls.typed[0]?.[1] ?? "";
    expect(sent).not.toBe("Enter"); // mapped, not sent literally
    expect(sent).toHaveLength(1); // a single WebDriver key codepoint (U+E007)
  });

  it("resolves a ref to its snapshot test-attribute selector", async () => {
    const { handle, calls } = fakeElementHandle("found");
    const refs = new RefRegistry();
    const ref = refs.forKey("k", { role: "button", testId: "save", testIdAttr: "data-testid" });
    await safariClick(handle, refs, { ref });
    expect(calls.clicked).toEqual([`EL([data-testid="save"])`]);
  });

  it("refuses a target that is not addressable (no selector / no locatable ref)", async () => {
    const { handle } = fakeElementHandle("found");
    const r = await safariClick(handle, new RefRegistry(), { ref: "e999" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not addressable on the Safari engine/);
  });

  it("reports a clean failure when no element matches", async () => {
    const { handle } = fakeElementHandle(null);
    const r = await safariClick(handle, new RefRegistry(), selectorTarget);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no element matches/);
  });
});
