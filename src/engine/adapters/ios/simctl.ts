// `xcrun simctl` plumbing for the ios-app engine — simulator and application
// lifecycle. The same split `adb.ts` uses: PURE argv construction and output
// parsing, plus a thin IO seam (`SimctlRunner`) that shells out. The pure half is
// unit-tested with no Xcode; the IO half is covered by the simulator-gated
// keystone.
//
// Every command is an argv ARRAY handed to `execFile` — no shell, so a device
// udid, a bundle id or a deep-link URL can never be interpolated into a command
// line. That is the `adb.ts` / `credentials-contract.ts` posture, and it matters
// more here than there: `simctl openurl` and `simctl launch` take strings an
// agent chose.
//
// Xcode is OPERATOR-SUPPLIED. browxai never bundles it, never installs it, and
// never downloads a runtime — the same posture as the credentials provider and
// the Android SDK (RFC 0008 §Honest limits).

import { execFile } from "node:child_process";
import type { NativeAppInfo, NativeDeviceInfo } from "../../native-types.js";

/** Runs an `xcrun simctl …` command and resolves its stdout. Injected so the
 *  pure command-construction and parsing logic tests without Xcode. */
export type SimctlRunner = (args: readonly string[]) => Promise<string>;

/** Xcode's command-line tools are absent. Structured — names the requirement
 *  rather than surfacing a raw ENOENT. */
export class XcodeNotInstalledError extends Error {
  constructor(detail?: string) {
    super(
      "xcode-missing: `xcrun` was not found on PATH. The ios-app engine drives the iOS Simulator " +
        "through `xcrun simctl`, which ships with Xcode. Install Xcode from the App Store and run " +
        "`xcode-select --install`, then confirm with `xcrun simctl list devices`" +
        (detail ? ` (${detail})` : "") +
        ".",
    );
    this.name = "XcodeNotInstalledError";
  }
}

/** No usable iOS Simulator. Structured — lists what simctl did report so the
 *  operator can tell "no runtimes installed" from "picked the wrong udid". */
export class NoSimulatorError extends Error {
  readonly devices: readonly NativeDeviceInfo[];
  constructor(devices: readonly NativeDeviceInfo[], requested?: string) {
    const seen = devices.length
      ? `simctl lists ${devices.length} iOS simulator${devices.length === 1 ? "" : "s"}; ` +
        `booted: ${devices.filter((d) => d.state === "booted").length}.`
      : "simctl lists no available iOS simulators.";
    super(
      "no-simulator: " +
        (requested
          ? `no iOS simulator matches "${requested}". `
          : "no iOS simulator is available to boot. ") +
        seen +
        " List them with `xcrun simctl list devices`, install a runtime from Xcode ▸ Settings ▸ " +
        "Components, and pick one with BROWX_IOS_DEVICE (a udid or an exact device name).",
    );
    this.name = "NoSimulatorError";
    this.devices = devices;
  }
}

// ─── PURE: simctl argv construction ───────────────────────────────────────────
// Each builder returns the argv for `execFile("xcrun", argv)`. `simctl` is the
// first element because `xcrun` is the launcher; the device id is always a
// separate argv element, never spliced into a string.

export function listDevicesArgs(): readonly string[] {
  return ["simctl", "list", "devices", "--json"];
}

export function bootArgs(udid: string): readonly string[] {
  return ["simctl", "boot", udid];
}

export function shutdownArgs(udid: string): readonly string[] {
  return ["simctl", "shutdown", udid];
}

/** `simctl bootstatus -b` blocks until the device finishes booting, which is the
 *  difference between "the boot command returned" and "SpringBoard is up". */
export function bootStatusArgs(udid: string): readonly string[] {
  return ["simctl", "bootstatus", udid, "-b"];
}

export function installArgs(udid: string, appPath: string): readonly string[] {
  return ["simctl", "install", udid, appPath];
}

export function uninstallArgs(udid: string, bundleId: string): readonly string[] {
  return ["simctl", "uninstall", udid, bundleId];
}

export function launchArgs(udid: string, bundleId: string): readonly string[] {
  return ["simctl", "launch", udid, bundleId];
}

export function terminateArgs(udid: string, bundleId: string): readonly string[] {
  return ["simctl", "terminate", udid, bundleId];
}

export function listAppsArgs(udid: string): readonly string[] {
  return ["simctl", "listapps", udid];
}

export function openUrlArgs(udid: string, url: string): readonly string[] {
  return ["simctl", "openurl", udid, url];
}

export function privacyGrantArgs(
  udid: string,
  service: string,
  bundleId: string,
): readonly string[] {
  return ["simctl", "privacy", udid, "grant", service, bundleId];
}

/** `simctl io <udid> screenshot <path>`. simctl writes screenshots to a FILE —
 *  there is no stdout form — so the caller supplies a path and reads it back. */
export function screenshotArgs(udid: string, outPath: string): readonly string[] {
  return ["simctl", "io", udid, "screenshot", "--type=png", outPath];
}

// ─── PURE: parsers ────────────────────────────────────────────────────────────

/** The shape `simctl list devices --json` emits: runtime identifier → rows. */
interface SimctlListJson {
  devices?: Record<string, Array<Record<string, unknown>>>;
}

/** Turn `com.apple.CoreSimulator.SimRuntime.iOS-26-5` into `iOS 26.5`. Anything
 *  that does not match the scheme is returned verbatim rather than mangled. */
export function runtimeLabel(runtimeId: string): string {
  const tail = runtimeId.split(".").pop() ?? runtimeId;
  const match = /^([A-Za-z]+)-(\d+)-(\d+)(?:-(\d+))?$/.exec(tail);
  if (!match) return tail;
  const [, os, major, minor, patch] = match;
  return `${os} ${major}.${minor}${patch ? `.${patch}` : ""}`;
}

/** Parse `simctl list devices --json` into device rows, iOS only.
 *
 *  Unavailable devices are dropped: simctl keeps rows for runtimes that are no
 *  longer installed, and offering one as a boot target produces an opaque failure
 *  several seconds later. tvOS / watchOS / visionOS rows are dropped because this
 *  engine drives iOS. */
export function parseDevices(stdout: string): NativeDeviceInfo[] {
  let parsed: SimctlListJson;
  try {
    parsed = JSON.parse(stdout) as SimctlListJson;
  } catch {
    return [];
  }
  const rows: NativeDeviceInfo[] = [];
  for (const [runtimeId, entries] of Object.entries(parsed.devices ?? {})) {
    if (!/SimRuntime\.iOS-/.test(runtimeId)) continue;
    for (const entry of entries) {
      if (entry.isAvailable === false) continue;
      const id = typeof entry.udid === "string" ? entry.udid : undefined;
      const name = typeof entry.name === "string" ? entry.name : undefined;
      if (!id || !name) continue;
      rows.push({
        id,
        name,
        state: typeof entry.state === "string" ? entry.state.toLowerCase() : "unknown",
        runtime: runtimeLabel(runtimeId),
        platform: "ios",
      });
    }
  }
  return rows;
}

/** Choose the simulator to drive. A requested id matches a udid exactly or a
 *  device name exactly; with nothing requested, a booted device wins over a shut
 *  one (booting costs tens of seconds) and the newest runtime wins among equals.
 *  Throws `NoSimulatorError` when nothing matches — never a silent fallback to
 *  some other device, which would run a QA session against the wrong OS. */
export function selectDevice(
  devices: readonly NativeDeviceInfo[],
  requested?: string,
): NativeDeviceInfo {
  if (requested) {
    const match = devices.find((d) => d.id === requested || d.name === requested);
    if (!match) throw new NoSimulatorError(devices, requested);
    return match;
  }
  const booted = devices.filter((d) => d.state === "booted");
  const pool = booted.length ? booted : devices;
  if (!pool.length) throw new NoSimulatorError(devices);
  return [...pool].sort((a, b) => compareRuntime(b.runtime, a.runtime))[0]!;
}

/** Numeric-segment comparison so `iOS 26.5` sorts above `iOS 9.3`, which a
 *  string compare gets backwards. */
function compareRuntime(a: string, b: string): number {
  const segments = (s: string): number[] => (s.match(/\d+/g) ?? []).map(Number);
  const left = segments(a);
  const right = segments(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Parse `simctl listapps`, which emits an OpenStep property list, NOT JSON —
 *  `-j` is accepted and ignored. Rather than carry a plist parser for four
 *  fields, this reads the two lines each app block always has: the top-level
 *  quoted bundle-id key that opens it, and the `CFBundleDisplayName` inside.
 *
 *  Deliberately tolerant. A shape it does not recognise yields fewer rows, and
 *  the caller treats an empty list as "could not enumerate", never as "no apps
 *  are installed" — the plausible-empty answer the substrate conformance gate
 *  exists to catch. */
export function parseInstalledApps(stdout: string): NativeAppInfo[] {
  const apps: NativeAppInfo[] = [];
  let current: NativeAppInfo | undefined;
  for (const line of stdout.split("\n")) {
    const opening = /^\s{4}"?([A-Za-z0-9_.-]+)"?\s*=\s*\{/.exec(line);
    if (opening?.[1]) {
      current = { bundleId: opening[1] };
      apps.push(current);
      continue;
    }
    const display = /^\s*CFBundleDisplayName\s*=\s*"?([^";]+?)"?\s*;/.exec(line);
    if (display?.[1] && current && current.name === undefined) current.name = display[1];
  }
  return apps;
}

/** Pull the pid out of `simctl launch`'s one-line report,
 *  `com.acme.app: 51234`. Returns undefined when the format is not that. */
export function parseLaunchPid(stdout: string): number | undefined {
  const match = /:\s*(\d+)\s*$/.exec(stdout.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

// ─── IO seam: the default runner ──────────────────────────────────────────────

/** The default simctl runner — `execFile("xcrun", args)`. No shell, so no
 *  injection surface. ENOENT maps to the structured `XcodeNotInstalledError`; a
 *  non-zero exit carries simctl's own stderr, which is usually the actionable
 *  part ("Unable to boot device in current state: Booted"). */
export const defaultSimctlRunner: SimctlRunner = (args) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      "xcrun",
      [...args],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, out, errText) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new XcodeNotInstalledError());
            return;
          }
          reject(new Error(`xcrun ${args.join(" ")} failed: ${errText || err.message}`));
          return;
        }
        resolve(out);
      },
    );
  });
