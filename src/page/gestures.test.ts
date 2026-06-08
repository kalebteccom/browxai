import { describe, it, expect, vi } from "vitest";
import {
  drag,
  doubleClick,
  mouseAction,
  mouseWheel,
  targetPoint,
  touchAction,
  gesturePinch,
  gestureSwipe,
  type DragPreflight,
} from "./gestures.js";

function fakeMouse() {
  const log: string[] = [];
  return {
    log,
    mouse: {
      move: vi.fn(async (x: number, y: number, o?: { steps?: number }) => void log.push(`move(${x},${y}${o?.steps ? `,s${o.steps}` : ""})`)),
      down: vi.fn(async () => void log.push("down")),
      up: vi.fn(async () => void log.push("up")),
      dblclick: vi.fn(async (x: number, y: number) => void log.push(`dbl(${x},${y})`)),
    },
  };
}
// page with a locator returning a fixed box (centre 50,30)
function pageWithBox(m: ReturnType<typeof fakeMouse>) {
  return {
    mouse: m.mouse,
    locator: () => ({ first: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 60 }) }) }),
  } as never;
}
// page that also answers point_probe's evaluate with a canned hit stack
function pageWithProbe(m: ReturnType<typeof fakeMouse>, cursors: string[]) {
  return {
    mouse: m.mouse,
    locator: () => ({ first: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 60 }) }) }),
    evaluate: vi.fn(async () => ({
      stack: cursors.map((cursor, i) => ({ tag: "div", cursor, classes: `layer-${i}` })),
      scrollContainer: null,
      clickableAncestor: null,
    })),
  } as never;
}
const refs = {} as never;

describe("targetPoint", () => {
  it("returns coords verbatim for a coords target", async () => {
    const p = await targetPoint(pageWithBox(fakeMouse()), refs, { coords: { x: 7, y: 9 } } as never);
    expect(p).toEqual({ x: 7, y: 9 });
  });
  it("returns the box centre for a ref/selector target", async () => {
    const p = await targetPoint(pageWithBox(fakeMouse()), refs, { selector: "#x" } as never);
    expect(p).toEqual({ x: 50, y: 30 });
  });
});

describe("drag", () => {
  it("presses at from, moves to to over steps, releases — in order", async () => {
    const m = fakeMouse();
    const r = await drag(pageWithBox(m), refs, {
      from: { coords: { x: 10, y: 10 } } as never,
      to: { coords: { x: 200, y: 80 } } as never,
      steps: 5,
    });
    expect(r).toEqual({ ok: true, from: { x: 10, y: 10 }, to: { x: 200, y: 80 }, steps: 5 });
    expect(m.log).toEqual(["move(10,10)", "down", "move(200,80,s5)", "up"]);
  });
  it("clamps steps into [1,100]", async () => {
    const m = fakeMouse();
    const r = await drag(pageWithBox(m), refs, {
      from: { coords: { x: 0, y: 0 } } as never,
      to: { coords: { x: 1, y: 1 } } as never,
      steps: 9999,
    });
    expect("steps" in r && r.steps).toBe(100);
  });
});

describe("drag — preflight", () => {
  it("preflight probes `from` and does NOT move the mouse", async () => {
    const m = fakeMouse();
    const r = (await drag(pageWithProbe(m, ["default", "pointer"]), refs, {
      from: { coords: { x: 30, y: 40 } } as never,
      to: { coords: { x: 0, y: 0 } } as never,
      preflight: true,
    })) as DragPreflight;
    expect(r.preflight.point).toEqual({ x: 30, y: 40 });
    expect(r.preflight.resizeRisk).toBe(false);
    expect(m.log).toEqual([]); // nothing dragged
  });

  it("flags resizeRisk when a press-point layer has a resize cursor", async () => {
    const m = fakeMouse();
    const r = (await drag(pageWithProbe(m, ["ew-resize", "default"]), refs, {
      from: { coords: { x: 5, y: 5 } } as never,
      to: { coords: { x: 0, y: 0 } } as never,
      preflight: true,
    })) as DragPreflight;
    expect(r.preflight.resizeRisk).toBe(true);
    expect(m.log).toEqual([]);
  });
});

describe("doubleClick", () => {
  it("dblclicks at the resolved point", async () => {
    const m = fakeMouse();
    const r = await doubleClick(pageWithBox(m), refs, { coords: { x: 42, y: 24 } } as never);
    expect(r).toEqual({ ok: true, point: { x: 42, y: 24 } });
    expect(m.log).toEqual(["dbl(42,24)"]);
  });
});

describe("mouseWheel", () => {
  function fakeCdp() {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    return {
      calls,
      cdp: {
        send: vi.fn(async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          return {};
        }),
      } as never,
    };
  }

  it("dispatches Input.dispatchMouseEvent at coords with deltas", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await mouseWheel(cdp, { coords: { x: 120, y: 240 }, deltaX: 0, deltaY: -50 });
    expect(r).toEqual({ ok: true, coords: { x: 120, y: 240 }, deltaX: 0, deltaY: -50 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("Input.dispatchMouseEvent");
    expect(calls[0]?.params).toMatchObject({
      type: "mouseWheel",
      x: 120,
      y: 240,
      deltaX: 0,
      deltaY: -50,
    });
  });

  it("defaults missing delta dimension to 0", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await mouseWheel(cdp, { coords: { x: 5, y: 6 }, deltaY: 100 });
    expect(r.deltaX).toBe(0);
    expect(r.deltaY).toBe(100);
    expect(calls[0]?.params).toMatchObject({ deltaX: 0, deltaY: 100 });
  });

  it("rejects when both deltas are zero / unspecified", async () => {
    const { cdp, calls } = fakeCdp();
    await expect(mouseWheel(cdp, { coords: { x: 1, y: 2 } })).rejects.toThrow(/non-zero/);
    await expect(mouseWheel(cdp, { coords: { x: 1, y: 2 }, deltaX: 0, deltaY: 0 })).rejects.toThrow(/non-zero/);
    expect(calls).toEqual([]);
  });
});

describe("mouseAction", () => {
  it("move requires coords", async () => {
    await expect(mouseAction(pageWithBox(fakeMouse()), "move")).rejects.toThrow(/requires coords/);
  });
  it("down with coords moves there first, then presses", async () => {
    const m = fakeMouse();
    await mouseAction(pageWithBox(m), "down", { x: 5, y: 6 });
    expect(m.log).toEqual(["move(5,6)", "down"]);
  });
  it("up without coords just releases at the current position", async () => {
    const m = fakeMouse();
    const r = await mouseAction(pageWithBox(m), "up");
    expect(m.log).toEqual(["up"]);
    expect(r).toEqual({ ok: true, action: "up" });
  });
});

// CDP recorder for touch tests. Every dispatched Input.dispatchTouchEvent
// lands as `{method, params}` in `calls`, so we can assert both event type
// and touchPoints contents (including identifier propagation).
function fakeCdp() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    cdp: {
      send: vi.fn(async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return {};
      }),
    } as never,
  };
}

describe("touchAction", () => {
  it("touch_start dispatches touchStart with default identifier 1", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await touchAction(cdp, "start", { coords: { x: 10, y: 20 } });
    expect(r).toEqual({ ok: true, action: "start", coords: { x: 10, y: 20 }, identifier: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("Input.dispatchTouchEvent");
    expect(calls[0]?.params).toMatchObject({
      type: "touchStart",
      touchPoints: [{ x: 10, y: 20, id: 1 }],
    });
  });

  it("touch_move propagates a custom identifier — multi-finger fan-out", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await touchAction(cdp, "move", { coords: { x: 5, y: 6 }, identifier: 7 });
    expect(r.identifier).toBe(7);
    expect(calls[0]?.params).toMatchObject({
      type: "touchMove",
      touchPoints: [{ x: 5, y: 6, id: 7 }],
    });
  });

  it("touch_end with no coords dispatches an empty touchPoints[] (all fingers up)", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await touchAction(cdp, "end", {});
    expect(r).toEqual({ ok: true, action: "end", identifier: 1 });
    expect(calls[0]?.params).toMatchObject({ type: "touchEnd", touchPoints: [] });
  });

  it("touch_end with coords keeps the identifier on the lifted point", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await touchAction(cdp, "end", { coords: { x: 1, y: 2 }, identifier: 3 });
    expect(r).toEqual({ ok: true, action: "end", coords: { x: 1, y: 2 }, identifier: 3 });
    expect(calls[0]?.params).toMatchObject({
      type: "touchEnd",
      touchPoints: [{ x: 1, y: 2, id: 3 }],
    });
  });

  it("touch_start / touch_move without coords reject", async () => {
    const { cdp } = fakeCdp();
    await expect(touchAction(cdp, "start", {})).rejects.toThrow(/requires coords/);
    await expect(touchAction(cdp, "move", {})).rejects.toThrow(/requires coords/);
  });
});

describe("gesturePinch", () => {
  it("pinch-in (scale<1): two fingers start ±startOffset and converge", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await gesturePinch(cdp, { coords: { x: 100, y: 100 }, scale: 0.5, steps: 4, startOffset: 40 });
    expect(r.ok).toBe(true);
    expect(r.startOffset).toBe(40);
    expect(r.endOffset).toBe(20);
    expect(r.steps).toBe(4);

    // 1 touchStart + 4 touchMove + 1 touchEnd = 6 dispatches
    expect(calls).toHaveLength(6);
    expect(calls[0]?.params).toMatchObject({
      type: "touchStart",
      touchPoints: [
        { x: 60, y: 100, id: 1 },
        { x: 140, y: 100, id: 2 },
      ],
    });
    // final touchMove at t=1 → offset = endOffset (20)
    expect(calls[4]?.params).toMatchObject({
      type: "touchMove",
      touchPoints: [
        { x: 80, y: 100, id: 1 },
        { x: 120, y: 100, id: 2 },
      ],
    });
    expect(calls[5]?.params).toMatchObject({ type: "touchEnd", touchPoints: [] });
  });

  it("pinch-out (scale>1): fingers diverge from startOffset to startOffset × scale", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await gesturePinch(cdp, { coords: { x: 50, y: 50 }, scale: 2, steps: 2, startOffset: 30 });
    expect(r.endOffset).toBe(60);
    // last move: offset 60 → points at (-10, 50) and (110, 50)
    expect(calls.at(-2)?.params).toMatchObject({
      type: "touchMove",
      touchPoints: [
        { x: -10, y: 50, id: 1 },
        { x: 110, y: 50, id: 2 },
      ],
    });
  });

  it("rejects non-positive scale", async () => {
    const { cdp } = fakeCdp();
    await expect(gesturePinch(cdp, { coords: { x: 0, y: 0 }, scale: 0 })).rejects.toThrow(/positive/);
    await expect(gesturePinch(cdp, { coords: { x: 0, y: 0 }, scale: -1 })).rejects.toThrow(/positive/);
  });

  it("clamps steps into [1,100]", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await gesturePinch(cdp, { coords: { x: 0, y: 0 }, scale: 1.5, steps: 9999 });
    expect(r.steps).toBe(100);
    // 1 start + 100 moves + 1 end
    expect(calls).toHaveLength(102);
  });
});

describe("gestureSwipe", () => {
  it("single-touch swipe: touchStart → many touchMove → touchEnd", async () => {
    const { cdp, calls } = fakeCdp();
    const r = await gestureSwipe(cdp, {
      from: { x: 100, y: 200 },
      to: { x: 300, y: 200 },
      durationMs: 0, // skip real waits in the unit test
      steps: 4,
    });
    expect(r).toMatchObject({
      ok: true,
      from: { x: 100, y: 200 },
      to: { x: 300, y: 200 },
      steps: 4,
      durationMs: 0,
    });
    expect(calls[0]?.params).toMatchObject({
      type: "touchStart",
      touchPoints: [{ x: 100, y: 200, id: 1 }],
    });
    // last move lands at `to`
    expect(calls.at(-2)?.params).toMatchObject({
      type: "touchMove",
      touchPoints: [{ x: 300, y: 200, id: 1 }],
    });
    expect(calls.at(-1)?.params).toMatchObject({ type: "touchEnd", touchPoints: [] });
  });

  it("custom durationMs is reflected on the result", async () => {
    const { cdp } = fakeCdp();
    const r = await gestureSwipe(cdp, {
      from: { x: 0, y: 0 },
      to: { x: 10, y: 0 },
      durationMs: 50,
      steps: 1,
    });
    expect(r.durationMs).toBe(50);
  });

  it("uses ease-out curve — intermediate moves are not linear", async () => {
    const { cdp, calls } = fakeCdp();
    await gestureSwipe(cdp, {
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
      durationMs: 0,
      steps: 4,
    });
    // moves are at indices 1..4 (after touchStart). ease-out: 1-(1-t)^2.
    // t=1/4 → 0.4375 → x=43.75; t=2/4 → 0.75 → x=75; linear would give 25/50.
    const move1X = (calls[1]!.params.touchPoints as Array<{ x: number }>)[0]!.x;
    const move2X = (calls[2]!.params.touchPoints as Array<{ x: number }>)[0]!.x;
    expect(move1X).toBeCloseTo(43.75, 2);
    expect(move2X).toBeCloseTo(75, 2);
  });

  it("propagates a custom identifier across the whole gesture", async () => {
    const { cdp, calls } = fakeCdp();
    await gestureSwipe(cdp, {
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      durationMs: 0,
      steps: 2,
      identifier: 9,
    });
    for (const c of calls) {
      const tps = c.params.touchPoints as Array<{ id?: number }>;
      if (tps.length) expect(tps[0]!.id).toBe(9);
    }
  });
});
