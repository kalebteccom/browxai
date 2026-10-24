import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { playwrightInstallCommand } from "./playwright-version.js";

const installed = (
  createRequire(import.meta.url)("playwright-core/package.json") as { version: string }
).version;

describe("playwrightInstallCommand", () => {
  it("pins the installed version", () => {
    expect(playwrightInstallCommand("chromium")).toBe(
      `npx playwright-core@${installed} install chromium`,
    );
  });

  it("takes an explicit version", () => {
    expect(playwrightInstallCommand("firefox", "1.2.3")).toBe(
      "npx playwright-core@1.2.3 install firefox",
    );
  });

  it("drops the pin when given no version", () => {
    expect(playwrightInstallCommand("webkit", null)).toBe("npx playwright-core install webkit");
  });
});
