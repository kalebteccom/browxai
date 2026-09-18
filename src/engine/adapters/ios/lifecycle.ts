// `NativeLifecycle` for the ios-app engine — the same `app_*` tool family the
// android engine serves, over `simctl`.
//
// FIVE VERBS ARE REAL AND TWO REFUSE, AND THE TWO REFUSE STRUCTURALLY. `simctl`
// has `listapps`, `install`, `launch` and `terminate`, and WebDriverAgent reports
// the frontmost application, so `apps` / `install` / `launch` / `terminate` /
// `foreground` are real. `uninstall` and `reset` are NOT: `simctl uninstall`
// removes an app the operator may have installed themselves and there is no
// per-app data clear at all — erasing the device is the only primitive, and it
// takes every other app's state with it. Both throw `NativeUnsupportedError`
// naming the engine and what is missing, because `app_reset` answering `ok:true`
// having cleared nothing is exactly the plausible-empty the sub-interface gate
// exists to prevent one layer down.
//
// `launch` reports no `activity`: iOS has no activity, and inventing a screen
// name the platform never reported would put a guess in the session's own record
// of what it is driving.

import {
  NativeUnsupportedError,
  type NativeAppTarget,
  type NativeDriver,
  type NativeLifecycle,
} from "../../native-types.js";
import type { IosSimulator } from "./simulator.js";

export class IosLifecycle implements NativeLifecycle {
  constructor(
    private readonly sim: IosSimulator,
    private readonly driver: NativeDriver,
  ) {}

  async apps(_includeSystem: boolean): Promise<string[]> {
    // `simctl listapps` reports user apps and the system apps the runtime ships
    // in one plist with no flag to separate them, so `includeSystem` has nothing
    // to select on and the full list is what there is. Filtering on a bundle-id
    // prefix would be a guess dressed as a category.
    return (await this.sim.listApps()).map((a) => a.bundleId);
  }

  async install(bundlePath: string, _reinstall: boolean): Promise<void> {
    // `simctl install` replaces an existing install and keeps the container, so
    // it already behaves as `reinstall` and there is no second mode to select.
    await this.sim.install(bundlePath);
  }

  // `async` with no `await`, deliberately: a bare `throw` from a method typed
  // `Promise<void>` fires synchronously at the call site, before the caller's
  // `await` exists to catch it. `async` turns it into the rejection the port
  // promises. Same reasoning the substrate-adapter-async rule encodes.
  // eslint-disable-next-line @typescript-eslint/require-await
  async uninstall(appId: string): Promise<void> {
    throw new NativeUnsupportedError(
      "ios-app",
      "app_uninstall",
      `browxai does not uninstall "${appId}" from a simulator. \`simctl uninstall\` would remove ` +
        "an app the operator may have installed by hand, on a device this session leases rather " +
        "than owns. Remove it with `xcrun simctl uninstall <udid> <bundle-id>` if you mean to.",
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async reset(appId: string): Promise<void> {
    throw new NativeUnsupportedError(
      "ios-app",
      "app_reset",
      `iOS has no per-app data clear. The only primitive is \`xcrun simctl erase\`, which wipes ` +
        `EVERY app on the device, not just "${appId}". Reinstalling the .app bundle, or erasing ` +
        "the simulator yourself between runs, is the honest way to start from a known state.",
    );
  }

  async launch(appId: string): Promise<NativeAppTarget> {
    await this.sim.launch(appId);
    return { appId };
  }

  async terminate(appId: string): Promise<void> {
    await this.sim.terminate(appId);
  }

  async foreground(): Promise<NativeAppTarget | null> {
    const app = await this.driver.foregroundApp().catch(() => undefined);
    return app ? { appId: app.bundleId } : null;
  }
}
