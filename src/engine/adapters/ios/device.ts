// `IosPhysicalDevice`: the device host for one allowlisted iPhone (RFC 0014 §3).
// It answers the six `IosDeviceHost` operations with the two tools a phone has:
//
//   install                     devicectl device install app
//   listApps                    devicectl device info apps, cut to the app allowlist
//   launch, terminate           WebDriverAgent /wda/apps/launch, /wda/apps/terminate
//   openUrl                     WebDriverAgent /url
//   screenshot                  WebDriverAgent /screenshot
//
// Every install, launch and terminate passes the app allowlist first (G2, G4),
// and every lifecycle call first checks that devicectl still lists the phone
// with its tunnel up (`ios-device-disconnected`). Nothing here uninstalls,
// unlocks or locks.

import type { NativeAppInfo } from "../../native-types.js";
import { log } from "../../../util/logging.js";
import type { IosDeviceHost } from "./device-host.js";
import { IosDeviceError } from "./device-errors.js";
import { appVerdict, unapprovedError, type AppVerb } from "./device-app-policy.js";
import { readBundleId, defaultPlutilRunner, type PlutilRunner } from "./bundle-id.js";
import {
  defaultDevicectlRunner,
  installAppArgs,
  listAppsArgs,
  listDevicesArgs,
  parseInstalledAppIds,
  parsePhysicalDevices,
  type DevicectlRunner,
} from "./devicectl.js";
import { WdaCommandError, type WdaClient } from "./wda-client.js";

export interface IosPhysicalDeviceDeps {
  /** The CoreDevice identifier, already matched against the device allowlist. */
  identifier: string;
  wda: WdaClient;
  /** BROWX_IOS_DEVICE_APPS. */
  apps: readonly string[];
  devicectl?: DevicectlRunner;
  plutil?: PlutilRunner;
  /** The WebDriverAgent build `/status` reported, named when a route is missing. */
  wdaBuild?: string;
}

/** WebDriverAgent's answer to a route its build does not serve. */
const MISSING_ROUTE = /unknown command|unhandled endpoint|unknown method/i;

export class IosPhysicalDevice implements IosDeviceHost {
  private readonly devicectl: DevicectlRunner;
  private readonly plutil: PlutilRunner;

  constructor(private readonly deps: IosPhysicalDeviceDeps) {
    this.devicectl = deps.devicectl ?? defaultDevicectlRunner;
    this.plutil = deps.plutil ?? defaultPlutilRunner;
  }

  get identifier(): string {
    return this.deps.identifier;
  }

  async install(appPath: string): Promise<void> {
    await this.assertConnected();
    const bundleId = await readBundleId(appPath, this.plutil);
    this.admit("install", bundleId);
    try {
      await this.devicectl(installAppArgs(this.deps.identifier, appPath));
    } catch (err) {
      throw new IosDeviceError(
        "ios-device-install-failed",
        err instanceof Error ? err.message : String(err),
      );
    }
    log.info("ios-device: installed", { bundleId });
  }

  async launch(bundleId: string): Promise<NativeAppInfo> {
    await this.assertConnected();
    this.admit("launch", bundleId);
    await this.route("/wda/apps/launch", () => this.deps.wda.launchApp(bundleId));
    log.info("ios-device: launched", { bundleId });
    return { bundleId };
  }

  async terminate(bundleId: string): Promise<void> {
    await this.assertConnected();
    this.admit("terminate", bundleId);
    await this.route("/wda/apps/terminate", () => this.deps.wda.terminateApp(bundleId));
    log.info("ios-device: terminated", { bundleId });
  }

  /** The close path (G14): stop the app under test when it is on the allowlist,
   *  and nothing else. Never throws. */
  async terminateOnClose(bundleId: string): Promise<void> {
    if (appVerdict("terminate", bundleId, this.deps.apps).kind !== "allow") return;
    await this.deps.wda.terminateApp(bundleId).catch(() => undefined);
  }

  /** The installed apps that are on the app allowlist. The rest of the phone's
   *  apps are not reported, not even as a count (G2). */
  async listApps(): Promise<NativeAppInfo[]> {
    await this.assertConnected();
    const installed = parseInstalledAppIds(
      await this.devicectl(listAppsArgs(this.deps.identifier)),
    );
    return installed.filter((id) => this.deps.apps.includes(id)).map((bundleId) => ({ bundleId }));
  }

  async openUrl(url: string): Promise<void> {
    try {
      await this.deps.wda.openUrl(url);
    } catch (err) {
      if (err instanceof WdaCommandError && MISSING_ROUTE.test(err.code)) {
        throw new IosDeviceError(
          "ios-device-deeplink-unsupported",
          `the WebDriverAgent build at BROWX_IOS_WDA_URL (${this.build()}) does not serve ` +
            "`POST /session/:id/url`, so `navigate` cannot open a deep link on this phone.",
        );
      }
      throw err;
    }
    log.info("ios-device: opened deep link", { scheme: schemeOf(url) });
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.deps.wda.screenshot(), "base64");
  }

  /** Refuse a verb the app allowlist does not allow. */
  private admit(verb: AppVerb, bundleId: string): void {
    const verdict = appVerdict(verb, bundleId, this.deps.apps);
    if (verdict.kind === "allow") return;
    if (verdict.kind === "refuse") throw verdict.error;
    throw unapprovedError(verb, bundleId, verdict.why);
  }

  /** devicectl still lists the phone with its tunnel up, or `ios-device-disconnected`. */
  private async assertConnected(): Promise<void> {
    let found = false;
    try {
      const devices = parsePhysicalDevices(await this.devicectl(listDevicesArgs()));
      found = devices.some(
        (d) => d.identifier === this.deps.identifier && d.tunnelState === "connected",
      );
    } catch {
      found = false;
    }
    if (!found) {
      throw new IosDeviceError(
        "ios-device-disconnected",
        "devicectl no longer lists the allowlisted phone with a connected tunnel. Wake the " +
          "phone, keep it on the Mac's network or connect it by cable, then call again.",
      );
    }
  }

  private async route(route: string, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (err) {
      if (err instanceof WdaCommandError && MISSING_ROUTE.test(err.code)) {
        throw new IosDeviceError(
          "ios-device-wda-route-missing",
          `the WebDriverAgent build at BROWX_IOS_WDA_URL (${this.build()}) does not serve ` +
            `\`${route}\`.`,
        );
      }
      throw err;
    }
  }

  private build(): string {
    return this.deps.wdaBuild ?? "build unknown";
  }
}

/** The scheme of a URL, lowercased, without the colon. */
export function schemeOf(url: string): string {
  const m = /^([a-zA-Z][\w+.-]*):/.exec(url);
  return m ? m[1]!.toLowerCase() : "";
}
