import { describe, it, expect } from "vitest";
import { safariNavigate } from "./safari-actions.js";
import type { SafariSessionHandle } from "../engine/index.js";

// safariNavigate drives the Safari-native WebDriver Classic client and returns the
// engine-blind ActionResult shape. The real path is covered by the Safari keystone
// (mac only); this gives CI coverage with a mock handle.

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
    expect(r.warnings.join(" ")).toMatch(/not captured on the safari engine/);
    expect(r.network.summary).toEqual({ total: 0, byType: {}, failed: 0 });
  });
});
