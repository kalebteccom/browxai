// `browxai bridge --start`: the one launcher command it runs, how often, and what it
// says about the answer.

import { describe, expect, it } from "vitest";
import { agentStarter, runLauncher, type LauncherRunner } from "./bridge-start.js";
import type { CommandResult } from "./macos-app.js";

const LAUNCHER = "/Applications/Browxai.app/Contents/MacOS/browxai-launcher";

function setup(answer: CommandResult | Error) {
  const calls: string[][] = [];
  const said: string[] = [];
  const run: LauncherRunner = (launcher, args) => {
    calls.push([launcher, ...args]);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { calls, said, starter: agentStarter(LAUNCHER, (line) => void said.push(line), run) };
}

describe("agentStarter", () => {
  it("runs `login-item start` once, and again only after a reset", async () => {
    const s = setup({ status: 0, stdout: "started: launchd was asked\n", stderr: "" });
    await s.starter.ask();
    await s.starter.ask();
    expect(s.calls).toEqual([[LAUNCHER, "login-item", "start"]]);
    s.starter.reset();
    await s.starter.ask();
    expect(s.calls).toHaveLength(2);
    expect(s.said).toHaveLength(2);
  });

  it("says the agent was asked to start, with the launcher's first line", async () => {
    const s = setup({ status: 0, stdout: "\nstarted: launchd was asked\nmore\n", stderr: "" });
    await s.starter.ask();
    expect(s.said).toEqual([
      "browxai bridge: asked the app's login agent to start (started: launchd was asked).\n",
    ]);
  });

  it("says nothing was started when the launcher exits non-zero, with its reason", async () => {
    const s = setup({
      status: 1,
      stdout: "",
      stderr: "browxai-launcher: nothing was started: launchctl kickstart exited 113\n",
    });
    await s.starter.ask();
    expect(s.said[0]).toContain("the app's launcher did not start the login agent");
    expect(s.said[0]).toContain("launchctl kickstart exited 113");
  });

  it("does not throw when the launcher cannot run, and keeps its answer short", async () => {
    const failed = setup(new Error("spawn failed"));
    await expect(failed.starter.ask()).resolves.toBeUndefined();
    expect(failed.said).toEqual([
      "browxai bridge: the app's launcher did not start the login agent.\n",
    ]);

    const long = setup({ status: 2, stdout: "x".repeat(5_000), stderr: "" });
    await long.starter.ask();
    expect(long.said[0]!.length).toBeLessThan(300);
  });
});

describe("runLauncher", () => {
  it("reports the exit status and the output of the program it ran", async () => {
    const r = await runLauncher(process.execPath, [
      "-e",
      "console.log('said'); console.error('why'); process.exit(2)",
    ]);
    expect(r.status).toBe(2);
    expect(r.stdout.trim()).toBe("said");
    expect(r.stderr.trim()).toBe("why");
    expect((await runLauncher(process.execPath, ["-e", ""])).status).toBe(0);
  });

  it("reports no status for a program that is not there", async () => {
    const r = await runLauncher("/nonexistent/browxai-launcher", ["login-item", "start"]);
    expect(r.status).toBeNull();
  });
});
