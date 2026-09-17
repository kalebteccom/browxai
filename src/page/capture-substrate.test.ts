import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

/** A real temp dir, because `pdfSave` resolves and `mkdirSync`s under it. */
const WS = mkdtempSync(join(tmpdir(), "browxai-capture-port-"));
afterAll(() => rmSync(WS, { recursive: true, force: true }));

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
    // The element port is never reached on this path: the refusal fires before
    // any target resolution, which is the property the case asserts.
    return new PlaywrightCaptureSubstrate(page, {} as RefRegistry, {} as never, deps);
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

// ---------------------------------------------------------------------------
// The pdf + video widening (RFC 0009 P3). `pdf_save` held a `requirePage` to
// hand a `Page` to `pdfSave`, and the teardown path held one to hand a `Page` to
// `finalizeVideoOnClose`; both are the port's now.

/** A `Page` stand-in that records the two calls these members make. */
function recordingPage(opts: { video?: { saveAs: (p: string) => Promise<void> } | null } = {}): {
  page: () => Page;
  pdfCalls: Array<Record<string, unknown>>;
  videoLookups: number;
} {
  const pdfCalls: Array<Record<string, unknown>> = [];
  const state = { videoLookups: 0 };
  const page = {
    url: () => "about:blank",
    pdf: async (args: Record<string, unknown>) => {
      pdfCalls.push(args);
    },
    video: () => {
      state.videoLookups += 1;
      return opts.video === undefined ? { saveAs: async () => {} } : opts.video;
    },
  } as unknown as Page;
  return {
    page: () => page,
    pdfCalls,
    get videoLookups() {
      return state.videoLookups;
    },
  };
}

function captureOver(page: () => Page): CaptureSubstrate {
  return new PlaywrightCaptureSubstrate(page, {} as RefRegistry, {} as never, {
    describeTarget: async () => "",
    save: () => ({}) as never,
  });
}

describe("PlaywrightCaptureSubstrate.pdf", () => {
  it("writes through the existing pdfSave and returns its envelope verbatim", async () => {
    const rec = recordingPage();
    const r = await captureOver(rec.page).pdf({
      workspaceRoot: WS,
      sessionId: "s1",
      path: "out/report.pdf",
      format: "Letter",
      scale: 1.5,
      printBackground: true,
    });
    expect(r.kind).toBe("saved");
    if (r.kind !== "saved") throw new Error("expected saved");
    expect(r.result.format).toBe("Letter");
    expect(r.result.scale).toBe(1.5);
    expect(r.result.printBackground).toBe(true);
    expect(r.result.path).toContain("report.pdf");
    // The adapter passes the RESOLVED absolute path to Playwright, which is what
    // keeps the write workspace-rooted by construction.
    expect(rec.pdfCalls).toHaveLength(1);
    expect(String(rec.pdfCalls[0]!.path)).toContain(WS);
  });

  it("still THROWS on a workspace escape, so the handler's catch renders it", async () => {
    // `pdf_save`'s handler renders a throw as `{ok:false, error}`. Converting the
    // escape into a structured `PdfRefused` here would change that envelope, so
    // the adapter deliberately lets `resolveWorkspacePath` throw through.
    const rec = recordingPage();
    await expect(
      captureOver(rec.page).pdf({
        workspaceRoot: WS,
        sessionId: "s1",
        path: "../../etc/escape.pdf",
      }),
    ).rejects.toThrow(/workspace/i);
    expect(rec.pdfCalls).toHaveLength(0);
  });

  it("rejects rather than throwing synchronously when the page accessor is dead", async () => {
    const sub = captureOver(() => {
      throw new Error("attach-target-gone");
    });
    let promise: unknown;
    expect(() => {
      promise = sub.pdf({ workspaceRoot: WS, sessionId: "s1" });
    }).not.toThrow();
    await expect(promise).rejects.toThrow("attach-target-gone");
  });
});

describe("PlaywrightCaptureSubstrate.prepareVideoSave", () => {
  const recording = (targetPath?: string) => ({
    active: true,
    finalized: false,
    pendingFinalize: false,
    ...(targetPath ? { targetPath } : {}),
  });

  it("takes the handle before teardown and resolves the Video only in the flush", async () => {
    // The ordering the teardown path has always had: `page.video()` must run
    // AFTER `context.close()` has flushed the .webm. Splitting the member into
    // "resolve the page now, return a thunk" is what preserves it.
    const rec = recordingPage();
    const state = recording("/tmp/out.webm");
    const flush = await captureOver(rec.page).prepareVideoSave(state);
    expect(flush, "an active recording must yield a flush").toBeTruthy();
    expect(rec.videoLookups, "page.video() must not run before teardown").toBe(0);
    await flush!();
    expect(rec.videoLookups).toBe(1);
    expect(state.finalized).toBe(true);
  });

  it("answers null when nothing is recording, and when no target path was reserved", async () => {
    const rec = recordingPage();
    expect(await captureOver(rec.page).prepareVideoSave(recording())).toBeNull();
    expect(
      await captureOver(rec.page).prepareVideoSave({
        active: false,
        finalized: false,
        pendingFinalize: false,
        targetPath: "/tmp/out.webm",
      }),
    ).toBeNull();
  });

  it("leaves `finalized` false when the recorder reports no video", async () => {
    const rec = recordingPage({ video: null });
    const state = recording("/tmp/out.webm");
    const flush = await captureOver(rec.page).prepareVideoSave(state);
    await flush!();
    expect(state.finalized).toBe(false);
  });

  it("reaches the page accessor FIRST, so a dead target rejects", async () => {
    // Inspecting the state first would answer `null` on a gone session — "nothing
    // to save" for a question that was never asked. The `substrate-adapter-async`
    // drive depends on this ordering too: it calls every member with a placeholder
    // argument and requires a rejection.
    const sub = captureOver(() => {
      throw new Error("attach-target-gone");
    });
    await expect(sub.prepareVideoSave(recording())).rejects.toThrow("attach-target-gone");
  });
});

describe("SafariCaptureSubstrate — pdf and video", () => {
  it("refuses pdf with a structured error naming the alternative", async () => {
    const { handle } = safariHandle();
    const r = await new SafariCaptureSubstrate(handle).pdf();
    expect(r.kind).toBe("refusal");
    if (r.kind !== "refusal") throw new Error("expected refusal");
    expect(r.error).toMatch(/not supported on the safari engine/);
    expect(r.hint).toMatch(/chromium/);
  });

  it("has no video to flush", async () => {
    const { handle } = safariHandle();
    expect(await new SafariCaptureSubstrate(handle).prepareVideoSave()).toBeNull();
  });
});
