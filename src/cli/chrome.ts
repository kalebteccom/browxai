// `browxai chrome start|stop` — own the `--cdp` Chrome lifecycle (wishlist W-B7).
//
// Launches a Chromium with `--remote-debugging-port=9222 --user-data-dir=$BROWX_WORKSPACE/chrome-profile`
// (the right flags every time; profile in the workspace so logins survive across sessions)
// and writes the PID to `$BROWX_WORKSPACE/chrome.pid`. `stop` reads the PID file and
// SIGTERMs the process; cleans up. Stdout is fine — this is a CLI subcommand.
//
// The launched Chromium is the *BYOB target* an adopter would `BROWX_ATTACH_CDP=…`
// against. browxai itself does NOT attach to it from `chrome start` — start the
// MCP server separately (the `browxai-attached` MCP entry) once Chrome is up.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { resolveWorkspace } from "../util/workspace.js";

const DEFAULT_PORT = 9222;

export async function runChrome(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "start") return startChrome(args.slice(1));
  if (sub === "stop") return stopChrome();
  if (sub === "status") return statusChrome();
  process.stderr.write("usage: browxai chrome <start [--port N] [--insecure] | stop | status>\n");
  return 2;
}

async function startChrome(opts: string[]): Promise<number> {
  const port = parseFlagNum(opts, "--port") ?? DEFAULT_PORT;
  const insecure = opts.includes("--insecure"); // opt-in security-lowered (BYOB recipe's `--disable-web-security`)
  const ws = resolveWorkspace();
  const profileDir = ws.sub("chrome-profile");
  const pidFile = join(ws.root, "chrome.pid");

  if (existsSync(pidFile)) {
    const oldPid = readFileSync(pidFile, "utf8").trim();
    if (oldPid && isProcessAlive(Number(oldPid))) {
      process.stdout.write(`a previous browxai chrome is already running (pid ${oldPid}, port ${port}). Use \`browxai chrome stop\` first.\n`);
      return 1;
    }
    unlinkSync(pidFile);
  }

  const chromePath = chromium.executablePath();
  if (!chromePath) {
    process.stderr.write("no Chromium binary — run `pnpm install-browser` first\n");
    return 1;
  }
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (insecure) {
    args.push("--disable-web-security", "--disable-site-isolation-trials");
    process.stdout.write(
      "⚠  --insecure: launching Chrome with --disable-web-security. SOP is OFF for the whole browser session. Use only against test/dev targets.\n",
    );
  }
  const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
  child.unref();
  if (!child.pid) {
    process.stderr.write("failed to spawn Chrome\n");
    return 1;
  }
  writeFileSync(pidFile, String(child.pid), "utf8");
  process.stdout.write(
    `browxai chrome started\n  pid:     ${child.pid}\n  port:    ${port}\n  profile: ${profileDir}\n  attach:  BROWX_ATTACH_CDP=http://127.0.0.1:${port}\n\nstop with: browxai chrome stop\n`,
  );
  return 0;
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
    process.stderr.write(`failed to stop pid ${pid}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

async function statusChrome(): Promise<number> {
  const ws = resolveWorkspace();
  const pidFile = join(ws.root, "chrome.pid");
  if (!existsSync(pidFile)) {
    process.stdout.write("no browxai chrome running (no chrome.pid in workspace)\n");
    return 0;
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid && isProcessAlive(pid)) {
    process.stdout.write(`browxai chrome running (pid ${pid})\n`);
    return 0;
  }
  process.stdout.write(`pid ${pid} no longer alive; run \`browxai chrome stop\` to clean up\n`);
  return 1;
}

function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function parseFlagNum(args: string[], flag: string): number | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
