import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runServe, unknownServeArg } from "./serve.js";

let err = "";

beforeEach(() => {
  err = "";
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});

afterEach(() => vi.restoreAllMocks());

describe("unknownServeArg", () => {
  it("accepts --socket and --engine with a value", () => {
    expect(unknownServeArg(["--socket", "/tmp/a.sock"])).toBeUndefined();
    expect(unknownServeArg(["--socket", "/tmp/a.sock", "--engine", "firefox"])).toBeUndefined();
    expect(unknownServeArg(["--engine=firefox", "--socket", "/tmp/a.sock"])).toBeUndefined();
  });

  it("names the first argument serve does not take", () => {
    expect(unknownServeArg(["--socket", "/tmp/a.sock", "--bogus"])).toBe("--bogus");
    expect(unknownServeArg(["--sockt", "/tmp/a.sock"])).toBe("--sockt");
    expect(unknownServeArg(["--socket=/tmp/a.sock"])).toBe("--socket=/tmp/a.sock");
    expect(unknownServeArg(["extra", "--socket", "/tmp/a.sock"])).toBe("extra");
  });
});

describe("browxai serve arguments", () => {
  it("prints usage and exits 2 for an unknown argument, starting nothing", async () => {
    expect(await runServe(["--socket", "/tmp/a.sock", "--bogus"])).toBe(2);
    expect(err).toContain('browxai serve: unknown argument "--bogus"');
    expect(err).toContain("usage: browxai serve --socket <path> [--engine <kind>]");
  });

  it("prints usage and exits 2 without --socket", async () => {
    expect(await runServe([])).toBe(2);
    expect(err).toContain("usage: browxai serve --socket <path>");
    expect(err).not.toContain("unknown argument");
  });

  it("shows a Windows pipe example with single backslashes", async () => {
    expect(await runServe([])).toBe(2);
    expect(err).toContain("browxai serve --socket \\\\.\\pipe\\browxai");
  });
});
