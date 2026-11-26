// `IosPhysicalDevice`: the device host for one allowlisted iPhone (RFC 0014 §3).
// It answers the six `IosDeviceHost` operations with the two tools a phone has:
//
//   install                     devicectl device install app
//   listApps                    devicectl device info apps, cut to the app allowlist
//   launch, terminate           WebDriverAgent /wda/apps/launch, /wda/apps/terminate
//   openUrl                     WebDriverAgent /url
//   screenshot                  WebDriverAgent /screenshot
//
// Every install, launch and terminate passes the app allowlist first (G2, G4).
// An app the allowlist sends to a person (G3) runs only after the tool layer
// recorded that person's approval with `admitOnce`. A deep link needs its scheme
// on the list (G7). Installs, launches and deep links count against the
// session's rate limits (G10), and each one is logged with its bundle id or
// scheme (G13). Every lifecycle call first checks that devicectl still lists the
// phone with its tunnel up (`ios-device-disconnected`). Nothing here
// uninstalls, unlocks or locks.

import type {
  NativeAppDecision,
  NativeAppGuard,
  NativeAppInfo,
  NativeAppVerb,
} from "../../native-types.js";
import { log } from "../../../util/logging.js";
import type { IosDeviceHost } from "./device-host.js";
import { IosDeviceError } from "./device-errors.js";
import { onAppList } from "./device-settings.js";
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
import type { DeviceRateLimiter } from "./device-limits.js";

export interface IosPhysicalDeviceDeps {
  /** The CoreDevice identifier, already matched against the device allowlist. */
  identifier: string;
  wda: WdaClient;
  /** BROWX_IOS_DEVICE_APPS. */
  apps: readonly string[];
  /** BROWX_IOS_DEVICE_URL_SCHEMES. Empty refuses every deep link. */
  schemes: readonly string[];
  limits: DeviceRateLimiter;
  devicectl?: DevicectlRunner;
  plutil?: PlutilRunner;
  /** The WebDriverAgent build `/status` reported, named when a route is missing. */
  wdaBuild?: string;
}

/** WebDriverAgent's answer to a route its build does not serve. */
const MISSING_ROUTE = /unknown command|unhandled endpoint|unknown method/i;

export class IosPhysicalDevice implements IosDeviceHost, NativeAppGuard {
  private readonly devicectl: DevicectlRunner;
  private readonly plutil: PlutilRunner;
  /** `verb:appId` approvals a person gave, each spent by one call. */
  private readonly approved = new Set<string>();

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
    this.deps.limits.take("install");
    try {
      await this.devicectl(installAppArgs(this.deps.identifier, appPath));
    } catch (err) {
      throw new IosDeviceError("ios-device-install-failed", installFailure(err));
    }
    log.info("ios-device: installed", { bundleId });
  }

  async launch(bundleId: string): Promise<NativeAppInfo> {
    this.admit("launch", bundleId);
    await this.assertConnected();
    this.deps.limits.take("launch");
    await this.route("/wda/apps/launch", () => this.deps.wda.launchApp(bundleId));
    log.info("ios-device: launched", { bundleId });
    return { bundleId };
  }

  async terminate(bundleId: string): Promise<void> {
    this.admit("terminate", bundleId);
    await this.assertConnected();
    this.deps.limits.take("launch");
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
    return installed
      .filter((id) => onAppList(this.deps.apps, id))
      .map((bundleId) => ({ bundleId }));
  }

  async openUrl(url: string): Promise<void> {
    const scheme = schemeOf(url);
    if (!this.deps.schemes.includes(scheme)) {
      throw new IosDeviceError(
        "ios-device-scheme-not-allowed",
        `the "${scheme}" scheme is not on BROWX_IOS_DEVICE_URL_SCHEMES, so \`navigate\` does not ` +
          "open it on a phone. " +
          (this.deps.schemes.length === 0
            ? "The list is empty, so every deep link refuses. "
            : `Allowed: ${this.deps.schemes.join(", ")}. `) +
          "On a phone `tel:`, `sms:`, `mailto:` and the settings schemes leave the app under test.",
      );
    }
    this.deps.limits.take("deepLink");
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
    log.info("ios-device: opened deep link", { scheme });
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.deps.wda.screenshot(), "base64");
  }

  /** What a launch or install needs. For an install the bundle id is read from
   *  the bundle, the same read `install` makes. */
  async check(verb: NativeAppVerb, subject: string): Promise<NativeAppDecision> {
    const appId = verb === "install" ? await readBundleId(subject, this.plutil) : subject;
    const verdict = appVerdict(verb, appId, this.deps.apps);
    if (verdict.kind === "refuse") return { kind: "refuse", error: verdict.error.message };
    if (verdict.kind === "confirm") return { kind: "confirm", appId, why: verdict.why };
    return { kind: "allow" };
  }

  admitOnce(verb: NativeAppVerb, appId: string): void {
    this.approved.add(approvalKey(verb, appId));
  }

  forget(verb: NativeAppVerb, appId: string): void {
    this.approved.delete(approvalKey(verb, appId));
  }

  /** Refuse a verb the app allowlist does not allow, spending an approval when
   *  the verb needed one. */
  private admit(verb: AppVerb, bundleId: string): void {
    const verdict = appVerdict(verb, bundleId, this.deps.apps);
    if (verdict.kind === "allow") return;
    if (verdict.kind === "refuse") throw verdict.error;
    if (this.approved.delete(approvalKey(verb, bundleId))) return;
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

function approvalKey(verb: AppVerb, appId: string): string {
  return `${verb}:${appId.toLowerCase()}`;
}

/** devicectl's own reason for a failed install: the first `ERROR:` line, or the
 *  first line. Its `key = value` detail lines can carry the phone's name and
 *  identifiers, so they are dropped. */
export function installFailure(err: unknown): string {
  const lines = (err instanceof Error ? err.message : String(err))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\S+\s*=\s/.test(l));
  return (lines.find((l) => /ERROR:/.test(l)) ?? lines[0] ?? "devicectl failed").slice(0, 300);
}

/** The scheme of a URL, lowercased, without the colon. */
export function schemeOf(url: string): string {
  const m = /^([a-zA-Z][\w+.-]*):/.exec(url);
  return m ? m[1]!.toLowerCase() : "";
}
