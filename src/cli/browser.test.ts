import { describe, expect, it } from "vitest";

import { parseBrowserInstallArgs } from "./browser.js";

describe("browxai browser install args", () => {
  it("defaults to chromium", () => {
    expect(parseBrowserInstallArgs([])).toEqual({
      engines: ["chromium"],
      force: false,
      dryRun: false,
      withDeps: false,
    });
  });

  it("parses explicit engine and installer flags", () => {
    expect(parseBrowserInstallArgs(["--engine", "firefox", "--force", "--dry-run"])).toEqual({
      engines: ["firefox"],
      force: true,
      dryRun: true,
      withDeps: false,
    });
  });

  it("supports all Playwright-managed engines", () => {
    expect(parseBrowserInstallArgs(["--all", "--with-deps"])).toEqual({
      engines: ["chromium", "firefox", "webkit"],
      force: false,
      dryRun: false,
      withDeps: true,
    });
  });

  it("rejects attach-only and non-Playwright engines", () => {
    expect(() => parseBrowserInstallArgs(["--engine", "android"])).toThrow(
      /does not use Playwright browser downloads/,
    );
    expect(() => parseBrowserInstallArgs(["--engine=safari"])).toThrow(
      /does not use Playwright browser downloads/,
    );
  });
});
