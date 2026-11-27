import { describe, it, expect } from "vitest";
import { safeFilters } from "./device-emu-attach.js";
import { SecretRegistry } from "../util/secrets.js";
import { textCutFor } from "../util/frame-cap.js";

const A = "alphaSecretValue0123456789abcdefghijklmn";
const B = "bravoSecretValue0123456789opqrstuvwxyzAB";

function registry(): SecretRegistry {
  const secrets = new SecretRegistry();
  secrets.register({ name: "A", value: A });
  secrets.register({ name: "B", value: B });
  return secrets;
}

describe("safeFilters", () => {
  it("returns filters within the cap as given", () => {
    const filters = [{ services: ["heart_rate"] }];
    expect(safeFilters(filters, textCutFor(registry()))).toBe(filters);
  });

  it("drops long filters whose cut text does not parse", () => {
    expect(safeFilters([{ name: "x".repeat(5000) }])).toBeUndefined();
  });

  it("keeps long filters that fit once masked, with each value masked", () => {
    const secrets = registry();
    // 120 copies of A take the JSON past 4096 characters; masked they fit.
    const filters = { names: Array.from({ length: 120 }, () => A) };
    expect(JSON.stringify(filters).length).toBeGreaterThan(4096);
    const out = safeFilters(filters, textCutFor(secrets));
    expect(out).toEqual({ names: Array.from({ length: 120 }, () => "<A>") });
  });

  it("keeps no head of a value that crosses the masked window when another value shrinks it", () => {
    const secrets = registry();
    const slack = secrets.maskSlack();
    // Masked, the text up to and including `"r":` is exactly 4096 characters,
    // so the cut text parses with the `"…"` tail. In the raw text B starts
    // inside the first masked window (4096 + slack characters) and ends past
    // it: A's mask shrinks the window, which has to grow and be masked again.
    const qLen = 4096 - 25 - 3000;
    const filters = { p: "p".repeat(3000) + A, q: "q".repeat(qLen) + B, r: "tail" };
    const raw = JSON.stringify(filters);
    const bStart = raw.indexOf(B);
    expect(bStart).toBeLessThan(4096 + slack);
    expect(bStart + B.length).toBeGreaterThan(4096 + slack);

    const out = safeFilters(filters, textCutFor(secrets)) as Record<string, string>;
    expect(out).toEqual({ p: "p".repeat(3000) + "<A>", q: "q".repeat(qLen) + "<B>", r: "…" });
    const text = JSON.stringify(out);
    expect(text).not.toContain(A.slice(0, 8));
    expect(text).not.toContain(B.slice(0, 8));
  });
});
