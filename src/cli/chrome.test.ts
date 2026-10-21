import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

const spawnMock = vi.hoisted(() =>
  vi.fn((..._a: unknown[]) => ({ pid: 4242, unref: () => undefined })),
);
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
const installed: { path: string | undefined } = vi.hoisted(() => ({
  path: "/fake/google-chrome",
}));
vi.mock("./chrome-launch.js", async (orig) => ({
  ...(await orig<typeof import("./chrome-launch.js")>()),
  findInstalledChrome: () => installed.path,
}));

import { runChrome } from "./chrome.js";

let root: string;
let saved: string | undefined;
let out = "";
let err = "";

beforeEach(() => {
  saved = process.env.BROWX_WORKSPACE;
  root = mkdtempSync(join(tmpdir(), "browxai-chrome-cli-"));
  process.env.BROWX_WORKSPACE = root;
  delete process.env.BROWX_DEFAULT_PROFILE;
  installed.path = "/fake/google-chrome";
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => ({ pid: 4242, unref: () => undefined }));
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.BROWX_WORKSPACE;
  else process.env.BROWX_WORKSPACE = saved;
  rmSync(root, { recursive: true, force: true });
});

const spawnedArgs = (): string[] => spawnMock.mock.calls[0]![1] as string[];
const lockProfile = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
};

describe("browxai chrome start", () => {
  it("launches the installed Chrome on the workspace default profile with a debug port", async () => {
    expect(await runChrome(["start"])).toBe(0);
    expect(spawnMock.mock.calls[0]![0]).toBe("/fake/google-chrome");
    expect(spawnedArgs()).toContain("--remote-debugging-port=9222");
    expect(spawnedArgs()).toContain(`--user-data-dir=${join(root, "profile")}`);
  });

  it("uses profiles/<name> for --profile", async () => {
    expect(await runChrome(["start", "--profile", "work", "--port", "9333"])).toBe(0);
    expect(spawnedArgs()).toContain(`--user-data-dir=${join(root, "profiles", "work")}`);
    expect(spawnedArgs()).toContain("--remote-debugging-port=9333");
  });

  it("refuses a profile that another Chrome holds, and --force overrides", async () => {
    lockProfile(join(root, "profile"));
    expect(await runChrome(["start"])).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(err).toContain(join(root, "profile"));
    expect(err).toContain("--force");
    expect(await runChrome(["start", "--force"])).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when Google Chrome is not installed, without falling back to Chromium", async () => {
    installed.path = undefined;
    expect(await runChrome(["start"])).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(err).toMatch(/no installed Google Chrome/);
  });

  it("rejects a --profile that is a path", async () => {
    expect(await runChrome(["start", "--profile", "../escape"])).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("browxai chrome login", () => {
  it("launches the same Chrome and profile with no debug port and says to quit it", async () => {
    expect(await runChrome(["login", "--url", "https://example.com/"])).toBe(0);
    expect(spawnedArgs().some((a) => a.startsWith("--remote-debugging"))).toBe(false);
    expect(spawnedArgs()).toContain(`--user-data-dir=${join(root, "profile")}`);
    expect(spawnedArgs()).toContain("https://example.com/");
    expect(out).toMatch(/QUIT this Chrome/);
  });

  it("refuses a held profile and a non-http URL", async () => {
    lockProfile(join(root, "profiles", "work"));
    expect(await runChrome(["login", "--profile", "work"])).toBe(1);
    expect(await runChrome(["login", "--url", "file:///etc/passwd"])).toBe(2);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
