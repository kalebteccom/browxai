import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import { gotoWithCommitResend, resentWarning, type NavigablePage } from "./navigate-commit.js";

const MAIN = { name: "main" };
const CHILD = { name: "child" };

function response(status: number, frame: object = MAIN, navigation = true) {
  return {
    status: () => status,
    frame: () => frame,
    request: () => ({ isNavigationRequest: () => navigation }),
  };
}

type Step = (page: FakePage, call: number) => Promise<null>;

class FakePage extends EventEmitter {
  calls: Array<{ url: string; timeout: number }> = [];
  constructor(private steps: Step[]) {
    super();
  }
  mainFrame() {
    return MAIN;
  }
  goto(url: string, opts: { timeout: number }) {
    this.calls.push({ url, timeout: opts.timeout });
    const step = this.steps[this.calls.length - 1];
    if (!step) throw new Error("fake page: unexpected goto");
    return step(this, this.calls.length);
  }
  asPage(): NavigablePage {
    return this as unknown as NavigablePage;
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Response arrives, the frame commits, goto resolves. */
const healthy: Step = async (page) => {
  await tick(1);
  page.emit("response", response(200));
  page.emit("framenavigated", MAIN);
  return null;
};

/** Response arrives and the frame never commits; goto rejects at its timeout. */
const stalls =
  (rejectAfterMs: number): Step =>
  async (page) => {
    await tick(1);
    page.emit("response", response(200));
    await tick(rejectAfterMs);
    throw new Error("page.goto: Timeout exceeded");
  };

describe("gotoWithCommitResend", () => {
  it("navigates once when the frame commits", async () => {
    const page = new FakePage([healthy]);
    await expect(gotoWithCommitResend(page.asPage(), "http://x/", 5000, 20)).resolves.toEqual({
      resent: false,
    });
    expect(page.calls).toHaveLength(1);
    expect(page.listenerCount("response")).toBe(0);
    expect(page.listenerCount("framenavigated")).toBe(0);
  });

  it("sends the navigation again when the response arrived and the frame never committed", async () => {
    const page = new FakePage([stalls(200), healthy]);
    await expect(gotoWithCommitResend(page.asPage(), "http://x/", 5000, 20)).resolves.toEqual({
      resent: true,
    });
    expect(page.calls.map((c) => c.url)).toEqual(["http://x/", "http://x/"]);
    // The resend gets what is left of the budget, not a fresh one.
    expect(page.calls[1]!.timeout).toBeLessThan(5000);
    expect(page.calls[1]!.timeout).toBeGreaterThan(4000);
  });

  it("sends it again only once", async () => {
    const page = new FakePage([stalls(200), stalls(30)]);
    await expect(gotoWithCommitResend(page.asPage(), "http://x/", 5000, 20)).rejects.toThrow(
      /Timeout exceeded/,
    );
    expect(page.calls).toHaveLength(2);
  });

  it("does not resend a slow server whose response has not arrived", async () => {
    const page = new FakePage([
      async () => {
        await tick(80);
        throw new Error("page.goto: Timeout exceeded");
      },
    ]);
    await expect(gotoWithCommitResend(page.asPage(), "http://x/", 5000, 20)).rejects.toThrow(
      /Timeout exceeded/,
    );
    expect(page.calls).toHaveLength(1);
  });

  it.each([
    ["a redirect", response(302)],
    ["a 204", response(204)],
    ["a child-frame response", response(200, CHILD)],
    ["a subresource", response(200, MAIN, false)],
  ])("does not start the stall clock on %s", async (_label, res) => {
    const page = new FakePage([
      async (p) => {
        p.emit("response", res);
        await tick(80);
        throw new Error("page.goto: Timeout exceeded");
      },
    ]);
    await expect(gotoWithCommitResend(page.asPage(), "http://x/", 5000, 20)).rejects.toThrow(
      /Timeout exceeded/,
    );
    expect(page.calls).toHaveLength(1);
  });

  it("propagates a fast navigation error without resending", async () => {
    const page = new FakePage([
      async () => {
        await tick(1);
        throw new Error("page.goto: net::ERR_CONNECTION_REFUSED");
      },
    ]);
    await expect(gotoWithCommitResend(page.asPage(), "http://x/", 5000, 20)).rejects.toThrow(
      /ERR_CONNECTION_REFUSED/,
    );
    expect(page.calls).toHaveLength(1);
  });

  it("names the stall window in the warning", () => {
    expect(resentWarning(1500)).toContain("1500ms");
  });
});
