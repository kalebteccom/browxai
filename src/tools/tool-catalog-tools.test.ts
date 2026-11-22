import { describe, it, expect } from "vitest";
import { summaryOf } from "./tool-catalog-tools.js";

describe("summaryOf", () => {
  it("takes the first sentence", () => {
    expect(summaryOf("Click an element. Pass a ref or a selector.")).toBe("Click an element.");
  });

  it("does not stop at a dot inside a name", () => {
    expect(summaryOf("Run `example.echo` once. Then stop.")).toBe("Run `example.echo` once.");
  });

  it("collapses whitespace and keeps a description with no full stop whole", () => {
    expect(summaryOf("List\n  sessions")).toBe("List sessions");
  });

  it("cuts a long first sentence to the limit with three dots", () => {
    const out = summaryOf(`${"word ".repeat(60)}end.`, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("...")).toBe(true);
  });
});
