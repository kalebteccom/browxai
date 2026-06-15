import { describe, it, expect } from "vitest";
import {
  PlaywrightCaptureSubstrate,
  SafariCaptureSubstrate,
  type CaptureSubstrate,
} from "./capture-substrate.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";

// The CaptureSubstrate port routing/gating. PlaywrightCaptureSubstrate is the
// existing `page.screenshot` / `locator.screenshot` logic verbatim (covered by the
// per-engine keystones); these cover the Safari adapter's full-document PNG path +
// the in-adapter gating that replaced the per-handler `if (safariShotHandle)`
// branch.

function safariHandle(): { handle: SafariSessionHandle; shots: string[] } {
  const shots: string[] = [];
  const handle = {
    sessionId: "S",
    webDriver: {
      screenshot: async (sessionId: string) => {
        shots.push(sessionId);
        return "UE5HQg=="; // stand-in base64 PNG payload
      },
    },
  } as unknown as SafariSessionHandle;
  return { handle, shots };
}

describe("SafariCaptureSubstrate", () => {
  it("tags the safari engine", () => {
    const { handle } = safariHandle();
    expect(new SafariCaptureSubstrate(handle).engine).toBe("safari");
  });

  it("returns the full-document PNG from the WebDriver client", async () => {
    const { handle, shots } = safariHandle();
    const sub = new SafariCaptureSubstrate(handle);
    const r = await sub.screenshot({ format: "png", fullPage: false, describe: false });
    expect(r.kind).toBe("image");
    if (r.kind !== "image") throw new Error("expected image");
    expect(r.mimeType).toBe("image/png");
    expect(r.data).toBe("UE5HQg==");
    expect(shots).toEqual(["S"]);
  });

  it("ignores inert PNG-only args (fullPage/describe) — no Page to honour them", async () => {
    const { handle } = safariHandle();
    const sub = new SafariCaptureSubstrate(handle);
    const r = await sub.screenshot({ format: "png", fullPage: true, describe: true });
    expect(r.kind).toBe("image");
    if (r.kind !== "image") throw new Error("expected image");
    expect(r.mimeType).toBe("image/png");
    // No `describe` caption + no page-text source — Safari has no Playwright Page.
    expect(r.caption).toBeUndefined();
    expect(r.pageText).toBeUndefined();
  });

  it("refuses element-scoped + path captures cleanly (in the adapter, not the handler)", async () => {
    const { handle } = safariHandle();
    const sub: CaptureSubstrate = new SafariCaptureSubstrate(handle);
    for (const req of [
      {
        format: "png" as const,
        fullPage: false,
        describe: false,
        resolveTarget: () => ({ ref: "e1" }),
      },
      {
        format: "png" as const,
        fullPage: false,
        describe: false,
        resolveTarget: () => ({ selector: "#x" }),
      },
      { format: "png" as const, fullPage: false, describe: false, path: "shot.png" },
    ]) {
      const r = await sub.screenshot(req);
      expect(r.kind).toBe("refusal");
      if (r.kind !== "refusal") throw new Error("expected refusal");
      expect(r.error).toMatch(/Safari engine supports only the default inline PNG/);
    }
  });

  it("refuses a MALFORMED target without invoking the resolver (no preempting throw)", async () => {
    // A multi-target / unbound-`named` request would throw out of `asTarget`. The
    // Safari adapter must refuse on the raw element-scoped signal first — never
    // call the resolver — so the engine refusal preempts the throw, not the other
    // way round (the pre-seam Safari branch never reached `asTarget`).
    const { handle } = safariHandle();
    const sub: CaptureSubstrate = new SafariCaptureSubstrate(handle);
    let called = false;
    const r = await sub.screenshot({
      format: "png",
      fullPage: false,
      describe: false,
      resolveTarget: () => {
        called = true;
        throw new Error("asTarget should not run");
      },
    });
    expect(called).toBe(false);
    expect(r.kind).toBe("refusal");
    if (r.kind !== "refusal") throw new Error("expected refusal");
    expect(r.error).toMatch(/Safari engine supports only the default inline PNG/);
  });
});

describe("PlaywrightCaptureSubstrate", () => {
  function playwrightSubstrate(): CaptureSubstrate {
    const page = (() => ({ url: () => "about:blank" })) as unknown as () => Page;
    const deps = {
      describeTarget: async () => "",
      save: () => ({}) as never,
    };
    return new PlaywrightCaptureSubstrate(page, {} as RefRegistry, deps);
  }

  it("refuses fullPage+target before invoking the resolver (no preempting throw)", async () => {
    // A malformed target would throw out of `asTarget`; the `fullPage:true` +
    // element-scoped refusal must fire first and never call the resolver — the
    // byte-identical pre-seam ordering returned this refusal before `asTarget`.
    const sub = playwrightSubstrate();
    let called = false;
    const r = await sub.screenshot({
      format: "png",
      fullPage: true,
      describe: false,
      resolveTarget: () => {
        called = true;
        throw new Error("asTarget should not run");
      },
    });
    expect(called).toBe(false);
    expect(r.kind).toBe("refusal");
    if (r.kind !== "refusal") throw new Error("expected refusal");
    expect(r.error).toMatch(/fullPage:true` is mutually exclusive/);
  });
});
