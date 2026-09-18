// Simulator and application lifecycle for the ios-app engine — the layer that
// runs the pure `simctl.ts` argv builders in order and parses what comes back:
// boot then wait for boot to finish, install, launch, terminate, list apps,
// screenshot, open a deep link.
//
// Shutdown, uninstall and `simctl privacy grant` are ABSENT, and deliberately.
// Each is one argv line away, and none has a caller: a session does not shut down
// a device it may not have booted, and `grant_permissions` / `app_reset` are RFC
// 0008 tool registrations that have not landed. A method no caller reaches is the
// speculative generality architecture-principles.md §4a forbids; the commit that
// adds the tool adds its argv builder with it.
//
// It is a class only because every call needs the same two things (the runner and
// the device id) and threading both through seven free functions reads worse. It
// holds no simulator state of its own: every method asks simctl, so a device the
// operator shut down behind our back is reported as shut down.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAppInfo, NativeDeviceInfo } from "../../native-types.js";
import {
  bootArgs,
  bootStatusArgs,
  defaultSimctlRunner,
  installArgs,
  launchArgs,
  listAppsArgs,
  listDevicesArgs,
  openUrlArgs,
  parseInstalledApps,
  parseDevices,
  parseLaunchPid,
  screenshotArgs,
  selectDevice,
  terminateArgs,
  type SimctlRunner,
} from "./simctl.js";

/** Enumerate the machine's available iOS simulators. */
export async function listSimulators(
  run: SimctlRunner = defaultSimctlRunner,
): Promise<NativeDeviceInfo[]> {
  return parseDevices(await run(listDevicesArgs()));
}

/** Resolve the device this session should drive — the requested udid or name,
 *  else a booted one, else the newest runtime. Throws `NoSimulatorError`. */
export async function resolveSimulator(
  requested?: string,
  run: SimctlRunner = defaultSimctlRunner,
): Promise<NativeDeviceInfo> {
  return selectDevice(await listSimulators(run), requested);
}

/** simctl's own refusal when a boot is a no-op. Matching it is what makes `boot`
 *  idempotent without a state read that would race the boot itself. */
const ALREADY_BOOTED = /current state: Booted/i;

export class IosSimulator {
  constructor(
    readonly udid: string,
    private readonly run: SimctlRunner = defaultSimctlRunner,
  ) {}

  /** Boot the device and WAIT for it to finish booting. `simctl boot` returns as
   *  soon as the request is accepted, so without `bootstatus` the next command
   *  races SpringBoard and fails for a reason that has nothing to do with it.
   *  Idempotent: booting a booted device is success, not an error. */
  async boot(): Promise<void> {
    try {
      await this.run(bootArgs(this.udid));
    } catch (err) {
      if (!ALREADY_BOOTED.test(err instanceof Error ? err.message : String(err))) throw err;
    }
    await this.run(bootStatusArgs(this.udid));
  }

  /** Install a `.app` bundle. The path is an argv element, never interpolated. */
  async install(appPath: string): Promise<void> {
    await this.run(installArgs(this.udid, appPath));
  }

  /** Launch an installed app, reporting the pid simctl printed. */
  async launch(bundleId: string): Promise<NativeAppInfo> {
    const pid = parseLaunchPid(await this.run(launchArgs(this.udid, bundleId)));
    return { bundleId, ...(pid !== undefined ? { pid } : {}) };
  }

  async terminate(bundleId: string): Promise<void> {
    await this.run(terminateArgs(this.udid, bundleId));
  }

  /** The apps installed on this device. An empty list means "could not
   *  enumerate" as readily as "none installed", so the caller must not render it
   *  as a count — see `parseInstalledApps`. */
  async listApps(): Promise<NativeAppInfo[]> {
    return parseInstalledApps(await this.run(listAppsArgs(this.udid)));
  }

  /** Open a URL scheme — the deep-link form of `navigate` (RFC 0008 §2). */
  async openUrl(url: string): Promise<void> {
    await this.run(openUrlArgs(this.udid, url));
  }

  /** A full-screen PNG. simctl writes screenshots to a file rather than stdout,
   *  so this round-trips through a temp dir OUTSIDE the workspace and deletes it:
   *  the bytes are what the caller asked for, and a capture the agent never asked
   *  to save leaves nothing behind. */
  async screenshot(): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), "browxai-ios-shot-"));
    const file = join(dir, "screen.png");
    try {
      await this.run(screenshotArgs(this.udid, file));
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
