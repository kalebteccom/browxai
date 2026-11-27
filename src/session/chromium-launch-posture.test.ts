import { describe, it, expect, vi, afterEach } from "vitest";
import {
  automationSwitchOptions,
  isBundledChannel,
  isChannelNotInstalled,
  LaunchChannelRefusal,
  launchWithChannelPlan,
  planChromiumChannel,
} from "./chromium-launch-posture.js";
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
      label: "defaults to the installed Chrome, refused when it is missing",
      input: {},
      channel: "chrome",
      defaulted: true,
    },
    {
      label: "treats an empty channel as the default",
      input: { channel: "" },
      channel: "chrome",
      defaulted: true,
    },
    {
      label: "honours an explicit chrome as given",
      input: { channel: "chrome" },
      channel: "chrome",
      defaulted: false,
    },
    {
      label: '"chromium" opts in to the bundled build, matched case- and whitespace-insensitively',
      input: { channel: " Chromium " },
      channel: undefined,
      defaulted: false,
    },
    {
      label: "launches an extension session that opted in on the bundled build",
      input: { extensionPaths: ["/tmp/ext"], channel: "chromium" },
      channel: undefined,
      defaulted: false,
    },
    {
      label: "keeps an explicit channel for an extension launch",
      input: { extensionPaths: ["/tmp/ext"], channel: "chrome" },
      channel: "chrome",
      defaulted: false,
    },
    {
      label: "treats an empty extension list as no extensions",
      input: { extensionPaths: [] },
      channel: "chrome",
      defaulted: true,
    },
  ])("$label", ({ input, channel, defaulted }) => {
    const plan = planChromiumChannel(input);
    expect(plan.channel).toBe(channel);
    expect(plan.defaulted).toBe(defaulted);
  });

  it("refuses an extension launch with no channel, naming the opt-in", () => {
    const err = (() => {
      try {
        planChromiumChannel({ extensionPaths: ["/tmp/ext"] });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(LaunchChannelRefusal);
    const refusal = err as LaunchChannelRefusal;
    expect(refusal.code).toBe("extensions-need-chromium");
    expect(refusal.message).toMatch(/^extensions-need-chromium: /);
    expect(refusal.message).toContain('`channel: "chromium"`');
    expect(refusal.message).toContain("BROWX_CHANNEL=chromium");
    expect(refusal.message).toContain("#extensions-need-chromium");
  });
});

describe("isBundledChannel", () => {
  it.each([
    ["chromium", true],
    [" CHROMIUM ", true],
    ["chrome", false],
    ["", false],
    [undefined, false],
  ])("%j is %s", (channel, expected) => {
    expect(isBundledChannel(channel)).toBe(expected);
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
    const out = await launchWithChannelPlan({ channel: "chrome", defaulted: true }, launch);
    expect(out).toBe("ok");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({ channel: "chrome" });
  });

  it("refuses a default launch with chrome-not-installed when Chrome is missing, launching nothing else", async () => {
    const launch = vi.fn().mockRejectedValue(NOT_FOUND);
    const err = await launchWithChannelPlan({ channel: "chrome", defaulted: true }, launch).catch(
      (e: unknown) => e,
    );
    expect(launch.mock.calls).toEqual([[{ channel: "chrome" }]]);
    expect(err).toBeInstanceOf(LaunchChannelRefusal);
    const refusal = err as LaunchChannelRefusal;
    expect(refusal.code).toBe("chrome-not-installed");
    expect(refusal.message).toMatch(/^chrome-not-installed: /);
    expect(refusal.message).toMatch(/Install Google Chrome/);
    expect(refusal.message).toContain("BROWX_CHANNEL=chromium");
    expect(refusal.message).toContain('`channel: "chromium"`');
    expect(refusal.message).toContain("#chrome-not-installed");
    expect(refusal.cause).toBe(NOT_FOUND);
  });

  it("launches the bundled build only on the opt-in", async () => {
    const launch = vi.fn().mockResolvedValue("bundled");
    const out = await launchWithChannelPlan(planChromiumChannel({ channel: "chromium" }), launch);
    expect(out).toBe("bundled");
    expect(launch.mock.calls).toEqual([[{}]]);
  });

  it("passes Playwright's error through for an explicit channel", async () => {
    const launch = vi.fn().mockRejectedValue(NOT_FOUND);
    await expect(
      launchWithChannelPlan({ channel: "chrome", defaulted: false }, launch),
    ).rejects.toBe(NOT_FOUND);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("propagates a launch error that is not a missing install", async () => {
    const boom = new Error("profile locked");
    const launch = vi.fn().mockRejectedValue(boom);
    await expect(
      launchWithChannelPlan({ channel: "chrome", defaulted: true }, launch),
    ).rejects.toBe(boom);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("a bundled launch that finds no download", () => {
  const NO_BUNDLED = new Error(
    "browserType.launchPersistentContext: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome\n" +
      "Looks like Playwright was just installed or updated. Please run: npx playwright install",
  );

  it("adds an install hint naming the pinned download", async () => {
    const launch = vi.fn().mockRejectedValue(NO_BUNDLED);
    const err = await launchWithChannelPlan({ defaulted: false }, launch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Executable doesn't exist");
    expect((err as Error).message).toContain(`\`${playwrightInstallCommand("chromium")}\``);
    expect((err as Error).message).toMatch(/npx playwright-core@\d+\.\d+\.\d+ install chromium/);
    expect((err as Error).message).toMatch(/installed Google Chrome/);
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
