// The six operations the ios-app engine asks of the device it drives (RFC 0014
// §3). `IosSimulator` answers them with `simctl`; `IosPhysicalDevice` answers them
// with `devicectl` and WebDriverAgent. `IosXcuiDriver` and `IosLifecycle` take
// this interface, so neither knows which kind of device it is talking to.

import type { NativeAppInfo } from "../../native-types.js";

export interface IosDeviceHost {
  /** Install a `.app` bundle from a host path. */
  install(appPath: string): Promise<void>;
  launch(bundleId: string): Promise<NativeAppInfo>;
  terminate(bundleId: string): Promise<void>;
  /** The installed apps this host is willing to report. */
  listApps(): Promise<NativeAppInfo[]>;
  /** Open a deep link. */
  openUrl(url: string): Promise<void>;
  /** A full-screen PNG. */
  screenshot(): Promise<Buffer>;
}
