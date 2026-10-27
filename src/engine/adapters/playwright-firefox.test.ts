import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  PlaywrightFirefoxAdapter,
  firefoxChannelFromEnv,
  MOZ_FIREFOX_CHANNEL,
} from "./playwright-firefox.js";

const browserType = vi.hoisted(() => ({
  launch: vi.fn(),
  launchPersistentContext: vi.fn(),
}));
vi.mock("../select.js", () => ({ resolveBrowserType: () => browserType }));

// The launch/attach methods drive a real browser and are exercised by the
// Firefox keystone lane (real-Firefox). Here we assert the adapter's pure
// declarative surface — that it tags itself firefox, declares NO deep escape
// hatch, refuses CDP-attach structurally (Firefox speaks BiDi/Juggler, not
// CDP), and resolves the experimental moz-firefox BiDi channel flag.
describe("PlaywrightFirefoxAdapter — declarative surface", () => {
  it("refuses CDP-attach structurally (firefox-attach-not-supported)", async () => {
    const adapter = new PlaywrightFirefoxAdapter();
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(
      /firefox-attach-not-supported/,
    );
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(/WebDriver BiDi/);
  });
});

describe("firefoxChannelFromEnv — the moz-firefox BiDi flag (Juggler vs BiDi two-track)", () => {
  it("returns undefined for the default Juggler lane (flag unset)", () => {
    expect(firefoxChannelFromEnv({})).toBeUndefined();
    expect(firefoxChannelFromEnv({ BROWX_FIREFOX_CHANNEL: "" })).toBeUndefined();
  });

  it("selects the moz-firefox channel when the flag is set to it", () => {
    expect(firefoxChannelFromEnv({ BROWX_FIREFOX_CHANNEL: MOZ_FIREFOX_CHANNEL })).toBe(
      MOZ_FIREFOX_CHANNEL,
    );
  });

  it("rejects an unknown channel value loudly (no silent fallback)", () => {
    expect(() => firefoxChannelFromEnv({ BROWX_FIREFOX_CHANNEL: "bidi" })).toThrow(
      /unknown value "bidi"/,
    );
  });
});

const MISSING = new Error("browserType.launch: Executable doesn't exist at /x/firefox");
const OTHER = new Error("browserType.launch: Target page, context or browser has been closed");
const HINT =
  /\nbrowxai: firefox is not downloaded\. Run `npx playwright-core(@[\d.]+)? install firefox`\.$/;
const EPHEMERAL = { launchOptions: {}, contextOptions: {} };
const PERSISTENT = { profileDir: "/p", options: {} };

const failure = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => undefined,
    (e: unknown) => e,
  );

describe("PlaywrightFirefoxAdapter — missing browser", () => {
  beforeEach(() => {
    browserType.launch.mockReset();
    browserType.launchPersistentContext.mockReset();
  });

  it("adds the pinned install command to an ephemeral launch that finds no browser", async () => {
    browserType.launch.mockRejectedValue(MISSING);
    const err = (await failure(() =>
      new PlaywrightFirefoxAdapter().launchEphemeral(EPHEMERAL),
    )) as Error;
    expect(err.message.startsWith(MISSING.message)).toBe(true);
    expect(err.message).toMatch(HINT);
    expect(err.cause).toBe(MISSING);
  });

  it("adds the pinned install command to a persistent launch that finds no browser", async () => {
    browserType.launchPersistentContext.mockRejectedValue(MISSING);
    const err = (await failure(() =>
      new PlaywrightFirefoxAdapter().launchPersistent(PERSISTENT),
    )) as Error;
    expect(err.message).toMatch(HINT);
    expect(err.cause).toBe(MISSING);
  });

  it("passes any other launch error through unchanged", async () => {
    browserType.launch.mockRejectedValue(OTHER);
    browserType.launchPersistentContext.mockRejectedValue(OTHER);
    expect(await failure(() => new PlaywrightFirefoxAdapter().launchEphemeral(EPHEMERAL))).toBe(
      OTHER,
    );
    expect(await failure(() => new PlaywrightFirefoxAdapter().launchPersistent(PERSISTENT))).toBe(
      OTHER,
    );
  });
});

describe("PlaywrightFirefoxAdapter — missing stock Firefox", () => {
  beforeEach(() => {
    browserType.launch.mockReset();
    browserType.launchPersistentContext.mockReset();
  });

  it("adds no install command on the moz-firefox channel", async () => {
    browserType.launch.mockRejectedValue(MISSING);
    browserType.launchPersistentContext.mockRejectedValue(MISSING);
    const adapter = new PlaywrightFirefoxAdapter({ channel: MOZ_FIREFOX_CHANNEL });
    expect(await failure(() => adapter.launchEphemeral(EPHEMERAL))).toBe(MISSING);
    expect(await failure(() => adapter.launchPersistent(PERSISTENT))).toBe(MISSING);
    expect(browserType.launch).toHaveBeenCalledWith({ channel: MOZ_FIREFOX_CHANNEL });
  });
});
