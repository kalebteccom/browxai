import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCTOR_USAGE, runDoctor } from "./doctor.js";

let out = "";
let err = "";

beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

describe("browxai doctor arguments", () => {
  it.each([
    ["a flag with a typo", ["--verbos"]],
    ["a bare word", ["verbose"]],
    ["a short flag", ["-v"]],
    ["an extra argument after --verbose", ["--verbose", "extra"]],
    ["an unknown flag before --verbose", ["--jsno", "--verbose"]],
    ["--json twice", ["--json", "--json"]],
    ["--verbose=1", ["--verbose=1"]],
  ])("prints usage and exits 2 for %s, running no check", async (_name, args) => {
    expect(await runDoctor(args)).toBe(2);
    expect(err).toBe(DOCTOR_USAGE);
    expect(err).toContain("usage: browxai doctor [--verbose] [--json]");
    expect(out).toBe("");
  });
});
