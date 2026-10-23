import { describe, it, expect } from "vitest";
import {
  buildLoginArgs,
  buildStartArgs,
  chromeCandidates,
  findInstalledChrome,
} from "./chrome-launch.js";

describe("chromeCandidates / findInstalledChrome", () => {
  it("returns the first candidate that exists, or undefined", () => {
    const second = chromeCandidates("linux")[1]!;
    expect(findInstalledChrome((p) => p === second, "linux")).toBe(second);
    expect(findInstalledChrome(() => false, "linux")).toBeUndefined();
  });
});

describe("buildStartArgs", () => {
  it("carries a remote debugging port and the profile", () => {
    const args = buildStartArgs({ port: 9333, profileDir: "/ws/profile" });
    expect(args).toContain("--remote-debugging-port=9333");
    expect(args).toContain("--user-data-dir=/ws/profile");
    expect(args).not.toContain("--disable-web-security");
  });

  it("adds the opt-in flags only when asked", () => {
    const args = buildStartArgs({
      port: 9222,
      profileDir: "/p",
      insecure: true,
      noBackgroundThrottling: true,
    });
    expect(args).toContain("--disable-web-security");
    expect(args).toContain("--disable-renderer-backgrounding");
  });
});

describe("buildLoginArgs", () => {
  it("has no debug port and no automation flag", () => {
    const args = buildLoginArgs({ profileDir: "/ws/profile", url: "https://example.com/" });
    expect(args.some((a) => a.startsWith("--remote-debugging"))).toBe(false);
    expect(args.some((a) => a.includes("automation"))).toBe(false);
    expect(args).toContain("--user-data-dir=/ws/profile");
    expect(args[args.length - 1]).toBe("https://example.com/");
  });
});
