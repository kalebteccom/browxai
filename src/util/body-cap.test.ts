import { describe, expect, it } from "vitest";
import { capBodyBytes } from "./body-cap.js";
import { PLAIN_CUT, textCutFor } from "./frame-cap.js";
import { SecretRegistry } from "./secrets.js";

describe("capBodyBytes", () => {
  it("drops a value's head that crosses the end of the byte window", () => {
    const two = new SecretRegistry();
    two.register({ name: "A", value: "A".repeat(60) });
    two.register({ name: "B", value: "b_0123456789" + "B".repeat(48) });
    const cut = textCutFor(two);
    // Copies of A shrink to `<A>` each; B starts so that it runs past
    // the window's end, and the shrink pulls its head under the 100-byte cut.
    const windowEnd = 100 + 4 * cut.slack;
    const copies = Math.floor((windowEnd - 30) / 60);
    const raw =
      "A".repeat(60 * copies) +
      "x".repeat(windowEnd - 30 - 60 * copies) +
      "b_0123456789" +
      "B".repeat(48) +
      "z".repeat(500);
    expect(cut.mask!(raw.slice(0, windowEnd)).slice(0, 100)).toContain("b_0");
    const out = capBodyBytes(Buffer.from(raw), 100, cut);
    expect(out.base64Encoded).toBe(false);
    expect(out.truncated).toBe(true);
    expect(out.body).not.toContain("b_0");
    expect(out.body).toBe(cut.mask!(raw).slice(0, 100));
  });

  it("masks a text body within the cap whole and keeps binary as base64", () => {
    const one = new SecretRegistry();
    one.register({ name: "T", value: "secret-value" });
    expect(capBodyBytes(Buffer.from("x secret-value y"), 100, textCutFor(one))).toEqual({
      body: "x <T> y",
      base64Encoded: false,
    });
    const bin = Buffer.from([0xff, 0xfe]);
    expect(capBodyBytes(bin, 100, PLAIN_CUT)).toEqual({
      body: bin.toString("base64"),
      base64Encoded: true,
    });
  });

  it("cuts a body with a 4-byte character across the cut on its boundary", () => {
    const out = capBodyBytes(Buffer.from("ab😀cd"), 4, PLAIN_CUT);
    expect(out).toEqual({ body: "ab", base64Encoded: false, truncated: true });
  });
});
