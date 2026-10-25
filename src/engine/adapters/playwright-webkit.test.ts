import { beforeEach, describe, it, expect, vi } from "vitest";
import { PlaywrightWebKitAdapter } from "./playwright-webkit.js";

const browserType = vi.hoisted(() => ({
  launch: vi.fn(),
  launchPersistentContext: vi.fn(),
}));
vi.mock("../select.js", () => ({ resolveBrowserType: () => browserType }));

// The launch/attach methods drive a real browser and are exercised by the WebKit
// keystone lane (real-WebKit). Here we assert the adapter's pure declarative
// surface — that it tags itself webkit, declares NO deep escape hatch (WebKit has
// no CDP at all), and refuses attach structurally because there is no CDP/BiDi
// attach client for WebKit/Safari.
describe("PlaywrightWebKitAdapter — declarative surface", () => {
  it("refuses attach structurally (webkit-attach-not-supported)", async () => {
    const adapter = new PlaywrightWebKitAdapter();
    await expect(adapter.attach("http://127.0.0.1:9222")).rejects.toThrow(
      /webkit-attach-not-supported/,
    );
  });
});

const MISSING = new Error("browserType.launch: Executable doesn't exist at /x/webkit");
const OTHER = new Error("browserType.launch: Target page, context or browser has been closed");
const HINT =
  /\nbrowxai: webkit is not downloaded\. Run `npx playwright-core(@[\d.]+)? install webkit`\.$/;
const EPHEMERAL = { launchOptions: {}, contextOptions: {} };
const PERSISTENT = { profileDir: "/p", options: {} };

const failure = async (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => undefined,
    (e: unknown) => e,
  );

describe("PlaywrightWebKitAdapter — missing browser", () => {
  beforeEach(() => {
    browserType.launch.mockReset();
    browserType.launchPersistentContext.mockReset();
  });

  it("adds the pinned install command to an ephemeral launch that finds no browser", async () => {
    browserType.launch.mockRejectedValue(MISSING);
    const err = (await failure(() =>
      new PlaywrightWebKitAdapter().launchEphemeral(EPHEMERAL),
    )) as Error;
    expect(err.message.startsWith(MISSING.message)).toBe(true);
    expect(err.message).toMatch(HINT);
    expect(err.cause).toBe(MISSING);
  });

  it("adds the pinned install command to a persistent launch that finds no browser", async () => {
    browserType.launchPersistentContext.mockRejectedValue(MISSING);
    const err = (await failure(() =>
      new PlaywrightWebKitAdapter().launchPersistent(PERSISTENT),
    )) as Error;
    expect(err.message).toMatch(HINT);
    expect(err.cause).toBe(MISSING);
  });

  it("passes any other launch error through unchanged", async () => {
    browserType.launch.mockRejectedValue(OTHER);
    browserType.launchPersistentContext.mockRejectedValue(OTHER);
    expect(await failure(() => new PlaywrightWebKitAdapter().launchEphemeral(EPHEMERAL))).toBe(
      OTHER,
    );
    expect(await failure(() => new PlaywrightWebKitAdapter().launchPersistent(PERSISTENT))).toBe(
      OTHER,
    );
  });
});
