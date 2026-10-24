import { describe, it, expect } from "vitest";
import { WedgeTracker, WEDGE_THRESHOLD } from "./wedge.js";

describe("WedgeTracker", () => {
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
});
