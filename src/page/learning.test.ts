import { describe, it, expect } from "vitest";
import { FeedbackMemory } from "./learning.js";

describe("FeedbackMemory (Phase-2 learned ranking)", () => {
  it("boosts a candidate matching a prior winner's testId", () => {
    const fb = new FeedbackMemory();
    fb.record("the play button", {
      testId: "play-recap",
      testIdAttr: "data-testid",
      role: "button",
    });
    const bonus = fb.bonusFor("play this", {
      testId: "play-recap",
      testIdAttr: "data-testid",
      role: "button",
    });
    expect(bonus).toBeGreaterThan(0);
  });

  it("doesn't boost an unrelated candidate", () => {
    const fb = new FeedbackMemory();
    fb.record("the play button", {
      testId: "play-recap",
      testIdAttr: "data-testid",
      role: "button",
    });
    const bonus = fb.bonusFor("save settings", {
      testId: "save-btn",
      testIdAttr: "data-testid",
      role: "button",
    });
    expect(bonus).toBe(0);
  });

  it("matches by role+name when no testId", () => {
    const fb = new FeedbackMemory();
    fb.record("the submit button", { role: "button", name: "Submit" });
    const bonus = fb.bonusFor("submit form", { role: "button", name: "Submit" });
    expect(bonus).toBeGreaterThan(0);
  });

  it("de-dupes identical (tokens, winner) pairs", () => {
    const fb = new FeedbackMemory();
    const w = { testId: "x", testIdAttr: "data-testid", role: "button" };
    fb.record("foo bar", w);
    fb.record("foo bar", w);
    expect(fb.size()).toBe(1);
  });

  it("LRU-evicts past the cap", () => {
    const fb = new FeedbackMemory(3);
    fb.record("alpha button", { testId: "a1", role: "button" });
    fb.record("beta button", { testId: "b1", role: "button" });
    fb.record("gamma button", { testId: "c1", role: "button" });
    fb.record("delta button", { testId: "d1", role: "button" });
    expect(fb.size()).toBe(3);
    // 'alpha' should have been evicted.
    expect(fb.bonusFor("alpha button", { testId: "a1", role: "button" })).toBe(0);
    expect(fb.bonusFor("delta button", { testId: "d1", role: "button" })).toBeGreaterThan(0);
  });

  it("caps single-candidate bonus at 15", () => {
    const fb = new FeedbackMemory();
    const w = { testId: "x", testIdAttr: "data-testid", role: "button" };
    // Different token sets so they're not deduped; each contributes +5.
    fb.record("aa bb", w);
    fb.record("cc dd", w);
    fb.record("ee ff", w);
    fb.record("gg hh", w);
    // bonus for a query that overlaps all of them — should cap at 15.
    const bonus = fb.bonusFor("aa cc ee gg", w);
    expect(bonus).toBeLessThanOrEqual(15);
  });
});
