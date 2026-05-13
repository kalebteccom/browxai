import { describe, it, expect } from "vitest";
import { estimateTokens, truncateToBudget } from "./tokens.js";

describe("estimateTokens", () => {
  it("approximates 1 token ≈ 4 chars", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});

describe("truncateToBudget", () => {
  it("passes short text through unchanged", () => {
    const { text, truncated } = truncateToBudget("hello", 100);
    expect(truncated).toBe(false);
    expect(text).toBe("hello");
  });

  it("truncates long line-based text and marks truncated:true", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}: ${"x".repeat(80)}`).join("\n");
    const { text, truncated } = truncateToBudget(long, 100);
    expect(truncated).toBe(true);
    expect(text).toMatch(/\[\+\d+ more]/);
    expect(estimateTokens(text)).toBeLessThanOrEqual(100);
  });
});
