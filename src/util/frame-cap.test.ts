import { describe, expect, it } from "vitest";
import {
  capFramePayload,
  capMasked,
  clipMasked,
  clipPageText,
  pageReadLength,
  PLAIN_CUT,
  textCutFor,
} from "./frame-cap.js";
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

describe("capMasked", () => {
  const secrets = new SecretRegistry();
  secrets.register({ name: "TOKEN", value: "tok_0123456789abcdef" });
  const mask = (s: string): string => secrets.applyMaskInText(s);
  const slack = secrets.maskSlack();

  it("masks a value longer than the cap that starts at offset 0", () => {
    const out = capMasked("tok_0123456789abcdef" + "z".repeat(40), 10, mask, slack);
    expect(out.truncated).toBe(true);
    expect(out.payload).not.toContain("tok_");
    expect(out.payload.startsWith("<TOKEN>")).toBe(true);
  });

  it("equals masking the whole text then cutting, for every offset around the cut", () => {
    const value = "tok_0123456789abcdef";
    for (let at = 70; at <= 110; at++) {
      const raw = "x".repeat(at) + value + "y".repeat(300);
      expect(capMasked(raw, 100, mask, slack)).toEqual(capMasked(raw, 100, mask, Infinity));
      expect(capMasked(raw, 100, mask, slack).payload).toBe(mask(raw).slice(0, 100));
    }
  });

  it("keeps no head of a second value when masking a first one shortens the window", () => {
    const two = new SecretRegistry();
    two.register({ name: "A", value: "A".repeat(60) });
    two.register({ name: "B", value: "b_0123456789" + "B".repeat(48) });
    const twoMask = (s: string): string => two.applyMaskInText(s);
    const twoSlack = two.maskSlack();
    // A at 0 shrinks to `<A>`; B starts past the cut and crosses the end of
    // the first window, so a single pass would pull its head into the output.
    const raw = "A".repeat(60) + "x".repeat(70) + "b_0123456789" + "B".repeat(48) + "z".repeat(400);
    // One pass over `max + slack` characters would leave B's head in the output.
    expect(twoMask(raw.slice(0, 100 + twoSlack)).slice(0, 100)).toContain("b_01");
    const out = capMasked(raw, 100, twoMask, twoSlack);
    expect(out.truncated).toBe(true);
    expect(out.payload).toHaveLength(100);
    expect(out.payload).not.toContain("b_01");
    expect(out.payload).toBe(twoMask(raw).slice(0, 100));
  });

  it("is a plain cut with no mask and no slack", () => {
    expect(capMasked("abcdef", 3, null, 0)).toEqual({ payload: "abc", truncated: true });
    const empty = new SecretRegistry();
    expect(empty.maskSlack()).toBe(0);
    expect(capMasked("abcdef", 3, (s) => empty.applyMaskInText(s), 0)).toEqual({
      payload: "abc",
      truncated: true,
    });
  });
});

describe("clipMasked and clipPageText", () => {
  const secrets = new SecretRegistry();
  secrets.register({ name: "TOKEN", value: "tok_0123456789abcdef" });
  const cut = textCutFor(secrets);

  it("masks before it clips, with the marker in the last place", () => {
    const raw = "x".repeat(70) + "tok_0123456789abcdef" + "y".repeat(10);
    const out = clipMasked(raw, 80, cut.mask, { marker: "…" });
    expect(out).toBe("x".repeat(70) + "<TOKEN>" + "yy…");
    expect(out).toHaveLength(80);
  });

  it("returns text that fits after masking whole", () => {
    expect(clipMasked("ab tok_0123456789abcdef", 10, cut.mask, { marker: "…" })).toBe("ab <TOKEN>");
  });

  it("matches the old page cut byte for byte with no secret registered", () => {
    const text = "é".repeat(130);
    const read = text.slice(0, pageReadLength(120, 0));
    expect(clipPageText(read, 120, PLAIN_CUT)).toBe(text.slice(0, 120));
    expect(clipPageText(text.slice(0, pageReadLength(80, 0)), 80, PLAIN_CUT, { marker: "…" })).toBe(
      text.slice(0, 79) + "…",
    );
    expect(clipPageText("short", 80, PLAIN_CUT, { marker: "…" })).toBe("short");
    expect(textCutFor(new SecretRegistry())).toBe(PLAIN_CUT);
  });

  it("drops the last slack characters of a page read that was cut", () => {
    // The page read cap + slack + 1 characters. A second value starts inside
    // that read and runs past its end: its head is in the read, unmasked.
    const two = new SecretRegistry();
    two.register({ name: "A", value: "A".repeat(40) });
    two.register({ name: "B", value: "b_0123456789abcdefghijklmnopqrstuvwxyz0" });
    const twoCut = textCutFor(two);
    const text =
      "A".repeat(40) +
      "x".repeat(100) +
      "b_0123456789abcdefghijklmnopqrstuvwxyz0" +
      "z".repeat(100);
    const read = text.slice(0, pageReadLength(120, twoCut.slack));
    expect(twoCut.mask!(read).slice(0, 119)).toContain("b_01");
    const out = clipPageText(read, 120, twoCut, { marker: "…" });
    expect(out).not.toContain("b_01");
    expect(out.startsWith("<A>")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  it("keeps a requested length before the marker", () => {
    expect(clipMasked("abcdefgh", 4, null, { marker: "…", keep: 4 })).toBe("abcd…");
  });
});
