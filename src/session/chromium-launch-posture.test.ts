import { describe, it, expect, vi, afterEach } from "vitest";
import {
  automationSwitchOptions,
  isBundledBrowserMissing,
  isChannelNotInstalled,
  launchWithChannelPlan,
  planChromiumChannel,
} from "./chromium-launch-posture.js";
import { log } from "../util/logging.js";
import { envLayer } from "../util/config-store.js";
import { playwrightInstallCommand } from "../util/playwright-version.js";

const NOT_FOUND = new Error(
  "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome\n" +
    'Run "npx playwright install chrome"',
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("planChromiumChannel", () => {
  it("defaults to the installed Chrome, with a fallback to the bundled build", () => {
    expect(planChromiumChannel({})).toEqual({ channel: "chrome", fallbackToBundled: true });
    expect(planChromiumChannel({ channel: "" })).toEqual({
      channel: "chrome",
      fallbackToBundled: true,
    });
  });

  it("honours an explicit channel without a fallback", () => {
    expect(planChromiumChannel({ channel: "msedge" })).toEqual({
      channel: "msedge",
      fallbackToBundled: false,
    });
    expect(planChromiumChannel({ channel: "chrome" })).toEqual({
      channel: "chrome",
      fallbackToBundled: false,
    });
  });

  it('"chromium" forces the bundled build', () => {
    const plan = planChromiumChannel({ channel: "chromium" });
    expect(plan.channel).toBeUndefined();
    expect(plan.fallbackToBundled).toBe(false);
    expect(planChromiumChannel({ channel: " Chromium " }).channel).toBeUndefined();
  });

  it("keeps an extension launch with no channel on the bundled build", () => {
    expect(planChromiumChannel({ extensionPaths: ["/tmp/ext"] }).channel).toBeUndefined();
    expect(planChromiumChannel({ extensionPaths: ["/tmp/ext"], channel: "chrome" }).channel).toBe(
      "chrome",
    );
    expect(planChromiumChannel({ extensionPaths: [] }).channel).toBe("chrome");
  });

  it("reads the channel BROWX_CHANNEL sets through the config env layer", () => {
    const fromEnv = envLayer({ BROWX_CHANNEL: "chromium" }).channel;
    expect(planChromiumChannel({ channel: fromEnv }).channel).toBeUndefined();
    const msedge = envLayer({ BROWX_CHANNEL: "msedge" }).channel;
    expect(planChromiumChannel({ channel: msedge }).channel).toBe("msedge");
    expect(planChromiumChannel({ channel: envLayer({}).channel }).channel).toBe("chrome");
  });
});

describe("isChannelNotInstalled", () => {
  it("matches Playwright's missing-distribution error for that channel only", () => {
    expect(isChannelNotInstalled(NOT_FOUND, "chrome")).toBe(true);
    expect(isChannelNotInstalled(NOT_FOUND, "msedge")).toBe(false);
    expect(
      isChannelNotInstalled(
        new Error("Chromium distribution 'chrome' is not supported on linux"),
        "chrome",
      ),
    ).toBe(true);
    expect(isChannelNotInstalled(new Error("Target closed"), "chrome")).toBe(false);
  });
});

describe("launchWithChannelPlan", () => {
  it("launches the planned channel when it works", async () => {
    const launch = vi.fn().mockResolvedValue("ok");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const out = await launchWithChannelPlan({ channel: "chrome", fallbackToBundled: true }, launch);
    expect(out).toBe("ok");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({ channel: "chrome" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the bundled build and logs why when Chrome is not installed", async () => {
    const launch = vi.fn().mockRejectedValueOnce(NOT_FOUND).mockResolvedValueOnce("bundled");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const out = await launchWithChannelPlan({ channel: "chrome", fallbackToBundled: true }, launch);
    expect(out).toBe("bundled");
    expect(launch.mock.calls).toEqual([[{ channel: "chrome" }], [{}]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/no installed "chrome" browser found/);
    expect(warn.mock.calls[0]![0]).toMatch(/bundled Chromium/);
  });

  it("does not substitute for an explicit channel", async () => {
    const launch = vi.fn().mockRejectedValue(NOT_FOUND);
    await expect(
      launchWithChannelPlan({ channel: "chrome", fallbackToBundled: false }, launch),
    ).rejects.toBe(NOT_FOUND);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("propagates a launch error that is not a missing install", async () => {
    const boom = new Error("profile locked");
    const launch = vi.fn().mockRejectedValue(boom);
    await expect(
      launchWithChannelPlan({ channel: "chrome", fallbackToBundled: true }, launch),
    ).rejects.toBe(boom);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("launches once with no channel for the bundled plan", async () => {
    const launch = vi.fn().mockResolvedValue("bundled");
    await launchWithChannelPlan({ fallbackToBundled: false }, launch);
    expect(launch.mock.calls).toEqual([[{}]]);
  });
});

describe("a launch that finds no browser", () => {
  const NO_BUNDLED = new Error(
    "browserType.launchPersistentContext: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome\n" +
      "Looks like Playwright was just installed or updated. Please run: npx playwright install",
  );

  it("recognises Playwright's missing-download error", () => {
    expect(isBundledBrowserMissing(NO_BUNDLED)).toBe(true);
    expect(isBundledBrowserMissing(new Error("profile locked"))).toBe(false);
  });

  it("adds an install hint after the fallback to the bundled build also fails", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const launch = vi.fn().mockRejectedValueOnce(NOT_FOUND).mockRejectedValueOnce(NO_BUNDLED);
    const err = await launchWithChannelPlan(
      { channel: "chrome", fallbackToBundled: true },
      launch,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Executable doesn't exist");
    expect((err as Error).message).toMatch(/Install Google Chrome/);
    expect((err as Error).message).toContain(`\`${playwrightInstallCommand("chromium")}\``);
    expect((err as Error).message).toMatch(/npx playwright-core@\d+\.\d+\.\d+ install chromium/);
    expect((err as Error).cause).toBe(NO_BUNDLED);
  });

  it("adds the hint when the bundled build is pinned and missing", async () => {
    const launch = vi.fn().mockRejectedValue(NO_BUNDLED);
    await expect(launchWithChannelPlan({ fallbackToBundled: false }, launch)).rejects.toThrow(
      /no browser to launch/,
    );
  });

  it("leaves other bundled-launch errors untouched", async () => {
    const boom = new Error("profile locked");
    const launch = vi.fn().mockRejectedValue(boom);
    await expect(launchWithChannelPlan({ fallbackToBundled: false }, launch)).rejects.toBe(boom);
  });
});

describe("automationSwitchOptions", () => {
  it("drops --enable-automation by default", () => {
    expect(automationSwitchOptions({})).toEqual({ ignoreDefaultArgs: ["--enable-automation"] });
  });

  it("restores the switch for BROWX_AUTOMATION_SWITCH=1 or true", () => {
    expect(automationSwitchOptions({ BROWX_AUTOMATION_SWITCH: "1" })).toEqual({});
    expect(automationSwitchOptions({ BROWX_AUTOMATION_SWITCH: " TRUE " })).toEqual({});
  });

  it("keeps dropping it for any other value", () => {
    for (const v of ["", "0", "no"]) {
      expect(automationSwitchOptions({ BROWX_AUTOMATION_SWITCH: v })).toEqual({
        ignoreDefaultArgs: ["--enable-automation"],
      });
    }
  });
});
