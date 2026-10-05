// The device gate for the android-app keystone.
//
// `adb devices` listing a `device` row only proves adbd answered. An emulator
// reaches that state about a minute before the system is up, and a session
// opened then dumps an empty hierarchy, which reads as a broken engine. So the
// gate has three outcomes, and only the first one skips:
//
//   - "absent"   no adb, or adb lists no device (for the requested serial, when
//                one is set). Nothing to test against, so the live lane skips.
//   - "ready"    a listed device passes every probe below.
//   - "unusable" a device IS listed but fails a probe (offline, unauthorized,
//                `sys.boot_completed` not 1, package manager silent, or the
//                UiAutomator dump returns no hierarchy). The live lane must FAIL
//                on this: skipping would report green on a broken environment.
//
// Probes mirror what the engine itself treats as usable (`sys.boot_completed`
// plus a package-manager round trip) and add the one thing the keystone depends
// on, the automation server: `uiautomator dump` answering with a hierarchy.

import { execFileSync } from "node:child_process";

export type DeviceGate =
  { kind: "absent" } | { kind: "ready"; serial: string } | { kind: "unusable"; reason: string };

/** Runs `adb <args>` and returns stdout. Throws on non-zero exit, timeout or a
 *  missing binary. Injectable so the probe logic has one code path. */
export type AdbRun = (args: readonly string[], timeoutMs: number) => string;

const defaultRun: AdbRun = (args, timeoutMs) =>
  execFileSync("adb", [...args], {
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const PROBE_TIMEOUT_MS = 8000;
/** `uiautomator dump` waits for the window to go idle (gives up near 10s) and
 *  can fail once on a screen that is still animating right after boot. */
const DUMP_TIMEOUT_MS = 20_000;
const DUMP_ATTEMPTS = 3;

interface Row {
  serial: string;
  state: string;
}

function listRows(run: AdbRun): Row[] {
  const rows: Row[] = [];
  for (const line of run(["devices"], 5000).split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state) rows.push({ serial, state });
  }
  return rows;
}

/** Why `serial` is not usable, or undefined when it passes every probe. */
function probeFailure(run: AdbRun, serial: string): string | undefined {
  const adb = (args: string[], timeoutMs = PROBE_TIMEOUT_MS): string =>
    run(["-s", serial, ...args], timeoutMs);
  try {
    const booted = adb(["shell", "getprop", "sys.boot_completed"]).trim();
    if (booted !== "1") {
      return `${serial}: sys.boot_completed is ${JSON.stringify(booted)}, not "1" (still booting)`;
    }
  } catch (err) {
    return `${serial}: could not read sys.boot_completed (${(err as Error).message.split("\n")[0]})`;
  }
  try {
    if (!/package:/.test(adb(["shell", "pm", "list", "packages"], 15_000))) {
      return `${serial}: the package manager returned no packages`;
    }
  } catch (err) {
    return `${serial}: the package manager did not answer (${(err as Error).message.split("\n")[0]})`;
  }
  let last = "";
  for (let attempt = 1; attempt <= DUMP_ATTEMPTS; attempt++) {
    try {
      last = adb(["exec-out", "uiautomator", "dump", "/dev/tty"], DUMP_TIMEOUT_MS);
      if (last.includes("<hierarchy")) return undefined;
    } catch (err) {
      last = (err as Error).message.split("\n")[0] ?? "";
    }
  }
  return `${serial}: the UiAutomator server returned no hierarchy after ${DUMP_ATTEMPTS} attempts (${JSON.stringify(last.slice(0, 120))})`;
}

/** Decide whether the live android-app lane skips, runs, or must fail.
 *  `serial` narrows the check to one device, matching BROWX_ANDROID_APP_SERIAL. */
export function androidAppDeviceGate(
  serial: string | undefined = process.env.BROWX_ANDROID_APP_SERIAL,
  run: AdbRun = defaultRun,
): DeviceGate {
  let rows: Row[];
  try {
    rows = listRows(run);
  } catch {
    return { kind: "absent" };
  }
  if (serial) rows = rows.filter((r) => r.serial === serial);
  if (rows.length === 0) return { kind: "absent" };

  const listed = rows.filter((r) => r.state === "device");
  if (listed.length === 0) {
    return {
      kind: "unusable",
      reason: `adb lists ${rows.map((r) => `${r.serial} (${r.state})`).join(", ")}, none in the "device" state`,
    };
  }
  const failures: string[] = [];
  for (const row of listed) {
    const failure = probeFailure(run, row.serial);
    if (!failure) return { kind: "ready", serial: row.serial };
    failures.push(failure);
  }
  return { kind: "unusable", reason: failures.join("; ") };
}
