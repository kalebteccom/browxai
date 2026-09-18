// Device and emulator lifecycle for the `android-app` engine — enumerate, boot,
// wait for readiness, shut down.
//
// THIS IS NOT ON `open_session`. RFC 0008 §2 put the device and the app on the
// session options; building it showed that to be the wrong shape, and the tools
// here are the correction. An emulator takes 30-90 seconds to cold-boot, an
// agent needs to SEE which devices exist before choosing one, and installing an
// APK is an operation with its own failure modes that an agent has to be able to
// retry. Folding all of that into session creation would make `open_session`
// either a 90-second call that can fail six ways, or a call that silently picks
// a device. So lifecycle is tools, and `open_session` leases a device that is
// already up.
//
// The seams are injected for the same reason `AndroidCdpAdapter`'s are: the argv
// construction, the boot-readiness polling and the AVD parsing are unit-tested
// with no SDK installed.

import { spawn } from "node:child_process";
// `devicesArgs` / `parseDevices` are the shipped Android engine's, reused
// verbatim: `adb devices` is one command with one output format whichever engine
// asks, and a second parser for it would be a second thing to keep right.
import { devicesArgs, parseDevices } from "../adb.js";
import {
  emulatorKillArgs,
  isEmulatorSerial,
  parseAvds,
  type AndroidDeviceInfo,
} from "./adb-commands.js";
import { AndroidDevice, NativeDeviceError, type AndroidDeviceIO } from "./device.js";

/** The injected lifecycle seams. */
export interface AndroidEmulatorDeps {
  /** The adb transport every device read goes through. */
  io?: AndroidDeviceIO;
  /** Run the `emulator` binary and resolve its stdout — used only for
   *  `-list-avds`, which returns promptly. Booting does NOT go through here,
   *  because a booting emulator never exits. */
  runEmulator?: (args: readonly string[]) => Promise<string>;
  /** Start an emulator process detached and return immediately. */
  startEmulator?: (args: readonly string[]) => void;
  /** Injected so the readiness poll is testable without real time. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** How long to wait for a cold boot before giving up. A cold boot of a modern
 *  system image on a warm host is 30-60s; 5 minutes is generous enough that a
 *  timeout means something is actually wrong. */
const BOOT_TIMEOUT_MS = 300_000;
const BOOT_POLL_MS = 2_000;

/** The emulator binary's name. Resolved from PATH, and `$ANDROID_HOME/emulator`
 *  is checked because the SDK does not put it on PATH by default — which is the
 *  single most common reason this refuses on a machine that does have an SDK. */
function emulatorCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT].filter((r): r is string => Boolean(r));
  return ["emulator", ...roots.map((r) => `${r}/emulator/emulator`)];
}

export class AndroidEmulatorAdapter {
  private readonly io: AndroidDeviceIO;
  private readonly runEmulator: (args: readonly string[]) => Promise<string>;
  private readonly startEmulator: (args: readonly string[]) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: AndroidEmulatorDeps = {}) {
    this.io = deps.io ?? lazyDefaultIO();
    this.runEmulator = deps.runEmulator ?? defaultRunEmulator;
    this.startEmulator = deps.startEmulator ?? defaultStartEmulator;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  /** Every attached device and emulator, with the model and API level an agent
   *  needs to pick one. A device that is not `device` state (unauthorized,
   *  offline, still booting) is LISTED with its state rather than hidden — the
   *  state is the actionable part. */
  async devices(): Promise<AndroidDeviceInfo[]> {
    const rows = parseDevices(await this.io.text(devicesArgs()));
    return Promise.all(rows.map((row) => this.describe(row.serial, row.state)));
  }

  private async describe(serial: string, state: string): Promise<AndroidDeviceInfo> {
    const info: AndroidDeviceInfo = { serial, state, emulator: isEmulatorSerial(serial) };
    if (state !== "device") return info;
    const device = new AndroidDevice(serial, this.io);
    const [model, release, sdk] = await Promise.all([
      device.prop("ro.product.model").catch(() => ""),
      device.prop("ro.build.version.release").catch(() => ""),
      device.sdkLevel().catch(() => 0),
    ]);
    return {
      ...info,
      ...(model ? { model } : {}),
      ...(release ? { release } : {}),
      ...(sdk ? { sdk } : {}),
    };
  }

  /** The AVDs the operator has defined. browxai never creates one: an AVD picks a
   *  system image, a device profile and a disk allocation, all of which are the
   *  operator's call, and the SDK is operator-supplied by the same rule that
   *  keeps Xcode out of the bundle. */
  async avds(): Promise<string[]> {
    return parseAvds(await this.runEmulator(["-list-avds"]));
  }

  /** Boot an AVD and wait until it is usable.
   *
   *  "Usable" is `sys.boot_completed` AND a successful package-manager call, not
   *  just an adb connection: `adb wait-for-device` returns as soon as adbd is up,
   *  which is a minute before the launcher exists, and a session opened at that
   *  point dumps an empty hierarchy and looks like a broken app. */
  async boot(avd: string, opts: { headless?: boolean } = {}): Promise<AndroidDeviceInfo> {
    const known = await this.avds();
    if (!known.includes(avd)) {
      throw new NativeDeviceError(
        "native-avd-not-found",
        `no AVD named "${avd}". Defined AVDs: ${known.length ? known.join(", ") : "(none)"}. ` +
          "Create one in Android Studio's Device Manager — browxai never creates an AVD, because " +
          "the system image, device profile and disk allocation are the operator's choice.",
      );
    }
    const before = new Set((await this.devices()).map((d) => d.serial));
    this.startEmulator([
      "-avd",
      avd,
      ...(opts.headless === false ? [] : ["-no-window"]),
      "-no-audio",
      // Never write a snapshot back: a session that installs an app and grants
      // permissions would otherwise persist that into the operator's AVD.
      "-no-snapshot-save",
    ]);
    return this.waitForNewDevice(before, avd);
  }

  private async waitForNewDevice(before: Set<string>, avd: string): Promise<AndroidDeviceInfo> {
    const deadline = this.now() + BOOT_TIMEOUT_MS;
    while (this.now() < deadline) {
      await this.sleep(BOOT_POLL_MS);
      const fresh = (await this.devices().catch(() => [])).filter(
        (d) => !before.has(d.serial) && d.state === "device",
      );
      for (const candidate of fresh) {
        if (await this.isBooted(candidate.serial)) return candidate;
      }
    }
    throw new NativeDeviceError(
      "native-boot-timeout",
      `"${avd}" did not finish booting within ${BOOT_TIMEOUT_MS / 1000}s. Check the emulator ` +
        "window or run `emulator -avd " +
        avd +
        "` by hand to see what it reports — a missing KVM/HAXM accelerator is the usual cause.",
    );
  }

  /** `sys.boot_completed` plus a package-manager round trip. The second half is
   *  what separates "adbd answered" from "the system is up". */
  private async isBooted(serial: string): Promise<boolean> {
    const device = new AndroidDevice(serial, this.io);
    if ((await device.prop("sys.boot_completed").catch(() => "")) !== "1") return false;
    return device
      .packages(false)
      .then((p) => p.length > 0)
      .catch(() => false);
  }

  /** Shut an emulator down. A PHYSICAL device refuses: browxai does not power off
   *  the operator's phone, and `emu kill` has no meaning there anyway. */
  async shutdown(serial: string): Promise<void> {
    if (!isEmulatorSerial(serial)) {
      throw new NativeDeviceError(
        "native-shutdown-refused",
        `"${serial}" is not an emulator. browxai shuts down emulators it can identify by serial ` +
          "and never powers off a physical device — disconnect it, or stop it from the device " +
          "itself.",
      );
    }
    await this.io.text(emulatorKillArgs(serial));
  }
}

/** Built lazily so importing this module does not resolve `adb` on PATH. */
function lazyDefaultIO(): AndroidDeviceIO {
  let real: AndroidDeviceIO | undefined;
  const get = async (): Promise<AndroidDeviceIO> => {
    real ??= (await import("./device.js")).defaultDeviceIO();
    return real;
  };
  return {
    text: async (args, timeoutMs) => (await get()).text(args, timeoutMs),
    binary: async (args, timeoutMs) => (await get()).binary(args, timeoutMs),
  };
}

const defaultRunEmulator = async (args: readonly string[]): Promise<string> => {
  const { execFile } = await import("node:child_process");
  for (const bin of emulatorCandidates(process.env)) {
    const out = await new Promise<string | null>((resolve) => {
      execFile(bin, [...args], { timeout: 30_000 }, (err, stdout) =>
        resolve(err && (err as NodeJS.ErrnoException).code === "ENOENT" ? null : stdout),
      );
    });
    if (out !== null) return out;
  }
  throw new NativeDeviceError(
    "emulator-missing",
    "the Android `emulator` binary was not found. It ships with the SDK but is NOT on PATH by " +
      "default — add `$ANDROID_HOME/emulator` to PATH, or set ANDROID_HOME.",
  );
};

/** Start the emulator detached. It never exits while running, so it is spawned
 *  with its stdio discarded and unref'd — the server must not hold a handle that
 *  keeps Node alive after the session closes. */
const defaultStartEmulator = (args: readonly string[]): void => {
  for (const bin of emulatorCandidates(process.env)) {
    try {
      const child = spawn(bin, [...args], { detached: true, stdio: "ignore" });
      child.unref();
      // `spawn` reports ENOENT asynchronously; a listener keeps it from becoming
      // an unhandled error event, and the boot poll reports the real failure.
      child.on("error", () => undefined);
      return;
    } catch {
      continue;
    }
  }
  throw new NativeDeviceError(
    "emulator-missing",
    "the Android `emulator` binary was not found on PATH or under $ANDROID_HOME/emulator.",
  );
};
