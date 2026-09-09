import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineEntry } from "../registry.js";
import { PlaywrightChromiumAdapter } from "./playwright-chromium.js";
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

describe("chromium engine — channel passthrough", () => {
  it("threads `channel` into the persistent launch when set", async () => {
    const options = await capturePersistentOptions({ channel: "chrome" });
    expect(options.channel).toBe("chrome");
  });

  it("threads `channel` into the ephemeral launch when set", async () => {
    const launchOptions = await captureEphemeralLaunchOptions({ channel: "msedge" });
    expect(launchOptions.channel).toBe("msedge");
  });

  it("omits `channel` entirely when unset, so the bundled build launches", async () => {
    expect(await capturePersistentOptions({})).not.toHaveProperty("channel");
    expect(await captureEphemeralLaunchOptions({})).not.toHaveProperty("channel");
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
