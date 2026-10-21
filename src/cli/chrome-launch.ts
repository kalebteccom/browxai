// Pure pieces of `browxai chrome`: where the installed Chrome lives, which
// profile directory a command targets, and the argument lists. Split from
// chrome.ts so each can be tested without spawning a browser.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { backgroundThrottlingArgs } from "../session/launch-options.js";

/** Where Google Chrome installs by default, in lookup order, for `platform`. */
export function chromeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  if (platform === "darwin") {
    const app = "Google Chrome.app/Contents/MacOS/Google Chrome";
    return [join("/Applications", app), join(home, "Applications", app)];
  }
  if (platform === "win32") {
    const suffix = join("Google", "Chrome", "Application", "chrome.exe");
    return [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]]
      .filter((root): root is string => Boolean(root))
      .map((root) => join(root, suffix));
  }
  return ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
}

/** The installed Google Chrome executable, or undefined when there is none. */
export function findInstalledChrome(
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | undefined {
  return chromeCandidates(platform, env, home).find((p) => exists(p));
}

/** A `--profile` value that stays one directory name under `profiles/`. */
export function isValidProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

/** Flags every `chrome` launch carries. */
const BASE_ARGS = ["--no-first-run", "--no-default-browser-check"];

export interface StartArgsInput {
  port: number;
  profileDir: string;
  insecure?: boolean;
  noBackgroundThrottling?: boolean;
}

/** Arguments for `chrome start`: an attachable Chrome with a debug port. */
export function buildStartArgs(input: StartArgsInput): string[] {
  const args = [
    `--remote-debugging-port=${input.port}`,
    `--user-data-dir=${input.profileDir}`,
    ...BASE_ARGS,
  ];
  if (input.insecure) args.push("--disable-web-security", "--disable-site-isolation-trials");
  if (input.noBackgroundThrottling) {
    args.push(...backgroundThrottlingArgs({ backgroundThrottling: "disabled" }));
  }
  return args;
}

/** Arguments for `chrome login`: the profile and an optional start URL, with no
 *  debug port and no automation flag, so a person can clear a challenge and sign
 *  in with nothing attached to the browser. */
export function buildLoginArgs(input: { profileDir: string; url?: string }): string[] {
  const args = [`--user-data-dir=${input.profileDir}`, ...BASE_ARGS];
  if (input.url) args.push(input.url);
  return args;
}

/** `url` when it is an http(s) URL, else undefined. */
export function parseHttpUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
