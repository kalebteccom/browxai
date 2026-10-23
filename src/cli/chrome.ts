// `browxai chrome start|login|stop|status` — own the Chrome lifecycle for BYOB and
// for human sign-in.
//
// `start` launches the operator's installed Google Chrome with
// `--remote-debugging-port=9222` on the workspace's default profile (or
// `profiles/<name>` with `--profile`) and writes the PID to
// `$BROWX_WORKSPACE/chrome.pid`. `login` launches the same Chrome on the same
// profile with NO debug port, so a person can clear a bot-protection challenge
// and sign in with nothing attached; the cookies stay in the profile. `stop`
// reads the PID file and SIGTERMs the process; cleans up. Stdout is fine — this
// is a CLI subcommand.
//
// The `start` Chrome is the *BYOB target* an adopter would `BROWX_ATTACH_CDP=…`
// against. browxai itself does NOT attach to it from `chrome start` — start the
// MCP server separately (the `browxai-attached` MCP entry) once Chrome is up.
// A profile is open in one Chrome at a time: both launchers refuse a profile that
// is already held unless `--force` is given.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspace } from "../util/workspace.js";
import { profileLockHolder, resolveProfileDir } from "../session/profile-guard.js";
import {
  buildLoginArgs,
  buildStartArgs,
  findInstalledChrome,
  isValidProfileName,
  parseHttpUrl,
} from "./chrome-launch.js";

const DEFAULT_PORT = 9222;

export async function runChrome(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "start") return startChrome(args.slice(1));
  if (sub === "login") return loginChrome(args.slice(1));
  if (sub === "stop") return stopChrome();
  if (sub === "status") return statusChrome();
  process.stderr.write(
    "usage: browxai chrome <start [--port N] [--profile NAME] [--force] [--insecure] [--disable-background-throttling] | login [--url URL] [--profile NAME] [--force] | stop | status>\n",
  );
  return 2;
}

/** The installed Chrome and the target profile directory, or a printed refusal.
 *  Shared by `start` and `login`: both need Chrome installed, a valid `--profile`
 *  and a profile no other Chrome holds. */
function resolveLaunchTarget(
  opts: string[],
): { chromePath: string; profileDir: string } | undefined {
  const profile = parseFlagStr(opts, "--profile");
  if (opts.includes("--profile") && (profile === undefined || !isValidProfileName(profile))) {
    process.stderr.write(
      `invalid --profile "${profile ?? ""}": use a plain name (letters, digits, ., _, -), no path separators\n`,
    );
    return undefined;
  }
  const chromePath = findInstalledChrome();
  if (!chromePath) {
    process.stderr.write(
      "no installed Google Chrome found. Install Chrome, then run this again. browxai's bundled Chromium is not used here: bot-protected sites treat it as automation.\n",
    );
    return undefined;
  }
  const profileDir = resolveProfileDir(resolveWorkspace(), profile);
  const lock = profileLockHolder(profileDir);
  if (lock && !opts.includes("--force")) {
    const who = lock.pid ? `Chrome pid ${lock.pid}` : "a Chrome";
    process.stderr.write(
      `profile ${profileDir} is already open in ${who}. A profile can be open in one Chrome at a time: quit that Chrome (or \`browxai chrome stop\`, or close the browxai session on it), pass --profile NAME for a different one, or --force to launch anyway.\n`,
    );
    return undefined;
  }
  return { chromePath, profileDir };
}

function startChrome(opts: string[]): Promise<number> {
  const port = parseFlagNum(opts, "--port") ?? DEFAULT_PORT;
  const insecure = opts.includes("--insecure"); // opt-in security-lowered (BYOB recipe's `--disable-web-security`)
  const noBackgroundThrottling = opts.includes("--disable-background-throttling");
  const pidFile = join(resolveWorkspace().root, "chrome.pid");

  if (existsSync(pidFile)) {
    const oldPid = readFileSync(pidFile, "utf8").trim();
    if (oldPid && isProcessAlive(Number(oldPid))) {
      process.stdout.write(
        `a previous browxai chrome is already running (pid ${oldPid}, port ${port}). Use \`browxai chrome stop\` first.\n`,
      );
      return Promise.resolve(1);
    }
    unlinkSync(pidFile);
  }

  const target = resolveLaunchTarget(opts);
  if (!target) return Promise.resolve(1);
  const { chromePath, profileDir } = target;
  const args = buildStartArgs({ port, profileDir, insecure, noBackgroundThrottling });
  if (insecure) {
    process.stdout.write(
      "⚠  --insecure: launching Chrome with --disable-web-security. SOP is OFF for the whole browser session. Use only against test/dev targets.\n",
    );
  }
  if (noBackgroundThrottling) {
    process.stdout.write(
      "background-tab throttling disabled: timers, rAF and renderer priority keep running when a tab is backgrounded. Leave it off if you need to REPRODUCE background-throttling bugs.\n",
    );
  }
  const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
  child.unref();
  if (!child.pid) {
    process.stderr.write("failed to spawn Chrome\n");
    return Promise.resolve(1);
  }
  writeFileSync(pidFile, String(child.pid), "utf8");
  process.stdout.write(
    `browxai chrome started\n  pid:     ${child.pid}\n  port:    ${port}\n  profile: ${profileDir}\n  attach:  BROWX_ATTACH_CDP=http://127.0.0.1:${port}\n  caps:    BROWX_CAPABILITIES=read,navigation,action,human,byob-attach\n\nstop with: browxai chrome stop\n`,
  );
  return Promise.resolve(0);
}

/** Launch Chrome on the profile with no debug port, for a person to use. */
function loginChrome(opts: string[]): Promise<number> {
  const rawUrl = parseFlagStr(opts, "--url");
  const url = rawUrl === undefined ? undefined : parseHttpUrl(rawUrl);
  if (opts.includes("--url") && !url) {
    process.stderr.write(`invalid --url "${rawUrl ?? ""}": expected an http(s) URL\n`);
    return Promise.resolve(2);
  }
  const target = resolveLaunchTarget(opts);
  if (!target) return Promise.resolve(1);
  const { chromePath, profileDir } = target;
  const child = spawn(chromePath, buildLoginArgs({ profileDir, url }), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  if (!child.pid) {
    process.stderr.write("failed to spawn Chrome\n");
    return Promise.resolve(1);
  }
  process.stdout.write(
    `browxai chrome login: Chrome opened on the profile with no debug port and nothing attached.\n  pid:     ${child.pid}\n  profile: ${profileDir}\n\nClear the challenge and sign in by hand. Then QUIT this Chrome completely (Cmd+Q / close every window) so the cookies are written and the profile is released. After that, browxai sessions on this profile reuse them.\n`,
  );
  return Promise.resolve(0);
}

async function stopChrome(): Promise<number> {
  const ws = resolveWorkspace();
  const pidFile = join(ws.root, "chrome.pid");
  if (!existsSync(pidFile)) {
    process.stdout.write("no browxai chrome running (no chrome.pid in workspace)\n");
    return 0;
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!pid || !isProcessAlive(pid)) {
    unlinkSync(pidFile);
    process.stdout.write(`browxai chrome (pid ${pid}) no longer running; cleaned up pid file\n`);
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    // Give it a beat; if it's still alive, SIGKILL.
    await sleep(800);
    if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    unlinkSync(pidFile);
    process.stdout.write(`browxai chrome (pid ${pid}) stopped\n`);
    return 0;
  } catch (e) {
    process.stderr.write(
      `failed to stop pid ${pid}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}

function statusChrome(): Promise<number> {
  const ws = resolveWorkspace();
  const pidFile = join(ws.root, "chrome.pid");
  if (!existsSync(pidFile)) {
    process.stdout.write("no browxai chrome running (no chrome.pid in workspace)\n");
    return Promise.resolve(0);
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid && isProcessAlive(pid)) {
    process.stdout.write(`browxai chrome running (pid ${pid})\n`);
    return Promise.resolve(0);
  }
  process.stdout.write(`pid ${pid} no longer alive; run \`browxai chrome stop\` to clean up\n`);
  return Promise.resolve(1);
}

function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseFlagNum(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : undefined;
}

function parseFlagStr(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
