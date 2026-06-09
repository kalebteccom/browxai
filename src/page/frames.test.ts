import { describe, it, expect } from "vitest";
import type { Frame, Page } from "playwright-core";
import {
  FrameRegistry,
  fingerprintOf,
  listFrames,
  originOf,
  resolveFrameById,
  MAIN_FRAME_ID,
} from "./frames.js";

// Tiny in-memory Frame tree. Each fake frame carries the surface
// `listFrames` and `resolveFrameById` touch — nothing more.
interface FakeFrameInit {
  url: string;
  name?: string;
  children?: FakeFrameInit[];
}

function buildTree(init: FakeFrameInit, parent: Frame | null = null): Frame {
  const childrenInit = init.children ?? [];

  const f = {
    _url: init.url,
    _name: init.name ?? "",
    _parent: parent,
    _children: [] as Frame[],
    url() {
      return (this as any)._url as string;
    },
    name() {
      return (this as any)._name as string;
    },
    parentFrame() {
      return (this as any)._parent as Frame | null;
    },
    childFrames() {
      return (this as any)._children as Frame[];
    },
  } as unknown as Frame;

  (f as any)._children = childrenInit.map((c) => buildTree(c, f));
  return f;
}

function fakePage(main: Frame): Page {
  return { mainFrame: () => main } as unknown as Page;
}

describe("originOf", () => {
  it("returns the URL origin for http/https", () => {
    expect(originOf("http://example.com/foo")).toBe("http://example.com");
    expect(originOf("https://a.b.c:8443/x?y")).toBe("https://a.b.c:8443");
  });

  it("returns empty for opaque / synthetic schemes", () => {
    expect(originOf("about:blank")).toBe("");
    expect(originOf("data:text/html,abc")).toBe("");
    expect(originOf("blob:http://example.com/uuid")).toBe("");
  });

  it("returns empty for invalid URLs", () => {
    expect(originOf("")).toBe("");
    expect(originOf("not a url")).toBe("");
  });
});

describe("FrameRegistry / listFrames", () => {
  it("emits the main frame first as f0 with no parentFrameId", () => {
    const main = buildTree({ url: "http://example.com/" });
    const page = fakePage(main);
    const reg = new FrameRegistry();
    const out = listFrames(page, reg);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      frameId: MAIN_FRAME_ID,
      url: "http://example.com/",
      isMainFrame: true,
      origin: "http://example.com",
    });
    expect(out[0]!.parentFrameId).toBeUndefined();
  });

  it("walks a nested iframe tree, mints fN IDs depth-first, and tracks parents", () => {
    const main = buildTree({
      url: "http://example.com/",
      children: [
        {
          url: "http://a.test/",
          name: "frame-a",
          children: [{ url: "http://aa.test/", name: "frame-aa" }],
        },
        { url: "http://b.test/", name: "frame-b" },
      ],
    });
    const page = fakePage(main);
    const reg = new FrameRegistry();
    const out = listFrames(page, reg);
    expect(out.map((f) => f.frameId)).toEqual(["f0", "f1", "f2", "f3"]);
    expect(out[0]!.parentFrameId).toBeUndefined();
    expect(out[1]).toMatchObject({ parentFrameId: "f0", name: "frame-a", isMainFrame: false });
    expect(out[2]).toMatchObject({ parentFrameId: "f1", name: "frame-aa" });
    expect(out[3]).toMatchObject({ parentFrameId: "f0", name: "frame-b" });
  });

  it("keeps frameIds stable across repeat listings of the same tree", () => {
    const main = buildTree({
      url: "http://example.com/",
      children: [
        { url: "http://a.test/", name: "a" },
        { url: "http://b.test/", name: "b" },
      ],
    });
    const page = fakePage(main);
    const reg = new FrameRegistry();
    const first = listFrames(page, reg);
    const second = listFrames(page, reg);
    expect(first.map((f) => f.frameId)).toEqual(second.map((f) => f.frameId));
  });

  it("keeps a frameId stable across an intra-iframe URL change (same handle)", () => {
    const main = buildTree({
      url: "http://example.com/",
      children: [{ url: "http://a.test/", name: "a" }],
    });
    const page = fakePage(main);
    const reg = new FrameRegistry();
    const first = listFrames(page, reg);
    const aId = first[1]!.frameId;
    // simulate intra-iframe nav: same Frame handle, different URL

    (main.childFrames()[0]! as any)._url = "http://a.test/somewhere-else";
    const second = listFrames(page, reg);
    expect(second[1]!.frameId).toBe(aId);
    expect(second[1]!.url).toBe("http://a.test/somewhere-else");
  });

  it("fingerprintOf is deterministic and distinguishes siblings by index", () => {
    const a = buildTree({ url: "http://x.test/", name: "n" });
    const b = buildTree({ url: "http://x.test/", name: "n" });
    expect(fingerprintOf(a, "f0", 0)).toBe(fingerprintOf(b, "f0", 0));
    expect(fingerprintOf(a, "f0", 0)).not.toBe(fingerprintOf(a, "f0", 1));
  });
});

describe("resolveFrameById", () => {
  it("returns the main frame for MAIN_FRAME_ID even with no prior listing", () => {
    const main = buildTree({ url: "http://example.com/" });
    const page = fakePage(main);
    const reg = new FrameRegistry();
    expect(resolveFrameById(page, reg, MAIN_FRAME_ID)).toBe(main);
  });

  it("resolves a child frameId back to the right Frame handle", () => {
    const main = buildTree({
      url: "http://example.com/",
      children: [
        { url: "http://a.test/", name: "a" },
        { url: "http://b.test/", name: "b" },
      ],
    });
    const page = fakePage(main);
    const reg = new FrameRegistry();
    const out = listFrames(page, reg);
    const bId = out[2]!.frameId;
    expect(resolveFrameById(page, reg, bId)).toBe(main.childFrames()[1]!);
  });

  it("returns null for an unknown frameId", () => {
    const main = buildTree({ url: "http://example.com/" });
    const page = fakePage(main);
    const reg = new FrameRegistry();
    expect(resolveFrameById(page, reg, "f99")).toBeNull();
  });
});
