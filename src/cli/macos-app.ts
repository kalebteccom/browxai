// Where browxai runs from on a Mac: inside the Browxai app or not, and the paths of
// the app's launcher, its `browxai` wrapper and its daemon socket. `browxai doctor`,
// `browxai init` and `browxai bridge --start` all decide with the one test here, so
// they agree on what "run from the app" means. See docs/rfcs/0012-signed-macos-app.md.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

/** The bundle identifier of the Browxai app. Part of every macOS permission grant, so it never changes. */
export const MACOS_APP_BUNDLE_ID = "com.kalebtec.browxai";

const PLUTIL = "/usr/bin/plutil";

/** How long one command may run. The login item lookup starts the launcher, so it gets a bound. */
const RUN_TIMEOUT_MS = 10_000;

export interface CommandResult {
  /** The exit status, or null when the command did not run or was stopped. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one program with an argument list, never through a shell. Tests pass a fake. */
export type CommandRunner = (file: string, args: readonly string[]) => CommandResult;

export const runCommand: CommandRunner = (file, args) => {
  const r = spawnSync(file, [...args], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export interface AppLocationOptions {
  platform?: NodeJS.Platform;
  /** The running node binary. Inside the app it is `<app>/Contents/Resources/node/bin/node`. */
  execPath?: string;
  run?: CommandRunner;
}

/** The `.app` directory that holds `execPath`, or undefined when it is not inside one. */
export function appBundleOf(execPath: string): string | undefined {
  return /^(.*?\.app)\/Contents\//.exec(execPath)?.[1];
}

/** A string out of the app's Info.plist, or undefined when plutil cannot read it. */
export function plistString(run: CommandRunner, app: string, key: string): string | undefined {
  const r = run(PLUTIL, ["-extract", key, "raw", "-o", "-", `${app}/Contents/Info.plist`]);
  if (r.status !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

/**
 * The Browxai app this process runs from, or undefined. Node counts as inside the app
 * when it sits under a `.app/Contents/` directory whose Info.plist holds the Browxai
 * bundle id. Anything else, a Node inside another app included, is not the app. Off
 * macOS, and for a Node outside any bundle, no command runs.
 */
export function runningAppBundle(opts: AppLocationOptions = {}): string | undefined {
  if ((opts.platform ?? process.platform) !== "darwin") return undefined;
  const app = appBundleOf(opts.execPath ?? process.execPath);
  if (!app) return undefined;
  const run = opts.run ?? runCommand;
  return plistString(run, app, "CFBundleIdentifier") === MACOS_APP_BUNDLE_ID ? app : undefined;
}

/** The app's main executable, the launcher, read from its Info.plist. Undefined when
 *  the plist names none, or names something that is not a plain file name. */
export function appLauncherOf(run: CommandRunner, app: string): string | undefined {
  const exe = plistString(run, app, "CFBundleExecutable");
  if (!exe || exe.includes("/") || exe.includes("..")) return undefined;
  return `${app}/Contents/MacOS/${exe}`;
}

/** The `browxai` command inside the app, which the Homebrew cask links onto PATH. */
export function appWrapperOf(app: string): string {
  return `${app}/Contents/Resources/bin/browxai`;
}

/**
 * The socket of the app's daemon as this process sees it. The launcher's `cli`
 * command sets `BROWX_SOCKET` before it starts Node, to the user's own value or to
 * the app's default, so the variable wins and the default is the fallback.
 */
export function appSocketPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env.BROWX_SOCKET?.trim();
  return fromEnv || `${home}/Library/Application Support/Browxai/run/browxai.sock`;
}
