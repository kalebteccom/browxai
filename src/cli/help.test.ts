import { describe, expect, it } from "vitest";
import { wantsHelp } from "./help.js";

describe("wantsHelp", () => {
  it("is true for --help and -h in any position", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["chrome", "start", "--help"])).toBe(true);
    expect(wantsHelp(["doctor", "-h"])).toBe(true);
    expect(wantsHelp(["--engine", "firefox", "--help"])).toBe(true);
  });

  it("accepts a leading help as an alias", () => {
    expect(wantsHelp(["help"])).toBe(true);
    expect(wantsHelp(["help", "chrome"])).toBe(true);
  });

  it("is false for ordinary argv", () => {
    expect(wantsHelp([])).toBe(false);
    expect(wantsHelp(["doctor"])).toBe(false);
    expect(wantsHelp(["chrome", "start", "--port", "9222"])).toBe(false);
    expect(wantsHelp(["plugin", "install", "help"])).toBe(false);
  });
});
