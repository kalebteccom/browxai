import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import {
  AGENT_LABEL,
  agentFiles,
  agentPath,
  launchdPlist,
  systemAgent,
  systemdService,
  systemdTimer,
  type AgentHost,
} from "./runtime-agent.js";
import type { RunResult } from "./runtime-exec.js";
import { runtimePaths } from "./runtime-layout.js";

const MAC_NODE = "/opt/homebrew/opt/node@22/bin/node";
const LINUX_NODE = "/home/someone/.local/share/mise/installs/node/22.11.0/bin/node";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

/** A runner for launchctl and systemctl that records each call and answers `status`. */
function fakeRunner(fail: (args: readonly string[]) => boolean = () => false) {
  const calls: string[] = [];
  const run = (file: string, args: readonly string[]): Promise<RunResult> => {
    calls.push([file, ...args].join(" "));
    return Promise.resolve(
      fail(args)
        ? { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" }
        : { status: 0, stdout: "", stderr: "" },
    );
  };
  return Object.assign(run, { calls });
}

function host(
  platform: NodeJS.Platform,
  run = fakeRunner(),
  env: NodeJS.ProcessEnv = {},
): AgentHost {
  return { platform, home: rt!.home, uid: 501, env, run };
}

describe("the job's files, as text", () => {
  it("the launchd plist matches the golden file", async () => {
    const text = launchdPlist(runtimePaths("/Users/someone/.browxai-runtime"), MAC_NODE);
    await expect(text).toMatchFileSnapshot("./__fixtures__/runtime-agent/launchd.plist");
  });

  it("the systemd service and timer match the golden files", async () => {
    const service = systemdService(runtimePaths("/home/someone/.browxai-runtime"), LINUX_NODE);
    await expect(service).toMatchFileSnapshot("./__fixtures__/runtime-agent/systemd.service");
    await expect(systemdTimer()).toMatchFileSnapshot("./__fixtures__/runtime-agent/systemd.timer");
  });

  it("puts the recorded node's directory first on PATH, then /usr/bin and /bin", () => {
    expect(agentPath(LINUX_NODE)).toBe(
      "/home/someone/.local/share/mise/installs/node/22.11.0/bin:/usr/bin:/bin",
    );
    const plist = launchdPlist(runtimePaths("/r"), MAC_NODE);
    expect(plist).toContain(
      "<key>PATH</key>\n    <string>/opt/homebrew/opt/node@22/bin:/usr/bin:/bin</string>",
    );
    const service = systemdService(runtimePaths("/r"), LINUX_NODE);
    expect(service).toContain(`Environment="PATH=${agentPath(LINUX_NODE)}"`);
    expect(service).toContain(`Environment="BROWX_RUNTIME_NODE=${LINUX_NODE}"`);
  });

  it("escapes a path with XML or systemd specials", () => {
    const paths = runtimePaths('/home/a&b <c>/50% $HOME "q"');
    const plist = launchdPlist(paths, MAC_NODE);
    expect(plist).toContain(
      "<string>/home/a&amp;b &lt;c&gt;/50% $HOME &quot;q&quot;/bin/browxai</string>",
    );
    const service = systemdService(paths, LINUX_NODE);
    expect(service).toContain(
      'ExecStart="/home/a&b <c>/50%% $$HOME \\"q\\"/bin/browxai" runtime update --auto',
    );
  });

  it("runs as the user: no sudo, no root user, no system path", () => {
    const all = [
      launchdPlist(runtimePaths("/r"), MAC_NODE),
      systemdService(runtimePaths("/r"), LINUX_NODE),
      systemdTimer(),
    ].join("\n");
    expect(all).not.toMatch(
      /sudo|UserName|User=|GroupName|\/Library\/LaunchDaemons|\/etc\/systemd/,
    );
  });
});

describe("where the files go", () => {
  it("macOS: the user's LaunchAgents", () => {
    rt = tempRuntime();
    expect(agentFiles(host("darwin"))).toEqual([
      join(rt.home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`),
    ]);
  });

  it("Linux: XDG_CONFIG_HOME when absolute, else ~/.config", () => {
    rt = tempRuntime();
    expect(agentFiles(host("linux"))).toEqual([
      join(rt.home, ".config", "systemd", "user", "browxai-runtime-update.service"),
      join(rt.home, ".config", "systemd", "user", "browxai-runtime-update.timer"),
    ]);
    expect(agentFiles(host("linux", fakeRunner(), { XDG_CONFIG_HOME: "/cfg" }))[0]).toBe(
      "/cfg/systemd/user/browxai-runtime-update.service",
    );
    expect(agentFiles(host("linux", fakeRunner(), { XDG_CONFIG_HOME: "rel" }))[0]).toContain(
      join(rt.home, ".config"),
    );
  });

  it("nowhere on Windows", () => {
    rt = tempRuntime();
    expect(agentFiles(host("win32"))).toEqual([]);
  });
});

describe("install and remove, with a fake launchctl and systemctl", () => {
  it("macOS: writes the plist, makes agent.log 0600 and loads the job in the user's domain", async () => {
    rt = tempRuntime();
    const run = fakeRunner();
    const agent = systemAgent(host("darwin", run));
    const r = await agent.install(rt.paths, MAC_NODE);
    expect(r.ok).toBe(true);
    const [plist] = agentFiles(host("darwin"));
    expect(readFileSync(plist!, "utf8")).toBe(launchdPlist(rt.paths, MAC_NODE));
    expect(statSync(rt.paths.agentLog).mode & 0o777).toBe(0o600);
    expect(run.calls).toEqual([
      `/bin/launchctl bootout gui/501/${AGENT_LABEL}`,
      `/bin/launchctl bootstrap gui/501 ${plist}`,
    ]);
    expect(agent.installed()).toEqual([plist]);
  });

  it("macOS: reports a load that fails, and refuses with no user id", async () => {
    rt = tempRuntime();
    const run = fakeRunner((args) => args[0] === "bootstrap");
    const r = await systemAgent(host("darwin", run)).install(rt.paths, MAC_NODE);
    expect(r).toEqual({
      ok: false,
      detail: expect.stringContaining("launchctl bootstrap gui/501") as string,
    });
    expect(r.detail).toContain("Bootstrap failed: 5");
    const noUid = await systemAgent({ ...host("darwin"), uid: undefined }).install(
      rt.paths,
      MAC_NODE,
    );
    expect(noUid.ok).toBe(false);
  });

  it("Linux: writes the units, reloads, enables the timer, and removes it all again", async () => {
    rt = tempRuntime();
    const run = fakeRunner();
    const agent = systemAgent(host("linux", run));
    expect((await agent.install(rt.paths, LINUX_NODE)).ok).toBe(true);
    const [service, timer] = agentFiles(host("linux"));
    expect(readFileSync(service!, "utf8")).toBe(systemdService(rt.paths, LINUX_NODE));
    expect(readFileSync(timer!, "utf8")).toBe(systemdTimer());
    expect(run.calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now browxai-runtime-update.timer",
    ]);
    const removed = await agent.remove();
    expect(removed.ok).toBe(true);
    expect(existsSync(service!)).toBe(false);
    expect(existsSync(timer!)).toBe(false);
    expect(run.calls.slice(2)).toEqual([
      "systemctl --user disable --now browxai-runtime-update.timer",
      "systemctl --user daemon-reload",
    ]);
  });

  it("macOS remove unloads and deletes the plist even when the job wasn't loaded", async () => {
    rt = tempRuntime();
    const [plist] = agentFiles(host("darwin"));
    mkdirSync(join(rt.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist!, "x");
    const run = fakeRunner(() => true);
    const r = await systemAgent(host("darwin", run)).remove();
    expect(r.ok).toBe(true);
    expect(existsSync(plist!)).toBe(false);
    expect(run.calls).toEqual([`/bin/launchctl bootout gui/501/${AGENT_LABEL}`]);
  });

  it("remove with nothing installed runs nothing", async () => {
    rt = tempRuntime();
    const run = fakeRunner();
    expect(await systemAgent(host("linux", run)).remove()).toEqual({
      ok: true,
      detail: "no background job was installed",
    });
    expect(run.calls).toEqual([]);
  });

  it("Windows: no job, and install says how to update by hand", async () => {
    rt = tempRuntime();
    const agent = systemAgent(host("win32"));
    expect(agent.kind).toBeUndefined();
    expect((await agent.install(rt.paths, "C:\\node\\node.exe")).ok).toBe(false);
  });
});
