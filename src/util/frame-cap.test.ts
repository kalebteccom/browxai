import { describe, expect, it } from "vitest";
import { capFramePayload } from "./frame-cap.js";
import { SecretRegistry } from "./secrets.js";

describe("capFramePayload", () => {
  const secrets = new SecretRegistry();
  secrets.register({ name: "TOKEN", value: "tok_0123456789abcdef" });
  const mask = (s: string): string => secrets.applyMaskInText(s);

  it("returns a payload within the cap as given", () => {
    expect(capFramePayload("short", 10, mask)).toEqual({ payload: "short" });
  });

  it("masks a value that straddles the cut before cutting", () => {
    // The value starts 6 characters before the cut, so a cut-then-mask keeps
    // its first 6 characters.
    const raw = "x".repeat(94) + "tok_0123456789abcdef" + "y".repeat(50);
    const out = capFramePayload(raw, 100, mask);
    expect(out.truncated).toBe(true);
    expect(out.payload).toHaveLength(100);
    expect(out.payload).not.toContain("tok_01");
    expect(out.payload.endsWith("<TOKEN")).toBe(true);
  });

  it("drops the truncated flag when masking brings the payload under the cap", () => {
    const raw = "a".repeat(90) + "tok_0123456789abcdef";
    expect(capFramePayload(raw, 100, mask)).toEqual({ payload: "a".repeat(90) + "<TOKEN>" });
  });

  it("cuts without a mask when none is given", () => {
    expect(capFramePayload("abcdef", 3, null)).toEqual({ payload: "abc", truncated: true });
  });
});
