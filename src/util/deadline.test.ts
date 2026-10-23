import { describe, it, expect } from "vitest";
import {
  withDeadline,
  clampTimeout,
  DeadlineError,
  DEFAULT_ACTION_TIMEOUT_MS,
  MAX_ACTION_TIMEOUT_MS,
  MIN_ACTION_TIMEOUT_MS,
} from "./deadline.js";

describe("withDeadline", () => {
  it("resolves with the value when the op beats the deadline", async () => {
    await expect(withDeadline(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });

  it("rejects with DeadlineError when the op exceeds the deadline", async () => {
    const slow = new Promise((r) => setTimeout(r, 50));
    await expect(withDeadline(slow, 5, "click")).rejects.toBeInstanceOf(DeadlineError);
  });

  it("propagates the op's own rejection (not masked by the timer)", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 1000, "x")).rejects.toThrow(
      "boom",
    );
  });
});

describe("clampTimeout — ceiling", () => {
  it("uses the fallback when no request is given", () => {
    expect(clampTimeout(undefined, DEFAULT_ACTION_TIMEOUT_MS)).toEqual({
      ms: DEFAULT_ACTION_TIMEOUT_MS,
    });
  });

  it("passes an in-range request through unchanged", () => {
    expect(clampTimeout(8000, DEFAULT_ACTION_TIMEOUT_MS)).toEqual({ ms: 8000 });
  });

  it("clamps an over-ceiling (insane) value and emits a deterrent warning", () => {
    const r = clampTimeout(7_200_000, DEFAULT_ACTION_TIMEOUT_MS); // 2h
    expect(r.ms).toBe(MAX_ACTION_TIMEOUT_MS);
    expect(r.warning).toMatch(/exceeds the 1h hard ceiling/);
    expect(r.warning).toMatch(/essentially always a mistake/);
  });

  it("floors a sub-minimum request", () => {
    expect(clampTimeout(0, DEFAULT_ACTION_TIMEOUT_MS).ms).toBe(MIN_ACTION_TIMEOUT_MS);
  });
});
