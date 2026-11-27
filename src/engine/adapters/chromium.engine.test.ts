import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineEntry } from "../registry.js";
import { PlaywrightChromiumAdapter } from "./playwright-chromium.js";
import { log } from "../../util/logging.js";
import { resetSandboxState, sandboxProbe } from "../../session/chromium-sandbox-launch.js";
import "./chromium.engine.js";

// The launch itself is the keystone lane's job (real Chromium). Here the two
// adapter entry points are stubbed to capture the spec they are handed, so the
// option-threading — which flags and which `channel` reach Playwright — is
// asserted without a browser.
const LAUNCH_STUBBED = new Error("launch stubbed");
// A second `vi.spyOn` on a method that is already spied returns the same mock, and its
// calls accumulate. The two capture helpers clear it first, so `calls[0]` is always the
// launch they just made.

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
    .mockClear()
    .mockRejectedValue(LAUNCH_STUBBED);
  await expect(engineEntry("chromium").makeAdapter(opts)).rejects.toThrow(LAUNCH_STUBBED);
  return spy.mock.calls[0]![0].options as unknown as Record<string, unknown>;
}

async function captureEphemeralLaunchOptions(
  opts: Parameters<ReturnType<typeof engineEntry>["makeAdapter"]>[0],
): Promise<Record<string, unknown>> {
  const spy = vi
    .spyOn(PlaywrightChromiumAdapter.prototype, "launchEphemeral")
    .mockClear()
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

  it("refuses an extension launch with no channel before launching anything", async () => {
    const spy = vi.spyOn(PlaywrightChromiumAdapter.prototype, "launchPersistent");
    await expect(
      engineEntry("chromium").makeAdapter({ extensionPaths: ["/tmp/ext-a"] }),
    ).rejects.toThrow(/^extensions-need-chromium: /);
    expect(spy).not.toHaveBeenCalled();
  });

  it("launches an extension session on the bundled build when it opted in", async () => {
    const options = await capturePersistentOptions({
      extensionPaths: ["/tmp/ext-a"],
      channel: "chromium",
    });
    expect(options).not.toHaveProperty("channel");
  });

  it("refuses with chrome-not-installed when the default Chrome is missing, with no second launch", async () => {
    const notFound = new Error(
      "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
    );
    const spy = vi
      .spyOn(PlaywrightChromiumAdapter.prototype, "launchPersistent")
      .mockRejectedValue(notFound);
    await expect(engineEntry("chromium").makeAdapter({})).rejects.toThrow(
      /^chrome-not-installed: /,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].options).toHaveProperty("channel", "chrome");
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

describe("chromium engine — OS sandbox", () => {
  // Playwright adds --no-sandbox to every Chromium it launches unless a launch
  // passes `chromiumSandbox: true`. browxai passes that option or nothing, never a
  // sandbox flag of its own, and the mode (`auto` unless the session says otherwise)
  // decides which. The probe is replaced so each case describes its own host. The
  // Woodpecker lane runs the gate in containers as root, so without it `auto` would
  // always take the no-sandbox branch there and keep the old launch. The release
  // workflow's keystone run is non-root on ubuntu-latest with no container, so there
  // `auto` tries the sandbox or skips it on the host's AppArmor and user-namespace facts.
  // The threat model, the README and the containers guide describe this contract.
  // If this test changes, update those three in the same change.
  const NORMAL_USER = {
    platform: "linux",
    uid: 1000,
    maxUserNamespaces: 63000,
    unprivilegedUsernsClone: 1,
    apparmorRestrictUserns: 0,
  } as const;
  const SANDBOX_ERROR = new Error(
    "browserType.launchPersistentContext: Target closed\nBrowser logs:\n\nChromium sandboxing failed!",
  );
  const warnings = (spy: { mock: { calls: unknown[][] } }): string[] =>
    spy.mock.calls.map((c) => String(c[0]));

  const spyOnLaunch = (method: "launchPersistent" | "launchEphemeral") =>
    vi.spyOn(
      PlaywrightChromiumAdapter.prototype as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >,
      method,
    );
  const modeFor = (method: "launchPersistent" | "launchEphemeral") =>
    method === "launchEphemeral" ? ("incognito" as const) : ("managed" as const);

  beforeEach(() => {
    resetSandboxState();
    vi.spyOn(log, "info").mockImplementation(() => undefined);
  });

  const launches = [
    {
      label: "persistent",
      capture: (opts: Parameters<typeof capturePersistentOptions>[0]) =>
        capturePersistentOptions(opts),
      method: "launchPersistent" as const,
      optionsOf: (call: unknown) => (call as [{ options: Record<string, unknown> }])[0].options,
    },
    {
      label: "ephemeral",
      capture: (opts: Parameters<typeof capturePersistentOptions>[0]) =>
        captureEphemeralLaunchOptions(opts),
      method: "launchEphemeral" as const,
      optionsOf: (call: unknown) =>
        (call as [{ launchOptions: Record<string, unknown> }])[0].launchOptions,
    },
  ];

  describe.each(launches)("$label launch", ({ capture, method, optionsOf }) => {
    it("auto on a normal user's host passes chromiumSandbox: true", async () => {
      vi.spyOn(sandboxProbe, "gather").mockReturnValue(NORMAL_USER);
      expect((await capture({})).chromiumSandbox).toBe(true);
    });

    it("auto as root passes no chromiumSandbox and warns once", async () => {
      vi.spyOn(sandboxProbe, "gather").mockReturnValue({ ...NORMAL_USER, uid: 0 });
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const options = await capture({});
      expect(options.chromiumSandbox).not.toBe(true);
      expect(options).not.toHaveProperty("chromiumSandbox");
      await capture({});
      const sandboxWarnings = warnings(warn).filter((w) => w.includes("OS sandbox is off"));
      expect(sandboxWarnings).toHaveLength(1);
      expect(sandboxWarnings[0]).toContain("BROWX_CHROMIUM_SANDBOX=on");
    });

    it("on passes chromiumSandbox: true even as root", async () => {
      vi.spyOn(sandboxProbe, "gather").mockReturnValue({ ...NORMAL_USER, uid: 0 });
      expect((await capture({ chromiumSandbox: "on" })).chromiumSandbox).toBe(true);
    });

    it("off passes no chromiumSandbox on a host that supports it", async () => {
      vi.spyOn(sandboxProbe, "gather").mockReturnValue(NORMAL_USER);
      expect(await capture({ chromiumSandbox: "off" })).not.toHaveProperty("chromiumSandbox");
    });

    it("adds no sandbox flag to the launch args in any mode", async () => {
      vi.spyOn(sandboxProbe, "gather").mockReturnValue(NORMAL_USER);
      for (const chromiumSandbox of ["auto", "on", "off"] as const) {
        const options = await capture({
          chromiumSandbox,
          disableWebSecurity: true,
          backgroundThrottling: "disabled",
        });
        expect(JSON.stringify(options.args ?? [])).not.toMatch(/sandbox/);
      }
    });

    it("auto retries once without the sandbox on a sandbox failure, and warns", async () => {
      vi.spyOn(sandboxProbe, "gather").mockReturnValue(NORMAL_USER);
      const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const spy = spyOnLaunch(method)
        .mockRejectedValueOnce(SANDBOX_ERROR)
        .mockRejectedValueOnce(LAUNCH_STUBBED);
      await expect(
        engineEntry("chromium").makeAdapter({ launchMode: modeFor(method) }),
      ).rejects.toThrow(LAUNCH_STUBBED);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(optionsOf(spy.mock.calls[0]).chromiumSandbox).toBe(true);
      expect(optionsOf(spy.mock.calls[1])).not.toHaveProperty("chromiumSandbox");
      expect(warnings(warn).some((w) => w.includes("Chromium sandboxing failed"))).toBe(true);
    });

    it("auto does not retry a failure that is not about the sandbox", async () => {
      vi.spyOn(sandboxProbe, "gather").mockReturnValue(NORMAL_USER);
      const spy = spyOnLaunch(method).mockRejectedValue(LAUNCH_STUBBED);
      await expect(
        engineEntry("chromium").makeAdapter({ launchMode: modeFor(method) }),
      ).rejects.toThrow(LAUNCH_STUBBED);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("auto gives up after one retry when the second launch fails on the sandbox too", async () => {
      vi.spyOn(sandboxProbe, "gather").mockReturnValue(NORMAL_USER);
      vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const spy = spyOnLaunch(method).mockRejectedValue(SANDBOX_ERROR);
      await expect(
        engineEntry("chromium").makeAdapter({ launchMode: modeFor(method) }),
      ).rejects.toThrow(SANDBOX_ERROR);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("on fails with the fix named and does not retry", async () => {
      const spy = spyOnLaunch(method).mockRejectedValue(SANDBOX_ERROR);
      await expect(
        engineEntry("chromium").makeAdapter({
          chromiumSandbox: "on",
          launchMode: modeFor(method),
        }),
      ).rejects.toThrow(/BROWX_CHROMIUM_SANDBOX=off/);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("tries the default installed Chrome on AppArmor-restricted facts, and skips the bundled build", async () => {
    vi.spyOn(sandboxProbe, "gather").mockReturnValue({ ...NORMAL_USER, apparmorRestrictUserns: 1 });
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    expect((await capturePersistentOptions({})).chromiumSandbox).toBe(true);
    expect((await captureEphemeralLaunchOptions({})).chromiumSandbox).toBe(true);
    const bundled = await capturePersistentOptions({ channel: "chromium" });
    expect(bundled).not.toHaveProperty("chromiumSandbox");
    const bundledEphemeral = await captureEphemeralLaunchOptions({ channel: "chromium" });
    expect(bundledEphemeral).not.toHaveProperty("chromiumSandbox");
  });

  it("names the saved layer when an on launch from config fails", async () => {
    const spy = spyOnLaunch("launchPersistent").mockRejectedValue(SANDBOX_ERROR);
    await expect(
      engineEntry("chromium").makeAdapter({
        chromiumSandbox: "on",
        chromiumSandboxSource: "project",
      }),
    ).rejects.toThrow(/Remove chromiumSandbox from the project layer of config\.json/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("on with a named Chrome that is not installed rethrows the not-found error unchanged and does not retry", async () => {
    const notFound = new Error(
      "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
    );
    const spy = spyOnLaunch("launchPersistent").mockRejectedValue(notFound);
    await expect(
      engineEntry("chromium").makeAdapter({ chromiumSandbox: "on", channel: "chrome" }),
    ).rejects.toBe(notFound);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ options: { chromiumSandbox: true } });
  });

  it("refuses a missing default Chrome under auto without a sandbox retry", async () => {
    vi.spyOn(sandboxProbe, "gather").mockReturnValue(NORMAL_USER);
    const notFound = new Error(
      "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
    );
    const spy = vi
      .spyOn(PlaywrightChromiumAdapter.prototype, "launchPersistent")
      .mockRejectedValue(notFound);
    await expect(engineEntry("chromium").makeAdapter({})).rejects.toThrow(
      /^chrome-not-installed: /,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].options).toHaveProperty("chromiumSandbox", true);
  });
});

describe("chromium engine — background-throttling flags", () => {
  it.each([
    {
      label: "persistent",
      capture: (opts: Parameters<typeof capturePersistentOptions>[0]) =>
        capturePersistentOptions(opts).then((o) => o.args),
    },
    {
      label: "ephemeral",
      capture: (opts: Parameters<typeof capturePersistentOptions>[0]) =>
        captureEphemeralLaunchOptions(opts).then((o) => o.args),
    },
  ])('emits the three flags on the $label launch for "disabled"', async ({ capture }) => {
    expect(await capture({ backgroundThrottling: "disabled" })).toEqual([
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
      channel: "chromium",
    });
    expect(options.args).toEqual([
      "--disable-web-security",
      "--disable-site-isolation-trials",
      "--disable-extensions-except=/tmp/ext-a",
      "--load-extension=/tmp/ext-a",
    ]);
  });
});
