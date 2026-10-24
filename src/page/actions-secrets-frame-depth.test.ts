// The focused-frame walk behind a targetless `press` descends through focused
// <iframe> owners. It stops after 16 levels, so a page that nests frames
// without end cannot hold the walk open.

import { describe, it, expect } from "vitest";
import type { Frame, Page } from "playwright-core";
import { materialiseValue } from "./actions-secrets.js";
import type { ActionContext } from "./actionresult.js";

/** A page whose focused <iframe> always holds another focused <iframe>. Frame
 *  `i` reports `https://frame.test/<i>`. */
function endlessFrames(): { page: Page; descents: () => number } {
  let descents = 0;
  const frameAt = (i: number): Frame =>
    ({
      url: () => `https://frame.test/${i}`,
      locator: () => ({
        count: async () => 1,
        first: () => ({
          elementHandle: async () => ({
            contentFrame: async () => {
              descents += 1;
              return frameAt(i + 1);
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    }) as unknown as Frame;
  const page = { url: () => "https://top.test/", mainFrame: () => frameAt(0) } as unknown as Page;
  return { page, descents: () => descents };
}

/** A frame chain `depth` levels deep, the last frame holding no focused <iframe>. */
function frameChain(depth: number): { page: Page; descents: () => number } {
  let descents = 0;
  const frameAt = (i: number): Frame =>
    ({
      url: () => `https://frame.test/${i}`,
      locator: () => ({
        count: async () => (i < depth ? 1 : 0),
        first: () => ({
          elementHandle: async () => ({
            contentFrame: async () => {
              descents += 1;
              return frameAt(i + 1);
            },
            dispose: async () => undefined,
          }),
        }),
      }),
    }) as unknown as Frame;
  const page = { url: () => "https://top.test/", mainFrame: () => frameAt(0) } as unknown as Page;
  return { page, descents: () => descents };
}

function scopedCtx(page: Page): { ctx: ActionContext; seenUrl: () => string | undefined } {
  let seen: string | undefined;
  const secrets = {
    needsScopeCheck: () => true,
    materialize: (_raw: string, url: string) => {
      seen = url;
      return { ok: true, value: "real" };
    },
  };
  return { ctx: { page, secrets } as unknown as ActionContext, seenUrl: () => seen };
}

describe("focused-frame walk depth", () => {
  it("stops after 16 levels when frames nest without end", async () => {
    const { page, descents } = endlessFrames();
    const { ctx, seenUrl } = scopedCtx(page);
    const m = await materialiseValue(ctx, "<SECRET>", "focused");
    expect(m.ok).toBe(true);
    expect(descents()).toBe(16);
    expect(seenUrl()).toBe("https://frame.test/16");
  });

  it("reaches the innermost frame of a chain shorter than the cap", async () => {
    const { page, descents } = frameChain(5);
    const { ctx, seenUrl } = scopedCtx(page);
    await materialiseValue(ctx, "<SECRET>", "focused");
    expect(descents()).toBe(5);
    expect(seenUrl()).toBe("https://frame.test/5");
  });
});
