// `browxai doctor` macos-app row: where browxai runs from on a Mac, and when that is
// the signed Browxai app, what its signature says. See docs/rfcs/0012-signed-macos-app.md.
//
// The row exists on macOS only. It is informational: it never fails doctor. It is
// a warning (shown in the short summary) when the app's signature is missing, does
// not verify, has no team id or lacks the hardened runtime, and an informational
// line otherwise (shown only by `--verbose`).

import { spawnSync } from "node:child_process";
import type { Check } from "./doctor.js";

/** The bundle identifier of the Browxai app. Part of every macOS permission grant, so it never changes. */
export const MACOS_APP_BUNDLE_ID = "com.kalebtec.browxai";

const CODESIGN = "/usr/bin/codesign";
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

export interface MacosAppOptions {
  platform?: NodeJS.Platform;
  /** The running node binary. Inside the app it is `<app>/Contents/Resources/node/bin/node`. */
  execPath?: string;
  run?: CommandRunner;
}

/** What `codesign -dv --verbose=4` says about a bundle. */
export interface SignatureFacts {
  identifier?: string;
  /** Undefined when the signature carries no team (an ad hoc signature). */
  team?: string;
  adhoc: boolean;
  runtime: boolean;
}

const NOT_IN_APP =
  "not running from the signed Browxai app. Permission grants then attach to the launching terminal or MCP client.";

/** The `.app` directory that holds `execPath`, or undefined when it is not inside one. */
export function appBundleOf(execPath: string): string | undefined {
  return /^(.*?\.app)\/Contents\//.exec(execPath)?.[1];
}

/** Reads the fields doctor shows out of `codesign -dv --verbose=4` output. */
export function parseSignature(text: string): SignatureFacts {
  const identifier = /^Identifier=(.+)$/m.exec(text)?.[1]?.trim();
  const rawTeam = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
  const flags = /^CodeDirectory\b.*\bflags=0x[0-9a-f]+\(([^)]*)\)/im.exec(text)?.[1] ?? "";
  const flagNames = flags.split(",").map((f) => f.trim().toLowerCase());
  const adhoc = /^Signature=adhoc$/m.test(text) || flagNames.includes("adhoc");
  const team = rawTeam && rawTeam.toLowerCase() !== "not set" ? rawTeam : undefined;
  return {
    ...(identifier ? { identifier } : {}),
    ...(team ? { team } : {}),
    adhoc,
    runtime: flagNames.includes("runtime"),
  };
}

/** A string out of the app's Info.plist, or undefined when plutil cannot read it. */
function plistString(run: CommandRunner, app: string, key: string): string | undefined {
  const r = run(PLUTIL, ["-extract", key, "raw", "-o", "-", `${app}/Contents/Info.plist`]);
  if (r.status !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}

/** What `codesign --verify --strict` said: ok, a reason it failed, or nothing because it did not run. */
type Verification = { state: "ok" } | { state: "failed"; reason: string } | { state: "not-run" };

function verify(run: CommandRunner, app: string): Verification {
  const r = run(CODESIGN, ["--verify", "--strict", app]);
  if (r.status === 0) return { state: "ok" };
  if (r.status === null) return { state: "not-run" };
  const line = firstLine(r.stderr).replaceAll(`${app}: `, "");
  return { state: "failed", reason: line ? line.slice(0, 120) : `codesign exited ${r.status}` };
}

/** Whether the login agent is registered, asked of the launcher's `login-item status`.
 *  Undefined when the launcher does not answer, so an app without the command shows nothing. */
function loginAgent(run: CommandRunner, app: string): string | undefined {
  const exe = plistString(run, app, "CFBundleExecutable");
  if (!exe || exe.includes("/") || exe.includes("..")) return undefined;
  const r = run(`${app}/Contents/MacOS/${exe}`, ["login-item", "status"]);
  if (r.status !== 0) return undefined;
  const status = firstLine(r.stdout).toLowerCase();
  if (/not\s*registered/.test(status)) return "login agent not registered";
  if (/not\s*found/.test(status)) return "login agent not found in the app";
  if (/requires?\s*approval/.test(status)) {
    return "login agent waits for approval in System Settings, Login Items";
  }
  if (/enabled|registered/.test(status)) return "login agent registered";
  return "login agent status unknown";
}

function row(detail: string, fix?: string): Check {
  return fix
    ? { name: "macos-app", ok: true, warn: true, detail, fix }
    : { name: "macos-app", ok: true, info: true, detail };
}

/**
 * The `macos-app` row, or undefined when the host is not macOS (no row, so Linux and
 * Windows output does not change). Never throws and never fails doctor.
 */
export function macosAppRow(opts: MacosAppOptions = {}): Check | undefined {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return undefined;
  const execPath = opts.execPath ?? process.execPath;
  const run = opts.run ?? runCommand;

  const app = appBundleOf(execPath);
  if (!app || plistString(run, app, "CFBundleIdentifier") !== MACOS_APP_BUNDLE_ID) {
    return row(NOT_IN_APP);
  }
  const where = `inside the app at ${app}`;

  const dv = run(CODESIGN, ["-dv", "--verbose=4", app]);
  // codesign writes what it found to standard error.
  const text = `${dv.stderr}\n${dv.stdout}`;
  if (dv.status !== 0) {
    if (/not signed at all/i.test(text)) {
      return row(
        `${where}: not signed`,
        "install the release build of the app. An unsigned app has no stable identity, so macOS asks for permissions again after an update.",
      );
    }
    return row(`${where}: could not read the signature (codesign is missing or failed)`);
  }

  const sig = parseSignature(text);
  const verified = verify(run, app);
  const login = loginAgent(run, app);

  const parts = [
    sig.adhoc ? "signed ad hoc" : "signed",
    sig.identifier ? `identifier ${sig.identifier}` : "no identifier",
    sig.team ? `team ${sig.team}` : "no team id",
    sig.runtime ? "hardened runtime on" : "hardened runtime off",
    verified.state === "ok"
      ? "signature verifies"
      : verified.state === "failed"
        ? `signature does not verify (${verified.reason})`
        : "signature check did not run",
  ];
  if (login) parts.push(login);
  const detail = `${where}: ${parts.join(", ")}`;

  const fixes: string[] = [];
  if (verified.state === "failed") {
    fixes.push("the app changed after it was signed. Reinstall it from the release build.");
  }
  if (!sig.team) {
    fixes.push(
      "a signature with no team changes with every build, so macOS asks for permissions again after an update. Install the release build.",
    );
  }
  if (!sig.runtime) {
    fixes.push(
      "the release build has the hardened runtime on, and Apple's notarization requires it. Install the release build.",
    );
  }
  return row(detail, fixes.length > 0 ? fixes.join(" ") : undefined);
}
