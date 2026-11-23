import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { log } from "../util/logging.js";
import {
  decideSandbox,
  gatherSandboxFacts,
  isSandboxFailure,
  launchWithSandboxPlan,
  resetSandboxState,
  sandboxProbe,
  type SandboxFacts,
  type SandboxIo,
  type SandboxLaunchOption,
  type SandboxVerdict,
} from "./chromium-sandbox-launch.js";

const linuxUser: SandboxFacts = {
  platform: "linux",
  uid: 1000,
  maxUserNamespaces: 63000,
  unprivilegedUsernsClone: 1,
  apparmorRestrictUserns: 0,
};

interface DecideCase {
  name: string;
  facts: SandboxFacts;
  sandbox: boolean;
  verdict: SandboxVerdict;
}

describe("decideSandbox", () => {
  it.each<DecideCase>([
    { name: "a normal Linux user", facts: linuxUser, sandbox: true, verdict: "supported" },
    {
      name: "a Linux user whose kernel files are absent",
      facts: { platform: "linux", uid: 1000 } satisfies SandboxFacts,
      sandbox: true,
      verdict: "supported",
    },
    {
      name: "root on Linux",
      facts: { ...linuxUser, uid: 0 },
      sandbox: false,
      verdict: "root",
    },
    {
      name: "root on macOS",
      facts: { platform: "darwin", uid: 0 } satisfies SandboxFacts,
      sandbox: false,
      verdict: "root",
    },
    {
      name: "a container, non-root",
      facts: { ...linuxUser, container: "/.dockerenv exists" },
      sandbox: false,
      verdict: "container",
    },
    {
      name: "no user namespaces (max_user_namespaces 0)",
      facts: { ...linuxUser, maxUserNamespaces: 0 },
      sandbox: false,
      verdict: "no-userns",
    },
    {
      name: "unprivileged_userns_clone 0",
      facts: { ...linuxUser, unprivilegedUsernsClone: 0 },
      sandbox: false,
      verdict: "no-userns",
    },
    {
      name: "an AppArmor policy that restricts user namespaces",
      facts: { ...linuxUser, apparmorRestrictUserns: 1 },
      sandbox: false,
      verdict: "apparmor",
    },
    {
      name: "macOS, normal user",
      facts: { platform: "darwin", uid: 501 } satisfies SandboxFacts,
      sandbox: true,
      verdict: "supported",
    },
    {
      name: "Windows (no uid)",
      facts: { platform: "win32", uid: undefined } satisfies SandboxFacts,
      sandbox: true,
      verdict: "supported",
    },
  ])("$name", ({ facts, sandbox, verdict }) => {
    const decision = decideSandbox(facts);
    expect(decision.sandbox).toBe(sandbox);
    expect(decision.verdict).toBe(verdict);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it.each<DecideCase>([
    {
      name: "AppArmor-restricted user namespaces (stock Ubuntu 24.04)",
      facts: { ...linuxUser, apparmorRestrictUserns: 1 },
      sandbox: true,
      verdict: "supported",
    },
    {
      name: "no user namespaces (max_user_namespaces 0)",
      facts: { ...linuxUser, maxUserNamespaces: 0 },
      sandbox: true,
      verdict: "supported",
    },
    {
      name: "unprivileged_userns_clone 0",
      facts: { ...linuxUser, unprivilegedUsernsClone: 0 },
      sandbox: true,
      verdict: "supported",
    },
    {
      name: "root",
      facts: { ...linuxUser, uid: 0 },
      sandbox: false,
      verdict: "root",
    },
    {
      name: "a container",
      facts: { ...linuxUser, container: "/.dockerenv exists" },
      sandbox: false,
      verdict: "container",
    },
  ])("for an installed channel, $name gives sandbox=$sandbox", ({ facts, sandbox, verdict }) => {
    const decision = decideSandbox(facts, "installed");
    expect(decision.sandbox).toBe(sandbox);
    expect(decision.verdict).toBe(verdict);
  });

  it("skips the bundled build on the same user-namespace facts", () => {
    for (const facts of [
      { ...linuxUser, apparmorRestrictUserns: 1 },
      { ...linuxUser, maxUserNamespaces: 0 },
      { ...linuxUser, unprivilegedUsernsClone: 0 },
    ]) {
      expect(decideSandbox(facts, "bundled").sandbox).toBe(false);
      expect(decideSandbox(facts).sandbox).toBe(false);
    }
  });

  it("reports root before a container or a missing user namespace", () => {
    const decision = decideSandbox({
      ...linuxUser,
      uid: 0,
      container: "/.dockerenv exists",
      maxUserNamespaces: 0,
    });
    expect(decision.verdict).toBe("root");
  });

  it("ignores Linux-only facts on another platform", () => {
    const decision = decideSandbox({
      platform: "darwin",
      uid: 501,
      container: "/.dockerenv exists",
      maxUserNamespaces: 0,
    });
    expect(decision.sandbox).toBe(true);
  });
});

function fakeIo(over: {
  platform?: NodeJS.Platform;
  uid?: number | undefined;
  files?: Record<string, string>;
}): SandboxIo {
  const files = over.files ?? {};
  return {
    platform: over.platform ?? "linux",
    uid: () => ("uid" in over ? over.uid : 1000),
    exists: (path) => path in files,
    read: (path) => files[path],
  };
}

describe("gatherSandboxFacts", () => {
  it("reads the three kernel files as numbers", () => {
    const facts = gatherSandboxFacts(
      fakeIo({
        files: {
          "/proc/sys/user/max_user_namespaces": "0\n",
          "/proc/sys/kernel/unprivileged_userns_clone": "1\n",
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
        },
      }),
    );
    expect(facts).toMatchObject({
      platform: "linux",
      uid: 1000,
      maxUserNamespaces: 0,
      unprivilegedUsernsClone: 1,
      apparmorRestrictUserns: 1,
    });
    expect(facts.container).toBeUndefined();
  });

  it("leaves a missing or non-numeric file undefined", () => {
    const facts = gatherSandboxFacts(
      fakeIo({ files: { "/proc/sys/user/max_user_namespaces": "many" } }),
    );
    expect(facts.maxUserNamespaces).toBeUndefined();
    expect(facts.unprivilegedUsernsClone).toBeUndefined();
    expect(facts.apparmorRestrictUserns).toBeUndefined();
  });

  it.each<{ signal: string; files: Record<string, string>; match: RegExp }>([
    { signal: "/.dockerenv", files: { "/.dockerenv": "" }, match: /dockerenv/ },
    { signal: "/run/.containerenv", files: { "/run/.containerenv": "" }, match: /containerenv/ },
    {
      signal: "a docker cgroup",
      files: { "/proc/1/cgroup": "12:cpu:/docker/4f2a9c\n" },
      match: /cgroup names docker/,
    },
    {
      signal: "a kubepods cgroup",
      files: { "/proc/1/cgroup": "1:name=systemd:/kubepods/burstable/pod1\n" },
      match: /cgroup names kubepods/,
    },
  ])("finds a container from $signal", ({ files, match }) => {
    expect(gatherSandboxFacts(fakeIo({ files })).container).toMatch(match);
  });

  it("does not call a host cgroup a container", () => {
    const facts = gatherSandboxFacts(fakeIo({ files: { "/proc/1/cgroup": "0::/init.scope\n" } }));
    expect(facts.container).toBeUndefined();
  });

  it("reads only the uid off Linux", () => {
    const read = vi.fn(() => "0");
    const facts = gatherSandboxFacts({
      platform: "darwin",
      uid: () => 501,
      exists: () => true,
      read,
    });
    expect(facts).toEqual({ platform: "darwin", uid: 501 });
    expect(read).not.toHaveBeenCalled();
  });

  it("reports no uid where the platform has none", () => {
    expect(gatherSandboxFacts(fakeIo({ platform: "win32", uid: undefined })).uid).toBeUndefined();
  });
});

describe("isSandboxFailure", () => {
  it.each([
    "Chromium sandboxing failed!\n====\nTo avoid the sandboxing issue",
    "FATAL: No usable sandbox! Update your kernel",
    "Running as root without --no-sandbox is not supported.",
    "FATAL:sandbox_host_linux.cc(41)] sendmsg: Bad file descriptor",
    "Failed to move to new namespace: PID namespaces supported",
    "The setuid sandbox is not running as root.",
    "See https://crbug.com/638180 for more information",
    "see https://chromium.googlesource.com/... crbug.com/357670",
  ])("matches %s", (message) => {
    expect(isSandboxFailure(new Error(`browserType.launch: ${message}`))).toBe(true);
  });

  it.each([
    "Target page, context or browser has been closed",
    "Executable doesn't exist at /home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome",
    "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome",
    "Missing X server or $DISPLAY",
    "launch stubbed",
  ])("does not match %s", (message) => {
    expect(isSandboxFailure(new Error(message))).toBe(false);
  });

  it("reads a thrown string", () => {
    expect(isSandboxFailure("No usable sandbox!")).toBe(true);
  });
});

const SANDBOX_ERROR = new Error(
  "browserType.launchPersistentContext: Target closed\nBrowser logs:\n\nChromium sandboxing failed!",
);
const OTHER_ERROR = new Error("launch stubbed");

function hostIs(facts: SandboxFacts): void {
  vi.spyOn(sandboxProbe, "gather").mockReturnValue(facts);
}

/** A fake launcher: records every option it is handed and fails or succeeds on cue. */
function launcher(outcomes: Array<Error | "ok">) {
  const calls: SandboxLaunchOption[] = [];
  const launch = vi.fn(async (option: SandboxLaunchOption) => {
    calls.push(option);
    const outcome = outcomes[calls.length - 1] ?? "ok";
    if (outcome !== "ok") throw outcome;
    return "launched";
  });
  return { launch, calls };
}

let warn: MockInstance<typeof log.warn>;

beforeEach(() => {
  resetSandboxState();
  warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

describe("launchWithSandboxPlan: off", () => {
  it("passes no option and never asks the probe", async () => {
    const gather = vi.spyOn(sandboxProbe, "gather");
    const { launch, calls } = launcher(["ok"]);
    await expect(launchWithSandboxPlan("off", launch)).resolves.toBe("launched");
    expect(calls).toEqual([{}]);
    expect(calls[0]).not.toHaveProperty("chromiumSandbox");
    expect(gather).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });

  it("does not retry a sandbox failure", async () => {
    const { launch } = launcher([SANDBOX_ERROR]);
    await expect(launchWithSandboxPlan("off", launch)).rejects.toBe(SANDBOX_ERROR);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("launchWithSandboxPlan: on", () => {
  it("passes chromiumSandbox: true", async () => {
    const { launch, calls } = launcher(["ok"]);
    await launchWithSandboxPlan("on", launch);
    expect(calls).toEqual([{ chromiumSandbox: true }]);
  });

  it("asks for the sandbox on a host auto would skip", async () => {
    hostIs({ ...linuxUser, uid: 0 });
    const { launch, calls } = launcher(["ok"]);
    await launchWithSandboxPlan("on", launch);
    expect(calls).toEqual([{ chromiumSandbox: true }]);
  });

  it("fails with the cause and the fix when the sandbox cannot start, and does not retry", async () => {
    const { launch } = launcher([SANDBOX_ERROR]);
    const err = (await launchWithSandboxPlan("on", launch).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;
    expect(launch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("BROWX_CHROMIUM_SANDBOX=off");
    expect(err.message).toMatch(/root/);
    expect(err.message).toMatch(/user namespaces/);
    expect(err.message).toMatch(/AppArmor/);
    expect(err.message).toContain("Chromium sandboxing failed");
    expect(err.cause).toBe(SANDBOX_ERROR);
  });

  it("leaves any other failure untouched", async () => {
    const { launch } = launcher([OTHER_ERROR]);
    await expect(launchWithSandboxPlan("on", launch)).rejects.toBe(OTHER_ERROR);
  });

  it.each(["user", "project"] as const)(
    "tells the operator to remove the saved %s value, not to set the env var first",
    async (source) => {
      const { launch } = launcher([SANDBOX_ERROR]);
      const err = (await launchWithSandboxPlan("on", launch, { source }).then(
        () => undefined,
        (e: unknown) => e,
      )) as Error;
      expect(err.message).toContain(
        `Remove chromiumSandbox from the ${source} layer of config.json`,
      );
      expect(err.message).toContain("a saved value beats BROWX_CHROMIUM_SANDBOX");
      expect(err.message).not.toMatch(/^.*Set BROWX_CHROMIUM_SANDBOX=off/m);
    },
  );

  it.each(["env", "default", undefined] as const)(
    "names the env var when the value came from %s",
    async (source) => {
      const { launch } = launcher([SANDBOX_ERROR]);
      const err = (await launchWithSandboxPlan("on", launch, { source }).then(
        () => undefined,
        (e: unknown) => e,
      )) as Error;
      expect(err.message).toContain("Set BROWX_CHROMIUM_SANDBOX=off");
      expect(err.message).not.toContain("config.json");
    },
  );
});

describe("launchWithSandboxPlan: auto", () => {
  it("asks for the sandbox for a normal Linux user", async () => {
    hostIs(linuxUser);
    const { launch, calls } = launcher(["ok"]);
    await launchWithSandboxPlan("auto", launch);
    expect(calls).toEqual([{ chromiumSandbox: true }]);
    expect(warnings()).toEqual([]);
  });

  it("asks for the sandbox on macOS and Windows", async () => {
    for (const facts of [
      { platform: "darwin", uid: 501 },
      { platform: "win32", uid: undefined },
    ] satisfies SandboxFacts[]) {
      hostIs(facts);
      const { launch, calls } = launcher(["ok"]);
      await launchWithSandboxPlan("auto", launch);
      expect(calls).toEqual([{ chromiumSandbox: true }]);
    }
  });

  it("skips the sandbox as root, with one warning that says why and how to turn it on", async () => {
    hostIs({ ...linuxUser, uid: 0 });
    for (let i = 0; i < 3; i++) {
      const { launch, calls } = launcher(["ok"]);
      await launchWithSandboxPlan("auto", launch);
      expect(calls).toEqual([{}]);
      expect(calls[0]).not.toHaveProperty("chromiumSandbox");
    }
    const warned = warnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("runs as root");
    expect(warned[0]).toContain("BROWX_CHROMIUM_SANDBOX=on");
    expect(warned[0]).toContain("BROWX_CHROMIUM_SANDBOX=off");
  });

  it.each([
    { name: "a container", facts: { ...linuxUser, container: "/.dockerenv exists" } },
    { name: "no user namespaces", facts: { ...linuxUser, maxUserNamespaces: 0 } },
    { name: "an AppArmor restriction", facts: { ...linuxUser, apparmorRestrictUserns: 1 } },
  ])("skips the sandbox and warns for $name", async ({ facts }) => {
    hostIs(facts);
    const { launch, calls } = launcher(["ok"]);
    await launchWithSandboxPlan("auto", launch);
    expect(calls).toEqual([{}]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("BROWX_CHROMIUM_SANDBOX=on");
  });

  it("retries once without the sandbox when the launch fails on it, and warns loudly", async () => {
    hostIs(linuxUser);
    const { launch, calls } = launcher([SANDBOX_ERROR, "ok"]);
    await expect(launchWithSandboxPlan("auto", launch)).resolves.toBe("launched");
    expect(calls).toEqual([{ chromiumSandbox: true }, {}]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("Chromium sandboxing failed");
    expect(warnings()[0]).toContain("BROWX_CHROMIUM_SANDBOX=off");
  });

  it("does not retry a failure that does not name the sandbox", async () => {
    hostIs(linuxUser);
    const { launch } = launcher([OTHER_ERROR]);
    await expect(launchWithSandboxPlan("auto", launch)).rejects.toBe(OTHER_ERROR);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([]);
  });

  it("does not loop: a second sandbox failure surfaces after exactly two attempts", async () => {
    hostIs(linuxUser);
    const second = new Error("No usable sandbox!");
    const { launch } = launcher([SANDBOX_ERROR, second]);
    await expect(launchWithSandboxPlan("auto", launch)).rejects.toBe(second);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("remembers a failed launch: later launches skip the sandbox and do not warn again", async () => {
    hostIs(linuxUser);
    const first = launcher([SANDBOX_ERROR, "ok"]);
    await launchWithSandboxPlan("auto", first.launch);
    expect(first.calls).toEqual([{ chromiumSandbox: true }, {}]);
    expect(warnings()).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      const later = launcher(["ok"]);
      await launchWithSandboxPlan("auto", later.launch);
      expect(later.calls).toEqual([{}]);
    }
    expect(warnings()).toHaveLength(1);
  });

  it("remembers the failure per browser: the other target still gets its one try", async () => {
    hostIs(linuxUser);
    await launchWithSandboxPlan("auto", launcher([SANDBOX_ERROR, "ok"]).launch, {
      target: "installed",
    });
    const bundled = launcher([SANDBOX_ERROR, "ok"]);
    await launchWithSandboxPlan("auto", bundled.launch, { target: "bundled" });
    expect(bundled.calls).toEqual([{ chromiumSandbox: true }, {}]);
    expect(warnings()).toHaveLength(2);
  });

  it("warns once per browser kind and names the kind each time", async () => {
    hostIs(linuxUser);
    await launchWithSandboxPlan("auto", launcher([SANDBOX_ERROR, "ok"]).launch, {
      target: "installed",
    });
    await launchWithSandboxPlan("auto", launcher(["ok"]).launch, { target: "installed" });
    await launchWithSandboxPlan("auto", launcher([SANDBOX_ERROR, "ok"]).launch, {
      target: "bundled",
    });
    await launchWithSandboxPlan("auto", launcher(["ok"]).launch, { target: "bundled" });
    const warned = warnings();
    expect(warned).toHaveLength(2);
    expect(warned[0]).toContain("the installed Google Chrome");
    expect(warned[1]).toContain("the bundled Chromium and the headless shell");
    for (const w of warned) {
      expect(w).toContain("restart the server or set BROWX_CHROMIUM_SANDBOX=on to retry");
    }
  });

  it("does not remember a failure that did not name the sandbox", async () => {
    hostIs(linuxUser);
    await expect(launchWithSandboxPlan("auto", launcher([OTHER_ERROR]).launch)).rejects.toBe(
      OTHER_ERROR,
    );
    const next = launcher(["ok"]);
    await launchWithSandboxPlan("auto", next.launch);
    expect(next.calls).toEqual([{ chromiumSandbox: true }]);
  });

  it("does not let the memory change on: a later on launch still asks", async () => {
    hostIs(linuxUser);
    await launchWithSandboxPlan("auto", launcher([SANDBOX_ERROR, "ok"]).launch);
    const later = launcher(["ok"]);
    await launchWithSandboxPlan("on", later.launch);
    expect(later.calls).toEqual([{ chromiumSandbox: true }]);
  });

  it("tries an installed channel on AppArmor-restricted facts and skips the bundled build", async () => {
    hostIs({ ...linuxUser, apparmorRestrictUserns: 1 });
    const installed = launcher(["ok"]);
    await launchWithSandboxPlan("auto", installed.launch, { target: "installed" });
    expect(installed.calls).toEqual([{ chromiumSandbox: true }]);
    const bundled = launcher(["ok"]);
    await launchWithSandboxPlan("auto", bundled.launch, { target: "bundled" });
    expect(bundled.calls).toEqual([{}]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain("AppArmor");
    expect(warnings()[0]).toContain("the bundled Chromium and the headless shell");
  });

  it("says a root skip covers every browser", async () => {
    hostIs({ ...linuxUser, uid: 0 });
    await launchWithSandboxPlan("auto", launcher(["ok"]).launch, { target: "installed" });
    expect(warnings()[0]).toContain("every browser browxai launches");
  });

  it("does not retry on a host it already skipped the sandbox for", async () => {
    hostIs({ ...linuxUser, uid: 0 });
    const { launch } = launcher([SANDBOX_ERROR]);
    await expect(launchWithSandboxPlan("auto", launch)).rejects.toBe(SANDBOX_ERROR);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
