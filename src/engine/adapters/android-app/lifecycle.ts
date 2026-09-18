// `NativeLifecycle` for the android-app engine — the `app_*` tool family's
// implementation, expressed over `AndroidDevice`.
//
// It is a thin translation and deliberately holds no state: the tool family asks
// the device every time, so an app the operator uninstalled behind our back is
// reported as gone rather than remembered. The one shaping decision is that
// `launch` resolves the launcher activity before starting it, which is what makes
// a missing package report as a missing package — `AndroidDevice.launchApp` owns
// that, and this only names what it returned.

import type { NativeAppTarget, NativeLifecycle } from "../../native-types.js";
import type { AndroidDevice } from "./device.js";

export class AndroidLifecycle implements NativeLifecycle {
  constructor(private readonly device: AndroidDevice) {}

  async apps(includeSystem: boolean): Promise<string[]> {
    return this.device.packages(!includeSystem);
  }

  async install(bundlePath: string, reinstall: boolean): Promise<void> {
    await this.device.install(bundlePath, reinstall);
  }

  async uninstall(appId: string): Promise<void> {
    await this.device.uninstall(appId);
  }

  async launch(appId: string): Promise<NativeAppTarget> {
    return { appId, activity: await this.device.launchApp(appId) };
  }

  async terminate(appId: string): Promise<void> {
    await this.device.terminateApp(appId);
  }

  async reset(appId: string): Promise<void> {
    await this.device.clearApp(appId);
  }

  async foreground(): Promise<NativeAppTarget | null> {
    const fg = await this.device.foreground();
    return fg ? { appId: fg.packageName, activity: fg.activity } : null;
  }
}
