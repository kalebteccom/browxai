import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineEntry } from "../registry.js";
import { PlaywrightChromiumAdapter } from "./playwright-chromium.js";
import { log } from "../../util/logging.js";
import "./chromium.engine.js";

// The launch itself is the keystone lane's job (real Chromium). Here the two
// adapter entry points are stubbed to capture the spec they are handed, so the
// option-threading — which flags and which `channel` reach Playwright — is
// asserted without a browser.
const LAUNCH_STUBBED = new Error("launch stubbed");

let workspaceRoot: string;
let originalWorkspace: string | undefined;

beforeAll(() => {
  originalWorkspace = process.env.BROWX_WORKSPACE;
  workspaceRoot = mkdtempSync(join(tmpdir(), "browxai-chromium-engine-"));
  process.env.BROWX_WORKSPACE = workspaceRoot;
});

afterAll(() => {
  if (originalWorkspace === undefined) delete process.env.BROWX_WORKSPACE;
  else process.env.BROWX_WORKSPACE = originalWorkspace;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function capturePersistentOptions(
  opts: Parameters<ReturnType<typeof engineEntry>["makeAdapter"]>[0],
): Promise<Record<string, unknown>> {
  const spy = vi
    .spyOn(PlaywrightChromiumAdapter.prototype, "launchPersistent")
    .mockRejectedValue(LAUNCH_STUBBED);
  await expect(engineEntry("chromium").makeAdapter(opts)).rejects.toThrow(LAUNCH_STUBBED);
  return spy.mock.calls[0]![0].options as unknown as Record<string, unknown>;
}

async function captureEphemeralLaunchOptions(
  opts: Parameters<ReturnType<typeof engineEntry>["makeAdapter"]>[0],
): Promise<Record<string, unknown>> {
  const spy = vi
    .spyOn(PlaywrightChromiumAdapter.prototype, "launchEphemeral")
    .mockRejectedValue(LAUNCH_STUBBED);
  await expect(
    engineEntry("chromium").makeAdapter({ ...opts, launchMode: "incognito" }),
  ).rejects.toThrow(LAUNCH_STUBBED);
  return spy.mock.calls[0]![0].launchOptions as unknown as Record<string, unknown>;
}

describe("chromium engine — channel resolution", () => {
  it("defaults to the installed Chrome on the persistent and ephemeral launches", async () => {
    expect((await capturePersistentOptions({})).channel).toBe("chrome");
    expect((await captureEphemeralLaunchOptions({})).channel).toBe("chrome");
  });

  it('omits `channel` for "chromium", so the bundled build launches', async () => {
    expect(await capturePersistentOptions({ channel: "chromium" })).not.toHaveProperty("channel");
    expect(await captureEphemeralLaunchOptions({ channel: "chromium" })).not.toHaveProperty(
      "channel",
    );
  });

  it("keeps an extension launch with no channel on the bundled build", async () => {
    const options = await capturePersistentOptions({ extensionPaths: ["/tmp/ext-a"] });
    expect(options).not.toHaveProperty("channel");
  });

  it("retries on the bundled build when the default Chrome is not installed", async () => {
    const notFound = new Error(
      "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
    );
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const spy = vi
      .spyOn(PlaywrightChromiumAdapter.prototype, "launchPersistent")
      .mockRejectedValueOnce(notFound)
      .mockRejectedValueOnce(LAUNCH_STUBBED);
    await expect(engineEntry("chromium").makeAdapter({})).rejects.toThrow(LAUNCH_STUBBED);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0].options).toHaveProperty("channel", "chrome");
    expect(spy.mock.calls[1]![0].options).not.toHaveProperty("channel");
  });

  it("does not retry when the channel was named", async () => {
    const notFound = new Error(
      "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
    );
    const spy = vi
      .spyOn(PlaywrightChromiumAdapter.prototype, "launchPersistent")
      .mockRejectedValue(notFound);
    await expect(engineEntry("chromium").makeAdapter({ channel: "chrome" })).rejects.toThrow(
      notFound,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("chromium engine — automation switch", () => {
  afterEach(() => {
    delete process.env.BROWX_AUTOMATION_SWITCH;
  });

  it("drops --enable-automation on the persistent and ephemeral launches", async () => {
    expect((await capturePersistentOptions({})).ignoreDefaultArgs).toEqual(["--enable-automation"]);
    expect((await captureEphemeralLaunchOptions({})).ignoreDefaultArgs).toEqual([
      "--enable-automation",
    ]);
  });

  it("adds no other fingerprint-shaping flag", async () => {
    const options = await capturePersistentOptions({});
    expect(options).not.toHaveProperty("args");
    expect(options).not.toHaveProperty("userAgent");
    expect(JSON.stringify(options)).not.toContain("AutomationControlled");
  });

  it("keeps Playwright's default switch for BROWX_AUTOMATION_SWITCH=1", async () => {
    process.env.BROWX_AUTOMATION_SWITCH = "1";
    expect(await capturePersistentOptions({})).not.toHaveProperty("ignoreDefaultArgs");
    expect(await captureEphemeralLaunchOptions({})).not.toHaveProperty("ignoreDefaultArgs");
  });
});

describe("chromium engine — background-throttling flags", () => {
  it('emits the three flags on the persistent launch for "disabled"', async () => {
    const options = await capturePersistentOptions({ backgroundThrottling: "disabled" });
    expect(options.args).toEqual([
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ]);
  });

  it('emits the three flags on the ephemeral launch for "disabled"', async () => {
    const launchOptions = await captureEphemeralLaunchOptions({
      backgroundThrottling: "disabled",
    });
    expect(launchOptions.args).toEqual([
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ]);
  });

  it('emits no args for "default" or when unset', async () => {
    expect(await capturePersistentOptions({ backgroundThrottling: "default" })).not.toHaveProperty(
      "args",
    );
    expect(await capturePersistentOptions({})).not.toHaveProperty("args");
    expect(await captureEphemeralLaunchOptions({})).not.toHaveProperty("args");
  });
});

describe("chromium engine — extension + web-security launch args", () => {
  it("reaches the persistent launch (the shared options bag carries no args of its own)", async () => {
    const options = await capturePersistentOptions({
      disableWebSecurity: true,
      extensionPaths: ["/tmp/ext-a"],
    });
    expect(options.args).toEqual([
      "--disable-web-security",
      "--disable-site-isolation-trials",
      "--disable-extensions-except=/tmp/ext-a",
      "--load-extension=/tmp/ext-a",
    ]);
  });
});
