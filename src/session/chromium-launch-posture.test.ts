import { describe, it, expect, vi, afterEach } from "vitest";
import {
  automationSwitchOptions,
  isChannelNotInstalled,
  launchWithChannelPlan,
  planChromiumChannel,
} from "./chromium-launch-posture.js";
import { log } from "../util/logging.js";
import { playwrightInstallCommand } from "../util/playwright-version.js";

const NOT_FOUND = new Error(
  "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome\n" +
    'Run "npx playwright install chrome"',
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("planChromiumChannel", () => {
  it.each([
    {
      label: "defaults to the installed Chrome, with a fallback to the bundled build",
      input: {},
      channel: "chrome",
      fallback: true,
    },
    {
      label: "treats an empty channel as the default",
      input: { channel: "" },
      channel: "chrome",
      fallback: true,
    },
    {
      label: "honours an explicit chrome without a fallback",
      input: { channel: "chrome" },
      channel: "chrome",
      fallback: false,
    },
    {
      label: '"chromium" forces the bundled build, matched case- and whitespace-insensitively',
      input: { channel: " Chromium " },
      channel: undefined,
      fallback: false,
    },
    {
      label: "keeps an extension launch with no channel on the bundled build",
      input: { extensionPaths: ["/tmp/ext"] },
      channel: undefined,
      fallback: undefined,
    },
    {
      label: "keeps an explicit channel for an extension launch",
      input: { extensionPaths: ["/tmp/ext"], channel: "chrome" },
      channel: "chrome",
      fallback: undefined,
    },
    {
      label: "treats an empty extension list as no extensions",
      input: { extensionPaths: [] },
      channel: "chrome",
      fallback: undefined,
    },
  ])("$label", ({ input, channel, fallback }) => {
    const plan = planChromiumChannel(input);
    expect(plan.channel).toBe(channel);
    if (fallback !== undefined) expect(plan.fallbackToBundled).toBe(fallback);
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
});

describe("a launch that finds no browser", () => {
  const NO_BUNDLED = new Error(
    "browserType.launchPersistentContext: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome\n" +
      "Looks like Playwright was just installed or updated. Please run: npx playwright install",
  );

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
});

describe("automationSwitchOptions", () => {
  it.each([
    {
      label: "drops --enable-automation by default",
      env: {},
      expected: { ignoreDefaultArgs: ["--enable-automation"] },
    },
    {
      label: "restores the switch for BROWX_AUTOMATION_SWITCH=1",
      env: { BROWX_AUTOMATION_SWITCH: "1" },
      expected: {},
    },
    {
      label:
        "restores the switch for BROWX_AUTOMATION_SWITCH=true, case- and whitespace-insensitive",
      env: { BROWX_AUTOMATION_SWITCH: " TRUE " },
      expected: {},
    },
  ])("$label", ({ env, expected }) => {
    expect(automationSwitchOptions(env)).toEqual(expected);
  });
});
