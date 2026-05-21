import { describe, it, expect } from "vitest";
import { WedgeTracker, WEDGE_THRESHOLD } from "./wedge.js";

describe("WedgeTracker", () => {
  it("starts un-wedged with a zero count", () => {
    const w = new WedgeTracker();
    expect(w.count).toBe(0);
    expect(w.wedged()).toBe(false);
  });

  it("becomes wedged only after WEDGE_THRESHOLD consecutive timeouts", () => {
    const w = new WedgeTracker();
    for (let i = 1; i < WEDGE_THRESHOLD; i++) {
      w.recordTimeout();
      expect(w.wedged(), `after ${i} timeout(s)`).toBe(false);
    }
    w.recordTimeout();
    expect(w.count).toBe(WEDGE_THRESHOLD);
    expect(w.wedged()).toBe(true);
  });

  it("a responsive call clears the streak", () => {
    const w = new WedgeTracker();
    w.recordTimeout();
    w.recordTimeout();
    w.recordResponsive();
    expect(w.count).toBe(0);
    expect(w.wedged()).toBe(false);
  });

  it("an interrupting responsive call prevents a wedge verdict", () => {
    const w = new WedgeTracker();
    w.recordTimeout();
    w.recordTimeout();
    w.recordResponsive(); // session answered — not wedged
    w.recordTimeout();
    expect(w.wedged()).toBe(false);
  });

  it("the hint names the discard-and-reopen recovery", () => {
    const w = new WedgeTracker();
    for (let i = 0; i < WEDGE_THRESHOLD; i++) w.recordTimeout();
    const hint = w.hint();
    expect(hint).toMatch(/close_session/);
    expect(hint).toMatch(/open_session/);
    expect(hint).toMatch(/wedged/i);
  });
});
