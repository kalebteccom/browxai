import { describe, it, expect, vi } from "vitest";
import { drag, doubleClick, mouseAction, targetPoint, type DragPreflight } from "./gestures.js";

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
