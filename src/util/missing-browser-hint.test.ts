import { describe, expect, it } from "vitest";
import { withInstallHint, withNoDisplayHint } from "./missing-browser-hint.js";

const BANNER =
  "browserType.launch: Executable doesn't exist at /x/firefox\n  npx playwright install";

describe("withInstallHint", () => {
  it("keeps the banner and adds the pinned install command", () => {
    const out = withInstallHint("firefox", new Error(BANNER)) as Error;
    expect(out.message.startsWith(BANNER)).toBe(true);
    expect(out.message).toMatch(
      /\nbrowxai: firefox is not downloaded\. Run `npx playwright-core(@[\d.]+)? install firefox`\.$/,
    );
  });

  it("names the engine it was given", () => {
    const out = withInstallHint("webkit", new Error(BANNER)) as Error;
    expect(out.message).toContain("install webkit");
  });

  it("passes any other error through unchanged", () => {
    const err = new Error("something else");
    expect(withInstallHint("firefox", err)).toBe(err);
    expect(withInstallHint("firefox", "text")).toBe("text");
  });
  it("leaves a non-Error that names the missing executable alone", () => {
    const like = { message: "Executable doesn't exist at /x" };
    expect(withInstallHint("firefox", like)).toBe(like);
  });

  it("keeps the original error as the cause", () => {
    const err = new Error(BANNER);
    expect((withInstallHint("firefox", err) as Error).cause).toBe(err);
  });
});

const NO_DISPLAY_BANNER =
  "browserType.launch: Looks like you launched a headed browser without having a XServer running.\nSet either 'headless: true' or use 'xvfb-run <your-playwright-app>' before running Playwright.";

describe("withNoDisplayHint", () => {
  it("keeps the banner and names BROWX_HEADLESS=1 for a headed launch", () => {
    const out = withNoDisplayHint(new Error(NO_DISPLAY_BANNER), false) as Error;
    expect(out.message.startsWith(NO_DISPLAY_BANNER)).toBe(true);
    expect(out.message).toMatch(/\nbrowxai: a headed browser needs a display.*BROWX_HEADLESS=1/);
  });

  it("matches the Chromium startup log line too", () => {
    const out = withNoDisplayHint(new Error("[ERROR] Missing X server or $DISPLAY"), false);
    expect((out as Error).message).toContain("BROWX_HEADLESS=1");
  });

  it("leaves a headless launch alone", () => {
    const err = new Error(NO_DISPLAY_BANNER);
    expect(withNoDisplayHint(err, true)).toBe(err);
    expect(withNoDisplayHint(err, undefined)).toBe(err);
  });

  it("passes any other error through unchanged", () => {
    const err = new Error("something else");
    expect(withNoDisplayHint(err, false)).toBe(err);
    expect(withNoDisplayHint("text", false)).toBe("text");
  });

  it("keeps the original error as the cause", () => {
    const err = new Error(NO_DISPLAY_BANNER);
    expect((withNoDisplayHint(err, false) as Error).cause).toBe(err);
  });
});
