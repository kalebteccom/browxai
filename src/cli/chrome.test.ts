import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

// The process lookup `chrome stop` makes before signalling: the test sets the
// command line the PID reports.
// `later` holds the answers for the lookups after the first, in order, for a
// PID whose owner changes while `stop` waits.
const proc = vi.hoisted(() => ({
  commandLine: undefined as string | undefined,
  later: [] as Array<string | undefined>,
  calls: 0,
}));
vi.mock("./chrome-process.js", async (orig) => ({
  ...(await orig<typeof import("./chrome-process.js")>()),
  processCommandLine: () => {
    proc.calls += 1;
    return proc.calls > 1 && proc.later.length > 0 ? proc.later.shift() : proc.commandLine;
  },
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
  proc.commandLine = undefined;
  proc.later = [];
  proc.calls = 0;
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

  it("records the profile directory next to chrome.pid", async () => {
    expect(await runChrome(["start"])).toBe(0);
    expect(readFileSync(join(root, "chrome.pid"), "utf8")).toBe("4242");
    expect(readFileSync(join(root, "chrome.profile"), "utf8")).toBe(join(root, "profile"));
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

  it.each(["abc", "0", "65536", "-1", "9222.5", ""])(
    "rejects --port %j with exit code 2 and launches nothing",
    async (value) => {
      expect(await runChrome(["start", "--port", value])).toBe(2);
      expect(spawnMock).not.toHaveBeenCalled();
      expect(err).toContain("invalid --port");
    },
  );

  it("rejects --port with no value", async () => {
    expect(await runChrome(["start", "--port"])).toBe(2);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(err).toContain("invalid --port");
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

describe("browxai chrome stop", () => {
  const PID = 4242;
  const chromeOn = (dir: string): string =>
    `/opt/google/chrome/chrome --remote-debugging-port=9222 --user-data-dir=${dir}`;
  let alive: boolean;
  let survivesTerm: boolean;
  let signals: Array<string | number | undefined>;
  const pidFile = (): string => join(root, "chrome.pid");
  const profileFile = (): string => join(root, "chrome.profile");

  beforeEach(() => {
    writeFileSync(pidFile(), String(PID));
    writeFileSync(profileFile(), join(root, "profiles", "work"));
    alive = true;
    survivesTerm = false;
    signals = [];
    const gone = (): never => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: string | number) => {
      if (pid !== PID) return gone();
      signals.push(sig);
      if (sig === 0) return alive ? true : gone();
      if (sig === "SIGTERM" && survivesTerm) return true;
      alive = false;
      return true;
    });
  });

  it("stops a Chrome running on the recorded profile and removes both files", async () => {
    proc.commandLine = chromeOn(join(root, "profiles", "work"));
    expect(await runChrome(["stop"])).toBe(0);
    expect(signals).toContain("SIGTERM");
    expect(existsSync(pidFile())).toBe(false);
    expect(existsSync(profileFile())).toBe(false);
  });

  it("sends no signal to a process that is not Chrome", async () => {
    proc.commandLine = "/usr/bin/vim notes.txt";
    expect(await runChrome(["stop"])).toBe(1);
    expect(signals.every((s) => s === 0)).toBe(true);
    expect(existsSync(pidFile())).toBe(true);
    expect(err).toMatch(/not stopping pid 4242/);
  });

  it("sends no signal to a Chrome on another profile directory", async () => {
    proc.commandLine = chromeOn("/home/someone/.config/google-chrome");
    expect(await runChrome(["stop"])).toBe(1);
    expect(signals.every((s) => s === 0)).toBe(true);
    expect(err).toContain(`--user-data-dir=${join(root, "profiles", "work")}`);
    expect(existsSync(pidFile())).toBe(true);
  });

  it("refuses a Chrome whose profile directory only starts with the recorded one", async () => {
    proc.commandLine = chromeOn(join(root, "profiles", "work-other"));
    expect(await runChrome(["stop"])).toBe(1);
    expect(signals.every((s) => s === 0)).toBe(true);
  });

  it("expects the workspace default profile when chrome.profile is absent", async () => {
    rmSync(profileFile());
    proc.commandLine = chromeOn(join(root, "profile"));
    expect(await runChrome(["stop"])).toBe(0);
    expect(signals).toContain("SIGTERM");
  });

  it("refuses a Chrome on another profile when chrome.profile is absent", async () => {
    rmSync(profileFile());
    proc.commandLine = chromeOn(join(root, "profiles", "work"));
    expect(await runChrome(["stop"])).toBe(1);
    expect(signals.every((s) => s === 0)).toBe(true);
  });

  it("sends no signal when the command line cannot be read", async () => {
    proc.commandLine = undefined;
    expect(await runChrome(["stop"])).toBe(1);
    expect(signals.every((s) => s === 0)).toBe(true);
    expect(err).toMatch(/could not be read/);
  });

  it("sends SIGKILL to a Chrome that outlives SIGTERM and still reads as that Chrome", async () => {
    proc.commandLine = chromeOn(join(root, "profiles", "work"));
    survivesTerm = true;
    expect(await runChrome(["stop"])).toBe(0);
    expect(signals).toContain("SIGKILL");
  });

  it("checks the command line again and skips SIGKILL when the PID changed owner", async () => {
    proc.commandLine = chromeOn(join(root, "profiles", "work"));
    proc.later = ["/usr/bin/vim notes.txt"];
    survivesTerm = true;
    expect(await runChrome(["stop"])).toBe(0);
    expect(signals).toContain("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
    expect(err).toMatch(/not sending SIGKILL/);
  });
});
