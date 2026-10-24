import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { playwrightInstallCommand } from "./playwright-version.js";

const installed = (
  createRequire(import.meta.url)("playwright-core/package.json") as { version: string }
).version;

describe("playwrightInstallCommand", () => {
  it.each<[string, [string, (string | null)?], string]>([
    [
      "pins the installed version",
      ["chromium"],
      `npx playwright-core@${installed} install chromium`,
    ],
    [
      "takes an explicit version",
      ["firefox", "1.2.3"],
      "npx playwright-core@1.2.3 install firefox",
    ],
    ["drops the pin when given no version", ["webkit", null], "npx playwright-core install webkit"],
  ])("%s", (_label, args, expected) => {
    expect(playwrightInstallCommand(...args)).toBe(expected);
  });
});
