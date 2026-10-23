import { describe, it, expect } from "vitest";
import {
  assertValidProfileName,
  invalidNameRefusal,
  isValidProfileName,
  MAX_PROFILE_NAME_LENGTH,
} from "./profile-name.js";

describe("isValidProfileName", () => {
  it("accepts plain names", () => {
    for (const ok of ["work", "job-search_2.0", "A", "9lives", "a.b", "x".repeat(128)]) {
      expect(isValidProfileName(ok)).toBe(true);
    }
  });

  it("rejects names that are not one plain directory name", () => {
    const bad = [
      "",
      ".",
      "..",
      "../x",
      "a/../b",
      "a/b",
      "a\\b",
      "..\\x",
      "/etc",
      "/tmp/x",
      "C:\\Users\\x",
      "a..b",
      ".hidden",
      "-flag",
      "_x",
      "a\0b",
      "a\nb",
      "a b",
      "x".repeat(MAX_PROFILE_NAME_LENGTH + 1),
      "x".repeat(10_000),
    ];
    for (const name of bad) expect(isValidProfileName(name), JSON.stringify(name)).toBe(false);
  });
});

describe("assertValidProfileName", () => {
  it("throws a named refusal that says how to fix the name", () => {
    expect(() => assertValidProfileName("profile", "../x")).toThrow(
      /^invalid-name: profile "\.\.\/x"/,
    );
    expect(() => assertValidProfileName("profile", "../x")).toThrow(/no path separators/);
    expect(() => assertValidProfileName("profile", "work")).not.toThrow();
  });

  it("quotes a NUL byte and cuts a very long name short in the message", () => {
    expect(invalidNameRefusal("profile", "a\0b")).toContain('"a\\u0000b"');
    const msg = invalidNameRefusal("session id", "y".repeat(10_000));
    expect(msg.length).toBeLessThan(400);
    expect(msg).toMatch(/^invalid-name: session id "y{64}…"/);
  });
});
