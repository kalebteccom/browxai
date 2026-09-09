import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backgroundThrottlingArgs,
  buildIncognitoLaunchOptions,
  buildManagedLaunch,
  chromiumChannelOption,
} from "./launch-options.js";

// buildManagedLaunch resolves the workspace (and creates it) to derive the
// default profile dir, so the suite pins it away from the real ~/.browxai.
let workspaceRoot: string;
let originalWorkspace: string | undefined;

beforeAll(() => {
  originalWorkspace = process.env.BROWX_WORKSPACE;
  workspaceRoot = mkdtempSync(join(tmpdir(), "browxai-launch-options-"));
  process.env.BROWX_WORKSPACE = workspaceRoot;
});

afterAll(() => {
  if (originalWorkspace === undefined) delete process.env.BROWX_WORKSPACE;
  else process.env.BROWX_WORKSPACE = originalWorkspace;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

const BACKGROUND_FLAGS = [
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

describe("backgroundThrottlingArgs", () => {
  it('emits the three lifecycle flags for "disabled"', () => {
    expect(backgroundThrottlingArgs({ backgroundThrottling: "disabled" })).toEqual(
      BACKGROUND_FLAGS,
    );
  });

  it('emits nothing for "default"', () => {
    expect(backgroundThrottlingArgs({ backgroundThrottling: "default" })).toEqual([]);
  });

  it("emits nothing when unset", () => {
    expect(backgroundThrottlingArgs({})).toEqual([]);
  });
});

describe("buildManagedLaunch — background-throttling flags", () => {
  it('carries the three flags on chromiumArgs for "disabled"', () => {
    const { chromiumArgs } = buildManagedLaunch("chromium", {
      backgroundThrottling: "disabled",
    });
    expect(chromiumArgs).toEqual(BACKGROUND_FLAGS);
  });

  it("carries no args when unset", () => {
    expect(buildManagedLaunch("chromium", {}).chromiumArgs).toEqual([]);
  });

  it("keeps the flags out of the shared context options bag", () => {
    const { options } = buildManagedLaunch("chromium", { backgroundThrottling: "disabled" });
    expect(options).not.toHaveProperty("args");
    expect(options).not.toHaveProperty("channel");
  });
});

describe("buildIncognitoLaunchOptions — background-throttling flags", () => {
  it('splices the three flags for "disabled"', () => {
    expect(
      buildIncognitoLaunchOptions("chromium", { backgroundThrottling: "disabled" }).args,
    ).toEqual(BACKGROUND_FLAGS);
  });

  it("appends them after the web-security flags without displacing them", () => {
    const { args } = buildIncognitoLaunchOptions("chromium", {
      disableWebSecurity: true,
      backgroundThrottling: "disabled",
    });
    expect(args).toEqual([
      "--disable-web-security",
      "--disable-site-isolation-trials",
      ...BACKGROUND_FLAGS,
    ]);
  });

  it("omits `args` entirely when unset", () => {
    expect(buildIncognitoLaunchOptions("chromium", {})).not.toHaveProperty("args");
  });

  it('omits `args` for "default"', () => {
    expect(
      buildIncognitoLaunchOptions("chromium", { backgroundThrottling: "default" }),
    ).not.toHaveProperty("args");
  });
});

describe("chromiumChannelOption", () => {
  it("threads the channel through when set", () => {
    expect(chromiumChannelOption({ channel: "chrome" })).toEqual({ channel: "chrome" });
    expect(chromiumChannelOption({ channel: "msedge" })).toEqual({ channel: "msedge" });
  });

  it("is absent when unset, so the launch keeps the bundled build", () => {
    expect(chromiumChannelOption({})).not.toHaveProperty("channel");
    expect(chromiumChannelOption({})).toEqual({});
  });

  it('is absent for an empty string (no `channel: ""` reaching Playwright)', () => {
    expect(chromiumChannelOption({ channel: "" })).not.toHaveProperty("channel");
  });
});
