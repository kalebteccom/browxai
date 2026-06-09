import { describe, it, expect } from "vitest";
import { classifyFailure } from "./failure.js";

describe("classifyFailure", () => {
  it("flags Playwright context-teardown strings as browxai-origin", () => {
    for (const m of [
      "Target page, context or browser has been closed",
      "Execution context was destroyed, most likely because of a navigation",
      "Protocol error (Runtime.evaluate): Target closed",
      "browxai: anti-wedge timeout after 5000ms",
      "Page has been closed",
    ]) {
      const r = classifyFailure(m);
      expect(r.source, m).toBe("browxai");
      expect(r.hint).toMatch(/NOT an application crash|do not file/i);
    }
  });

  it("flags genuine app navigation/renderer failures as app-origin", () => {
    for (const m of [
      "Page crashed",
      "net::ERR_CONNECTION_REFUSED at https://app",
      "net::ERR_NAME_NOT_RESOLVED",
      "Navigation failed because page crashed",
    ]) {
      expect(classifyFailure(m).source, m).toBe("app");
    }
  });

  it("returns unknown for an unrecognised message (and says to verify first)", () => {
    const r = classifyFailure("some unexpected selector error");
    expect(r.source).toBe("unknown");
    expect(r.hint).toMatch(/list_sessions|indeterminate/i);
  });

  it("does not throw on empty/garbage input", () => {
    expect(classifyFailure("").source).toBe("unknown");

    expect(classifyFailure(undefined as any).source).toBe("unknown");
  });
});
