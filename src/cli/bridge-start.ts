// `browxai bridge --start`: ask the Browxai app's launcher to start the app's login
// agent when no daemon answers. It works only when the bridge runs from inside the
// app. The launcher's `login-item start` asks launchd to start an agent that is already
// registered and allowed to run. It registers nothing, and the bridge never runs
// `serve` or a daemon of its own. See docs/rfcs/0013-stdio-socket-bridge.md.

import { execFile } from "node:child_process";
import { appLauncherOf, runCommand, runningAppBundle, type CommandResult } from "./macos-app.js";

/** How long the launcher may take. It runs `launchctl kickstart`, which returns at once. */
const LAUNCHER_TIMEOUT_MS = 10_000;

/** Runs the launcher with an argument list, never through a shell. A test passes its own. */
export type LauncherRunner = (launcher: string, args: readonly string[]) => Promise<CommandResult>;

/** The launcher of the Browxai app this process runs from, or undefined outside the app. */
export function runningAppLauncher(): string | undefined {
  const app = runningAppBundle();
  return app === undefined ? undefined : appLauncherOf(runCommand, app);
}

export const runLauncher: LauncherRunner = (launcher, args) =>
  new Promise((resolve) => {
    execFile(
      launcher,
      [...args],
      { encoding: "utf8", timeout: LAUNCHER_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 65_536 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : (err as { code?: unknown }).code;
        resolve({ status: typeof code === "number" ? code : null, stdout, stderr });
      },
    );
  });

/** Asks the launcher once for each time the daemon is found missing. */
export interface AgentStarter {
  /** Run `login-item start`, unless it already ran since the last `reset`. Never throws. */
  ask(): Promise<void>;
  /** A daemon answered. The next time one is missing, `ask` runs the launcher again. */
  reset(): void;
}

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "") ?? "";

/**
 * A starter for the app whose launcher is at `launcher`. What the launcher answers
 * goes to `say` as one line: it names the agent's state and holds nothing from the
 * client.
 */
export function agentStarter(
  launcher: string,
  say: (line: string) => void,
  run: LauncherRunner = runLauncher,
): AgentStarter {
  let asked = false;
  return {
    reset: () => void (asked = false),
    ask: async () => {
      if (asked) return;
      asked = true;
      let result: CommandResult;
      try {
        result = await run(launcher, ["login-item", "start"]);
      } catch {
        result = { status: null, stdout: "", stderr: "" };
      }
      const answer = firstLine(result.stdout) || firstLine(result.stderr);
      const outcome =
        result.status === 0
          ? "asked the app's login agent to start"
          : "the app's launcher did not start the login agent";
      say(`browxai bridge: ${outcome}${answer ? ` (${answer.slice(0, 200)})` : ""}.\n`);
    },
  };
}
