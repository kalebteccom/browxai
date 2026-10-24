// Canvas primitives — unit tests. The page-side capture / discovery
// functions exercise via stubbed Playwright `page.evaluate`; the pure
// pieces (`diffRgba`, `applyScreenToWorld`, `validateGestureChain`) test directly.

import { describe, it, expect } from "vitest";
import {
  GESTURE_CHAIN_MAX_STEPS,
  GESTURE_CHAIN_MAX_WAIT_MS,
  GESTURE_CHAIN_MIN_MOVE_MS,
  applyScreenToWorld,
  canvasCapture,
  canvasDiff,
  canvasScreenToWorld,
  canvasWorldToScreen,
  diffRgba,
  runGestureChain,
  validateGestureChain,
  type CanvasDiscoverPage,
  type CanvasCapturePage,
  type GestureChainPage,
} from "./canvas.js";

// Tiny RGBA buffer factory: build a w*h*4 Uint8Array from a fill colour,
// then optionally splat a second colour over a sub-rect.
function rgba(
  w: number,
  h: number,
  fill: [number, number, number, number],
  splat?: { x: number; y: number; w: number; h: number; colour: [number, number, number, number] },
): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = fill[0];
    buf[i * 4 + 1] = fill[1];
    buf[i * 4 + 2] = fill[2];
    buf[i * 4 + 3] = fill[3];
  }
  if (splat) {
    for (let y = splat.y; y < splat.y + splat.h; y++) {
      for (let x = splat.x; x < splat.x + splat.w; x++) {
        const idx = (y * w + x) * 4;
        buf[idx] = splat.colour[0];
        buf[idx + 1] = splat.colour[1];
        buf[idx + 2] = splat.colour[2];
        buf[idx + 3] = splat.colour[3];
      }
    }
  }
  return buf;
}

describe("diffRgba (synthetic pixel math)", () => {
  it("reports zero changes on identical buffers", () => {
    const a = rgba(4, 4, [10, 20, 30, 255]);
    const b = rgba(4, 4, [10, 20, 30, 255]);
    const r = diffRgba(a, b, 4, 4);
    expect(r.ok).toBe(true);
    expect(r.changedPixelCount).toBe(0);
    expect(r.changedBytes).toBe(0);
    expect(r.percentageChanged).toBe(0);
    expect(r.bboxOfChanges).toBeNull();
  });

  it("counts exactly the splatted pixels and tight-bbox them", () => {
    const a = rgba(8, 8, [0, 0, 0, 255]);
    const b = rgba(8, 8, [0, 0, 0, 255], {
      x: 2,
      y: 3,
      w: 3,
      h: 2,
      colour: [255, 0, 0, 255],
    });
    const r = diffRgba(a, b, 8, 8);
    expect(r.changedPixelCount).toBe(6); // 3x2 = 6
    expect(r.changedBytes).toBe(6 * 255);
    expect(r.bboxOfChanges).toEqual({ x: 2, y: 3, w: 3, h: 2 });
    expect(r.percentageChanged).toBeCloseTo(6 / 64);
  });

  it("clamps an over-flow region to the image bounds", () => {
    const a = rgba(4, 4, [0, 0, 0, 255]);
    const b = rgba(4, 4, [255, 255, 255, 255]);
    const r = diffRgba(a, b, 4, 4, { x: 2, y: 2, w: 10, h: 10 });
    expect(r.changedPixelCount).toBe(4); // clamped to 2x2 sub-rect
    expect(r.bboxOfChanges).toEqual({ x: 2, y: 2, w: 2, h: 2 });
  });

  it("refuses on length mismatch", () => {
    const a = rgba(4, 4, [0, 0, 0, 255]);
    const b = rgba(4, 5, [0, 0, 0, 255]);
    const r = diffRgba(a, b, 4, 4);
    expect(r.ok).toBe(false);
  });
});

describe("canvasDiff (envelope around diffRgba)", () => {
  it("handles base64 inputs end-to-end", () => {
    const a = rgba(2, 2, [0, 0, 0, 255]);
    const b = rgba(2, 2, [0, 0, 0, 255], { x: 0, y: 0, w: 1, h: 1, colour: [1, 2, 3, 255] });
    const r = canvasDiff({
      beforeBase64: Buffer.from(a).toString("base64"),
      afterBase64: Buffer.from(b).toString("base64"),
      width: 2,
      height: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.changedPixelCount).toBe(1);
    expect(r.bboxOfChanges).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("rejects RGBA inputs without width/height", () => {
    const r = canvasDiff({
      beforeBase64: "",
      afterBase64: "",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("missing-dimensions");
  });

  it.each([
    {
      name: "PNG inputs: byte-equal compare + warning",
      before: "iVBORw0",
      after: "iVBORw0",
      changed: false,
      warn: /PNG-decoded/,
    },
    {
      name: "PNG inputs different bytes: surfaces a non-zero change + warning",
      before: "aaaa",
      after: "bbbb",
      changed: true,
      warn: /PNG/,
    },
  ])("canvasDiff: $name", ({ before, after, changed, warn }) => {
    const r = canvasDiff({ beforeBase64: before, afterBase64: after, inputFormat: "png" });
    if (changed) {
      expect(r.changedPixelCount).toBeGreaterThan(0);
      expect(r.bboxOfChanges).toBeNull();
    } else {
      expect(r.ok).toBe(true);
      expect(r.changedPixelCount).toBe(0);
    }
    expect(r.warnings.some((w) => warn.test(w))).toBe(true);
  });
});

describe("applyWorldToScreen + applyScreenToWorld (explicit-mode math)", () => {
  it("inverse returns NaN on scale=0 rather than throwing", () => {
    const r = applyScreenToWorld({ x: 1, y: 1 }, { scale: 0, panX: 0, panY: 0 });
    expect(Number.isNaN(r.x)).toBe(true);
  });
});

describe("validateGestureChain (caps, floors, refusals)", () => {
  it.each([
    { name: "an empty step list", steps: [], code: "no-steps" },
    {
      name: "more than MAX steps",
      steps: Array.from({ length: GESTURE_CHAIN_MAX_STEPS + 1 }, () => ({
        kind: "move" as const,
        x: 0,
        y: 0,
      })),
      code: "too-many-steps",
    },
    {
      name: "a wheel step with zero delta",
      steps: [{ kind: "wheel" as const, deltaX: 0, deltaY: 0 }],
      code: "bad-step",
    },
    { name: "move/down/up without coords", steps: [{ kind: "down" as const }], code: undefined },
    {
      name: "an unknown kind",
      steps: [{ kind: "teleport" as unknown as "down" }],
      code: undefined,
    },
  ])("validateGestureChain rejects $name", ({ steps, code }) => {
    const r = validateGestureChain(steps);
    expect(r.ok).toBe(false);
    if (code) expect(r.code).toBe(code);
  });

  it.each([
    {
      name: "floors a too-fast move ms with a warning",
      steps: [{ kind: "move" as const, x: 1, y: 1, ms: 1 }],
      ms: GESTURE_CHAIN_MIN_MOVE_MS,
      warn: /floored/,
    },
    {
      name: "clamps a too-long wait ms with a warning",
      steps: [{ kind: "wait" as const, ms: 10_000 }],
      ms: GESTURE_CHAIN_MAX_WAIT_MS,
      warn: /clamped/,
    },
  ])("validateGestureChain: $name", ({ steps, ms, warn }) => {
    const r = validateGestureChain(steps);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.ms).toBe(ms);
    expect(r.warnings.some((w) => warn.test(w))).toBe(true);
  });
});

describe("runGestureChain (executes against a stubbed mouse)", () => {
  function makeStubPage(): {
    page: GestureChainPage;
    log: string[];
  } {
    const log: string[] = [];
    return {
      page: {
        mouse: {
          down: async () => {
            log.push("down");
          },
          up: async () => {
            log.push("up");
          },
          move: async (x, y) => {
            log.push(`move:${x},${y}`);
          },
          wheel: async (dx, dy) => {
            log.push(`wheel:${dx},${dy}`);
          },
        },
      },
      log,
    };
  }

  it.each([
    {
      name: "dispatches a 3-step program in order",
      steps: [
        { kind: "down" as const, x: 10, y: 20 },
        { kind: "move" as const, x: 30, y: 40, ms: 10 },
        { kind: "up" as const, x: 30, y: 40 },
      ],
      executed: 3,
      // move-before-down, the explicit move, then move-before-up.
      want: ["move:10,20", "down", "move:30,40", "move:30,40", "up"],
    },
    {
      name: "dispatches a wheel step",
      steps: [{ kind: "wheel" as const, deltaX: 0, deltaY: 100, x: 5, y: 6 }],
      executed: 1,
      want: ["move:5,6", "wheel:0,100"],
    },
  ])("runGestureChain: $name", async ({ steps, executed, want }) => {
    const { page, log } = makeStubPage();
    const r = await runGestureChain(page, { steps });
    expect(r.ok).toBe(true);
    expect(r.stepsExecuted).toBe(executed);
    expect(log).toEqual(want);
  });
});

describe("canvasCapture (stubbed page.evaluate)", () => {
  function makePage(payload: unknown): CanvasCapturePage {
    return {
      evaluate: async <T, _Arg>() => payload as T,
    };
  }

  it("returns the rgba envelope with isWebGL on webgl-framebuffer", async () => {
    const stub = {
      ok: true,
      format: "webgl-framebuffer",
      contentBase64: "CCCC",
      width: 4,
      height: 4,
      channelCount: 4,
      isWebGL: true,
    };
    const r = await canvasCapture(makePage(stub), { format: "webgl-framebuffer" });
    expect(r.ok).toBe(true);
    if (r.ok && r.format === "webgl-framebuffer") {
      expect(r.isWebGL).toBe(true);
    }
  });

  it("surfaces the structured failure from the page", async () => {
    const stub = { ok: false, error: "no canvas", code: "no-canvas" };
    const r = await canvasCapture(makePage(stub), { format: "png" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("no-canvas");
      expect(r.error).toContain("no canvas");
    }
  });
});

describe("canvasWorldToScreen / canvasScreenToWorld (modes)", () => {
  function pageDiscovering(payload: unknown): CanvasDiscoverPage {
    return {
      evaluate: async <T, _Arg>() => payload as T,
    };
  }

  it("explicit mode never hits the page", async () => {
    let called = false;
    const page = {
      evaluate: async <T, _Arg>() => {
        called = true;
        return {} as unknown as T;
      },
    } as CanvasDiscoverPage;
    const r = await canvasWorldToScreen(page, {
      worldX: 5,
      worldY: 7,
      transform: { scale: 2, panX: 10, panY: 20 },
    });
    expect(called).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.screenX).toBe(30);
    expect(r.screenY).toBe(54);
    // No adapterHint surfaces in explicit mode.
    expect(r.adapterHint).toBeUndefined();
  });

  it("discovery success surfaces transform + adapter hint + heuristic warning", async () => {
    const page = pageDiscovering({
      ok: true,
      transform: { scale: 1, panX: 0, panY: 0 },
      adapterHint: "figma",
    });
    const r = await canvasWorldToScreen(page, { worldX: 1, worldY: 2 });
    expect(r.ok).toBe(true);
    expect(r.transformDiscovered).toEqual({ scale: 1, panX: 0, panY: 0 });
    expect(r.adapterHint).toBe("figma");
    expect(r.warnings && r.warnings[0]).toMatch(/HEURISTIC/);
  });

  it("discovery failure returns the documented no-transform error", async () => {
    const page = pageDiscovering({ ok: false });
    const r = await canvasWorldToScreen(page, { worldX: 0, worldY: 0 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no-transform");
    expect(r.error).toMatch(/pass `transform` explicitly OR use a canvas-app adapter plugin/);
  });

  it("inverse keystone — explicit-mode round trip via the two MCP-shape handlers", async () => {
    const page = pageDiscovering({ ok: false });
    const t = { scale: 1.5, panX: 12.3, panY: -4.7, originX: 50, originY: 60 };
    const fwd = await canvasWorldToScreen(page, { worldX: 11, worldY: 22, transform: t });
    expect(fwd.ok).toBe(true);
    const inv = await canvasScreenToWorld(page, {
      screenX: fwd.screenX!,
      screenY: fwd.screenY!,
      transform: t,
    });
    expect(inv.ok).toBe(true);
    expect(inv.worldX).toBeCloseTo(11);
    expect(inv.worldY).toBeCloseTo(22);
  });
});
