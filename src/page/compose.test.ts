//  compose tests. The surface area on compose is the new
// `opts.pierce` knob. Two things to assert:
//   1. Back-compat — omitting `opts` (or passing `{}`) produces a result
//      whose shape is byte-identical to pre-v0.5.0 (no `closedShadowEntries`
//      stat, no -only warnings).
//   2. Pierce-closed — when CDP refuses pierce we fall back to open-only +
//      surface a warning; when CDP returns closed candidates we merge them
//      into the tree.
//
// All CDP work is faked — no Playwright/Chromium here.

import { describe, it, expect, vi } from "vitest";
import type { CDPSession } from "playwright-core";
import { composeSnapshot } from "./compose.js";
import { RefRegistry } from "./refs.js";

function fakeCdp(sendImpl: (method: string, params?: unknown) => Promise<unknown>): CDPSession {
  return { send: vi.fn(sendImpl) } as unknown as CDPSession;
}

// Minimal a11y / DOM-walk / pierce stubs. Each `cdp.send` method is
// matched on by string; unmatched methods throw to surface coverage gaps.
function happyPathCdp(opts: { closedAvailable?: boolean; pierceFails?: boolean } = {}): CDPSession {
  return fakeCdp(async (method, params) => {
    switch (method) {
      case "Accessibility.enable":
        return {};
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "1",
              role: { value: "WebArea" },
              name: { value: "Page" },
              childIds: ["2"],
            },
            {
              nodeId: "2",
              parentId: "1",
              role: { value: "button" },
              name: { value: "Open" },
              backendDOMNodeId: 100,
            },
          ],
        };
      case "DOM.getAttributes":
        // Avoid testId enrichment in this unit test — return empty.
        return { attributes: [] };
      case "Runtime.evaluate":
        // The DOM-walk page script returns []. The OPEN_SHADOW_WALK
        // (called by shadow_trees) isn't exercised here.
        return { result: { value: [] } };
      case "DOM.getDocument": {
        if (opts.pierceFails) throw new Error("pierce unsupported on this build");
        const closedRoot = opts.closedAvailable
          ? [
              {
                nodeType: 9,
                nodeName: "#document-fragment",
                shadowRootType: "closed" as const,
                children: [
                  {
                    nodeType: 1,
                    localName: "button",
                    nodeName: "BUTTON",
                    backendNodeId: 999,
                    attributes: ["data-testid", "closed-cta"],
                    children: [],
                  },
                ],
              },
            ]
          : [];
        return {
          root: {
            nodeType: 9,
            nodeName: "#document",
            backendNodeId: 1,
            children: [
              {
                nodeType: 1,
                localName: "html",
                nodeName: "HTML",
                backendNodeId: 2,
                children: [
                  {
                    nodeType: 1,
                    localName: "my-app",
                    nodeName: "MY-APP",
                    backendNodeId: 10,
                    children: [],
                    shadowRoots: closedRoot,
                  },
                ],
              },
            ],
          },
        };
      }
      default:
        throw new Error(`unexpected CDP method ${method} (params=${JSON.stringify(params)})`);
    }
  });
}

describe("composeSnapshot —  back-compat", () => {
  it("omitting `opts` produces no stats and no warnings", async () => {
    const cdp = happyPathCdp();
    const refs = new RefRegistry();
    const out = await composeSnapshot(cdp, refs, ["data-testid"]);
    expect(out.stats).not.toHaveProperty("closedShadowEntries");
    expect(out.warnings.some((w) => w.toLowerCase().includes("closed"))).toBe(false);
    // CDP DOM.getDocument MUST NOT have been called when pierce wasn't
    // requested — the cost is non-trivial on big pages.
    const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("DOM.getDocument");
  });

  it("passing `{}` is identical to omitting opts", async () => {
    const cdp = happyPathCdp();
    const refs = new RefRegistry();
    const out = await composeSnapshot(cdp, refs, ["data-testid"], {});
    expect(out.stats).not.toHaveProperty("closedShadowEntries");
  });
});

describe("composeSnapshot —  pierce: 'closed'", () => {
  it("merges closed-shadow candidates and surfaces the inspect-only warning", async () => {
    const cdp = happyPathCdp({ closedAvailable: true });
    const refs = new RefRegistry();
    const out = await composeSnapshot(cdp, refs, ["data-testid"], { pierce: "closed" });
    expect(out.stats.closedShadowEntries).toBeGreaterThanOrEqual(1);
    expect(out.warnings.some((w) => w.includes("CLOSED shadow root"))).toBe(true);
    // The CDP call was made.
    const calls = (cdp.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toContain("DOM.getDocument");
  });

  it("when CDP pierce fails, warns + falls back without crashing", async () => {
    const cdp = happyPathCdp({ pierceFails: true });
    const refs = new RefRegistry();
    const out = await composeSnapshot(cdp, refs, ["data-testid"], { pierce: "closed" });
    expect(out.stats.closedShadowEntries).toBe(0);
    expect(out.warnings.some((w) => w.includes("closed-shadow piercing unavailable"))).toBe(true);
    // Tree still composed — open-shadow / a11y data unaffected.
    expect(out.tree).not.toBeNull();
  });
});
