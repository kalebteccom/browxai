// Canvas primitives — unit tests. The page-side capture / discovery
// functions exercise via stubbed Playwright `page.evaluate`; the pure
// pieces (`diffRgba`, `applyWorldToScreen`, `applyScreenToWorld`,
// `validateGestureChain`, `noAdapterError`) test directly.

import { describe, it, expect } from "vitest";
import {
  CANVAS_MAX_DIMENSION,
  GESTURE_CHAIN_MAX_STEPS,
  GESTURE_CHAIN_MAX_WAIT_MS,
  GESTURE_CHAIN_MIN_MOVE_MS,
  applyScreenToWorld,
  applyWorldToScreen,
  canvasCapture,
  canvasDiff,
  canvasScreenToWorld,
  canvasWorldToScreen,
  diffRgba,
  noAdapterError,
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

  it("scopes the diff to the supplied region", () => {
    const a = rgba(8, 8, [0, 0, 0, 255]);
    const b = rgba(8, 8, [0, 0, 0, 255], {
      x: 0,
      y: 0,
      w: 4,
      h: 4,
      colour: [255, 255, 255, 255],
    });
    // Only diff the lower-right quadrant (where nothing changed).
    const r = diffRgba(a, b, 8, 8, { x: 4, y: 4, w: 4, h: 4 });
    expect(r.changedPixelCount).toBe(0);
    expect(r.bboxOfChanges).toBeNull();
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

  it("PNG inputs: byte-equal compare + warning", () => {
    const r = canvasDiff({
      beforeBase64: "iVBORw0",
      afterBase64: "iVBORw0",
      inputFormat: "png",
    });
    expect(r.ok).toBe(true);
    expect(r.changedPixelCount).toBe(0);
    expect(r.warnings.some((w) => /PNG-decoded/.test(w))).toBe(true);
  });

  it("PNG inputs different bytes: surfaces a non-zero change + warning", () => {
    const r = canvasDiff({
      beforeBase64: "aaaa",
      afterBase64: "bbbb",
      inputFormat: "png",
    });
    expect(r.changedPixelCount).toBeGreaterThan(0);
    expect(r.bboxOfChanges).toBeNull();
    expect(r.warnings.some((w) => /PNG/.test(w))).toBe(true);
  });
});

describe("applyWorldToScreen + applyScreenToWorld (explicit-mode math)", () => {
  it("forward maps world → screen with scale + pan", () => {
    const t = { scale: 2, panX: 10, panY: 20 };
    expect(applyWorldToScreen({ x: 5, y: 7 }, t)).toEqual({ x: 30, y: 54 });
  });

  it("origin offset is added after scale/pan", () => {
    const t = { scale: 1, panX: 0, panY: 0, originX: 100, originY: 200 };
    expect(applyWorldToScreen({ x: 5, y: 7 }, t)).toEqual({ x: 105, y: 207 });
  });

  it("round-trips through inverse to within fp precision", () => {
    const t = { scale: 1.5, panX: 12.3, panY: -4.7, originX: 50, originY: 60 };
    const world = { x: 11, y: 22 };
    const screen = applyWorldToScreen(world, t);
    const back = applyScreenToWorld(screen, t);
    expect(back.x).toBeCloseTo(world.x);
    expect(back.y).toBeCloseTo(world.y);
  });

  it("inverse returns NaN on scale=0 rather than throwing", () => {
    const r = applyScreenToWorld({ x: 1, y: 1 }, { scale: 0, panX: 0, panY: 0 });
    expect(Number.isNaN(r.x)).toBe(true);
  });
});

describe("validateGestureChain (caps, floors, refusals)", () => {
  it("rejects an empty step list", () => {
    const r = validateGestureChain([]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no-steps");
  });

  it("rejects more than MAX steps", () => {
    const steps = Array.from({ length: GESTURE_CHAIN_MAX_STEPS + 1 }, () => ({
      kind: "move" as const,
      x: 0,
      y: 0,
    }));
    const r = validateGestureChain(steps);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("too-many-steps");
  });

  it("floors a too-fast move ms with a warning", () => {
    const r = validateGestureChain([{ kind: "move", x: 1, y: 1, ms: 1 }]);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.ms).toBe(GESTURE_CHAIN_MIN_MOVE_MS);
    expect(r.warnings.some((w) => /floored/.test(w))).toBe(true);
  });

  it("clamps a too-long wait ms with a warning", () => {
    const r = validateGestureChain([{ kind: "wait", ms: 10_000 }]);
    expect(r.ok).toBe(true);
    expect(r.steps[0]!.ms).toBe(GESTURE_CHAIN_MAX_WAIT_MS);
    expect(r.warnings.some((w) => /clamped/.test(w))).toBe(true);
  });

  it("rejects a wheel step with zero delta", () => {
    const r = validateGestureChain([{ kind: "wheel", deltaX: 0, deltaY: 0 }]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("bad-step");
  });

  it("rejects move/down/up without coords", () => {
    const r = validateGestureChain([{ kind: "down" }]);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown kind", () => {
    const r = validateGestureChain([{ kind: "teleport" as unknown as "down" }]);
    expect(r.ok).toBe(false);
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

  it("dispatches a 3-step program in order", async () => {
    const { page, log } = makeStubPage();
    const r = await runGestureChain(page, {
      steps: [
        { kind: "down", x: 10, y: 20 },
        { kind: "move", x: 30, y: 40, ms: 10 },
        { kind: "up", x: 30, y: 40 },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.stepsExecuted).toBe(3);
    // move-before-down, the explicit move, then move-before-up.
    expect(log).toEqual(["move:10,20", "down", "move:30,40", "move:30,40", "up"]);
  });

  it("propagates validation failure without executing any steps", async () => {
    const { page, log } = makeStubPage();
    const r = await runGestureChain(page, { steps: [] });
    expect(r.ok).toBe(false);
    expect(r.stepsExecuted).toBe(0);
    expect(log).toEqual([]);
  });

  it("dispatches a wheel step", async () => {
    const { page, log } = makeStubPage();
    const r = await runGestureChain(page, {
      steps: [{ kind: "wheel", deltaX: 0, deltaY: 100, x: 5, y: 6 }],
    });
    expect(r.ok).toBe(true);
    expect(log).toEqual(["move:5,6", "wheel:0,100"]);
  });
});

describe("canvasCapture (stubbed page.evaluate)", () => {
  function makePage(payload: unknown): CanvasCapturePage {
    return {
      evaluate: async <T, _Arg>() => payload as T,
    };
  }

  it("returns the png envelope on success", async () => {
    const stub = {
      ok: true,
      format: "png",
      contentBase64: "AAAA",
      byteLength: 3,
      width: 100,
      height: 80,
    };
    const r = await canvasCapture(makePage(stub), { format: "png" });
    expect(r.ok).toBe(true);
    if (r.ok && r.format === "png") {
      expect(r.contentBase64).toBe("AAAA");
      expect(r.width).toBe(100);
      expect(r.byteLength).toBe(3);
    }
  });

  it("returns the rgba envelope on 2d-imagedata", async () => {
    const stub = {
      ok: true,
      format: "2d-imagedata",
      contentBase64: "BBBB",
      width: 2,
      height: 2,
      channelCount: 4,
    };
    const r = await canvasCapture(makePage(stub), { format: "2d-imagedata" });
    expect(r.ok).toBe(true);
    if (r.ok && r.format === "2d-imagedata") {
      expect(r.channelCount).toBe(4);
      expect(r.contentBase64).toBe("BBBB");
    }
  });

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

  it("exposes the documented max-dimension cap", () => {
    expect(CANVAS_MAX_DIMENSION).toBe(16384);
  });
});

describe("canvasWorldToScreen / canvasScreenToWorld (modes)", () => {
  function pageDiscovering(payload: unknown): CanvasDiscoverPage {
    return {
      evaluate: async <T, _Arg>() => payload as T,
    } as CanvasDiscoverPage;
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

describe("noAdapterError (structured no-adapter shape)", () => {
  it("matches the documented shape", () => {
    const r = noAdapterError("figma", "moveNode");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("no-adapter");
    expect(r.requestedAdapter).toBe("figma");
    expect(r.requestedOp).toBe("moveNode");
    expect(r.error).toContain("@kalebtec/browxai-plugin-figma");
  });
});
