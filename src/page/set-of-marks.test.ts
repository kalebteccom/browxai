import { describe, it, expect, vi } from "vitest";
import { screenshotMarks, resolveCandidates, labelFor, type MarkEntry } from "./set-of-marks.js";
import { RefRegistry } from "./refs.js";

/** Fake Playwright Page just rich enough for screenshotMarks: it records the
 *  page.evaluate / page.screenshot calls so we can assert the overlay was
 *  installed + removed, and returns a stub PNG buffer. */
function fakePage(opts: { screenshotBytes?: string; screenshotThrows?: boolean } = {}) {
  const calls: { evaluate: string[]; screenshot: number } = { evaluate: [], screenshot: 0 };
  let overlayCounter = 0;
  const page = {
    calls,
    evaluate: vi.fn(async (script: string) => {
      calls.evaluate.push(script);
      // First call installs the overlay → return an overlay id.
      // Removal calls return true.
      if (script.includes("browxai-set-of-marks-")) {
        overlayCounter++;
        return `browxai-set-of-marks-test-${overlayCounter}`;
      }
      if (script.includes("getElementById")) return true;
      return null;
    }),
    screenshot: vi.fn(async () => {
      calls.screenshot++;
      if (opts.screenshotThrows) throw new Error("screenshot failed");
      return Buffer.from(opts.screenshotBytes ?? "FAKE-PNG-BYTES");
    }),
    locator: vi.fn(() => ({ first: () => ({ boundingBox: async () => null }) })),
    url: () => "about:blank",
  };
  return page;
}

describe("labelFor", () => {
  const entry: MarkEntry = {
    index: 3,
    ref: "e7",
    role: "button",
    name: "Save",
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    painted: true,
  };
  it("default index mode prints the 1-based array position", () => {
    expect(labelFor(entry, "index")).toBe("3");
  });
  it("ref mode prints the existing eN", () => {
    expect(labelFor(entry, "ref")).toBe("e7");
  });
  it("role mode prints the role, falling back to ref when absent", () => {
    expect(labelFor(entry, "role")).toBe("button");
    expect(labelFor({ ...entry, role: undefined }, "role")).toBe("e7");
  });
});

describe("resolveCandidates (full-find-candidate fast path)", () => {
  it("passes through bbox + role/name/testId without hitting the page", async () => {
    const page = fakePage();
    const refs = new RefRegistry();
    const { entries, warnings } = await resolveCandidates(
      { page: page as never, substrate: {} as never, refs, testAttributes: [] },
      [
        { ref: "e1", role: "button", name: "Save", bbox: { x: 10, y: 20, width: 80, height: 24 } },
        { ref: "e2", role: "link", name: "Cancel", bbox: null },
      ],
    );
    expect(entries).toEqual([
      {
        index: 1,
        ref: "e1",
        role: "button",
        name: "Save",
        bbox: { x: 10, y: 20, width: 80, height: 24 },
        painted: true,
      },
      { index: 2, ref: "e2", role: "link", name: "Cancel", bbox: null, painted: false },
    ]);
    expect(warnings).toEqual([]);
    // Fast-path: no page.evaluate / no tree walk.
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});

describe("screenshotMarks (composition)", () => {
  it("paints only candidates with a non-null bbox; mapping is 1-based and complete", async () => {
    const page = fakePage();
    const refs = new RefRegistry();
    const res = await screenshotMarks(page as never, {} as never, refs, {
      candidates: [
        {
          ref: "e7",
          role: "button",
          name: "Save",
          bbox: { x: 100, y: 100, width: 60, height: 24 },
        },
        { ref: "e11", role: "link", name: "Cancel", bbox: null }, // clipped → not painted
        { ref: "e22", role: "tab", name: "Files", bbox: { x: 5, y: 5, width: 40, height: 20 } },
      ],
    });
    expect(res.mimeType).toBe("image/png");
    expect(res.imageBase64).toBe(Buffer.from("FAKE-PNG-BYTES").toString("base64"));
    expect(res.marks.map((m) => [m.index, m.ref, m.painted])).toEqual([
      [1, "e7", true],
      [2, "e11", false],
      [3, "e22", true],
    ]);
    // index↔ref mapping covers every candidate, painted or not.
    expect(res.mapping).toEqual({ "1": "e7", "2": "e11", "3": "e22" });
    // One warning for the skipped candidate.
    expect(res.warnings.some((w) => /1 of 3/.test(w))).toBe(true);
    // Overlay was installed (one evaluate with the box script) + removed
    // (one evaluate for getElementById removal) + one screenshot taken.
    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(page.calls.evaluate).toHaveLength(2);
    expect(page.calls.evaluate[0]).toMatch(/browxai-set-of-marks-/);
    expect(page.calls.evaluate[1]).toMatch(/getElementById/);
  });

  it("default label is the array index, paired with the index→ref mapping", async () => {
    const page = fakePage();
    const refs = new RefRegistry();
    const res = await screenshotMarks(page as never, {} as never, refs, {
      candidates: [
        { ref: "e3", role: "button", bbox: { x: 0, y: 50, width: 10, height: 10 } },
        { ref: "e9", role: "button", bbox: { x: 20, y: 50, width: 10, height: 10 } },
      ],
    });
    // The overlay script for label:"index" should include `"label":"1"` and
    // `"label":"2"` (the 1-based positions), NOT `"e3"`/`"e9"`.
    const overlayCall = page.calls.evaluate[0]!;
    expect(overlayCall).toContain('"label":"1"');
    expect(overlayCall).toContain('"label":"2"');
    expect(overlayCall).not.toContain('"label":"e3"');
    expect(res.mapping).toEqual({ "1": "e3", "2": "e9" });
  });

  it("label:'ref' paints the existing eN — does NOT invent a parallel ID space", async () => {
    const page = fakePage();
    const refs = new RefRegistry();
    const res = await screenshotMarks(page as never, {} as never, refs, {
      label: "ref",
      candidates: [
        { ref: "e3", role: "button", bbox: { x: 0, y: 50, width: 10, height: 10 } },
        { ref: "e9", role: "button", bbox: { x: 20, y: 50, width: 10, height: 10 } },
      ],
    });
    const overlayCall = page.calls.evaluate[0]!;
    expect(overlayCall).toContain('"label":"e3"');
    expect(overlayCall).toContain('"label":"e9"');
    // Mapping invariant holds either way.
    expect(res.mapping).toEqual({ "1": "e3", "2": "e9" });
  });

  it("skips the overlay install when every candidate is unpaintable", async () => {
    const page = fakePage();
    const refs = new RefRegistry();
    const res = await screenshotMarks(page as never, {} as never, refs, {
      candidates: [{ ref: "e3", role: "button", bbox: null }],
    });
    // No evaluate at all — nothing to paint.
    expect(page.evaluate).not.toHaveBeenCalled();
    // Bare screenshot still taken so the caller gets a viewport reference.
    expect(page.screenshot).toHaveBeenCalledTimes(1);
    expect(res.marks).toEqual([
      { index: 1, ref: "e3", role: "button", bbox: null, painted: false },
    ]);
    expect(res.warnings.some((w) => /1 of 1/.test(w))).toBe(true);
  });

  it("removes the overlay even when screenshot throws", async () => {
    const page = fakePage({ screenshotThrows: true });
    const refs = new RefRegistry();
    await expect(
      screenshotMarks(page as never, {} as never, refs, {
        candidates: [{ ref: "e3", role: "button", bbox: { x: 0, y: 50, width: 10, height: 10 } }],
      }),
    ).rejects.toThrow(/screenshot failed/);
    // Overlay was installed (1st evaluate) AND removed (2nd evaluate)
    // despite the screenshot failure — finally-block invariant.
    expect(page.calls.evaluate).toHaveLength(2);
    expect(page.calls.evaluate[1]).toMatch(/getElementById/);
  });
});
