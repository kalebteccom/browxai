// `browxai doctor` ios-device rows: whether the ios-app engine's physical-device
// target (RFC 0014 §7) is set up on this Mac.
//
// The group appears when BROWX_IOS_TARGET is `device`, or when the selected engine
// is `ios-app` (then one informational row says the target is the simulator).
// Every row is informational, passing or a warning. None fails doctor. The rows
// print the phone's model and iOS version, and never a device name, a UDID or the
// phone's address. Commands and HTTP are injected, so the rows test with fakes.

import type { Check } from "./doctor.js";
import { runCommand, type CommandRunner } from "./macos-app.js";
import {
  defaultDevicectlRunner,
  defaultWdaHttp,
  deviceAllowlistFrom,
  deviceAppsFrom,
  devicectlListDevicesArgs,
  devicectlVersionArgs,
  iosTargetFrom,
  isAllowlisted,
  namedDeviceEntry,
  parsePhysicalDevices,
  partitionByAllowlist,
  type DevicectlRunner,
  type DevicectlDevice,
  type WdaHttp,
} from "../engine/index.js";

const NAME = "ios-device";

export interface IosDeviceDoctorDeps {
  env?: NodeJS.ProcessEnv;
  /** Whether the selected engine is `ios-app`. doctor.ts decides it. */
  iosEngineSelected?: boolean;
  run?: CommandRunner;
  devicectl?: DevicectlRunner;
  http?: WdaHttp;
}

const pass = (detail: string): Check => ({ name: NAME, ok: true, detail });
const warn = (detail: string, fix: string): Check => ({
  name: NAME,
  ok: true,
  warn: true,
  detail,
  fix,
});
const info = (detail: string, enable?: string): Check => ({
  name: NAME,
  ok: true,
  info: true,
  detail,
  ...(enable ? { enable } : {}),
});

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160);
}

/** The ios-device rows, or none when neither the target nor the engine asks for them. */
export async function iosDeviceChecks(deps: IosDeviceDoctorDeps = {}): Promise<Check[]> {
  const env = deps.env ?? process.env;
  let target: string;
  try {
    target = iosTargetFrom(env);
  } catch (err) {
    return [warn(message(err), "set BROWX_IOS_TARGET to `simulator` or `device`, or unset it")];
  }
  if (target === "simulator") {
    if (!deps.iosEngineSelected) return [];
    return [
      info(
        "target simulator. The phone checks run when BROWX_IOS_TARGET is `device`",
        "BROWX_IOS_TARGET=device and BROWX_IOS_DEVICE_ALLOWLIST=<identifier>",
      ),
    ];
  }
  const rows = [allowlistRow(env)];
  const tool = devicectlRow(deps.run ?? runCommand);
  rows.push(tool);
  const phone = tool.warn
    ? undefined
    : await phoneRows(env, deps.devicectl ?? defaultDevicectlRunner, rows);
  rows.push(...(await wdaRows(env, deps.http ?? defaultWdaHttp(3_000), phone)));
  return rows;
}

function devicectlRow(run: CommandRunner): Check {
  const r = run("xcrun", devicectlVersionArgs());
  if (r.status === 0) {
    const version = r.stdout.trim().split("\n")[0]?.trim();
    return pass(`devicectl present${version ? ` (${version})` : ""}`);
  }
  return warn(
    "devicectl not found",
    "install Xcode 15 or later, run `xcode-select --install`, then `xcrun devicectl --version`",
  );
}

/** Each allowlist problem as one sentence. */
function allowlistProblems(env: NodeJS.ProcessEnv): string[] {
  const phones = deviceAllowlistFrom(env);
  const apps = deviceAppsFrom(env);
  const requested = env.BROWX_IOS_DEVICE?.trim();
  const appId = env.BROWX_IOS_APP_ID?.trim();
  const problems: string[] = [];
  if (phones.length === 0) {
    problems.push(
      "list the phone's CoreDevice identifier or hardware UDID in BROWX_IOS_DEVICE_ALLOWLIST.",
    );
  }
  if (requested && !phones.includes(requested)) {
    problems.push("BROWX_IOS_DEVICE is not on BROWX_IOS_DEVICE_ALLOWLIST.");
  }
  if (!requested && phones.length > 1) {
    problems.push("more than one phone is allowlisted, so name one with BROWX_IOS_DEVICE.");
  }
  if (apps.length === 0) {
    problems.push("list the app under test's bundle id in BROWX_IOS_DEVICE_APPS.");
  } else if (appId && !apps.includes(appId)) {
    problems.push("BROWX_IOS_APP_ID is not on BROWX_IOS_DEVICE_APPS.");
  }
  return problems;
}

function allowlistRow(env: NodeJS.ProcessEnv): Check {
  const phones = deviceAllowlistFrom(env).length;
  const apps = deviceAppsFrom(env).length;
  const detail =
    `allowlist: ${phones} ${phones === 1 ? "phone" : "phones"}, ` +
    `${apps} ${apps === 1 ? "app" : "apps"}`;
  const problems = allowlistProblems(env);
  return problems.length ? warn(detail, problems.join(" ")) : pass(detail);
}

/** The found-phone row and its four state rows. Returns the named phone, or undefined. */
async function phoneRows(
  env: NodeJS.ProcessEnv,
  devicectl: DevicectlRunner,
  rows: Check[],
): Promise<DevicectlDevice | undefined> {
  let devices: DevicectlDevice[];
  try {
    devices = parsePhysicalDevices(await devicectl(devicectlListDevicesArgs()));
  } catch (err) {
    rows.push(warn(`devicectl list devices failed: ${message(err)}`, "run doctor again"));
    return undefined;
  }
  const { allowed, notAllowed } = partitionByAllowlist(devices, deviceAllowlistFrom(env));
  const entry = namedDeviceEntry(env);
  const phone = entry ? allowed.find((d) => isAllowlisted(d, [entry])) : undefined;
  if (!phone) {
    rows.push(
      warn(
        `no named allowlisted phone listed (${allowed.length} allowlisted, ${notAllowed} other)`,
        "connect the phone by cable or pair it for network use in Xcode, Devices and Simulators. " +
          "Keep its screen on and check the allowlist row above",
      ),
    );
    return undefined;
  }
  rows.push(pass(`found ${phone.model}, iOS ${phone.osVersion ?? "unknown"}, ${phone.transport}`));
  rows.push(...stateRows(phone));
  return phone;
}

function stateRows(phone: DevicectlDevice): Check[] {
  const trust =
    phone.pairingState === "paired"
      ? pass("trust: paired")
      : warn(`trust: ${phone.pairingState}`, "tap Trust on the phone when it asks");
  const tunnel =
    phone.tunnelState === "connected"
      ? pass(`tunnel: connected over ${phone.transport}`)
      : warn(
          `tunnel: ${phone.tunnelState}`,
          "keep the phone awake and on the Mac's network, or connect it by cable. A network phone may connect only after a first devicectl command",
        );
  const devMode =
    phone.developerMode === "enabled"
      ? pass("Developer Mode: enabled")
      : warn(
          `Developer Mode: ${phone.developerMode}`,
          "turn it on in Settings, Privacy & Security, Developer Mode, and restart the phone",
        );
  const ddi =
    phone.ddiServicesAvailable === true
      ? pass("developer services: available")
      : warn(
          "developer services: not available",
          "open Xcode's Devices and Simulators window with the phone connected so it mounts the developer disk image",
        );
  return [trust, tunnel, devMode, ddi];
}

type Answer = { answered: false } | { answered: true; ok: boolean; value: unknown };

async function getValue(http: WdaHttp, url: string): Promise<Answer> {
  try {
    const r = await http(url, { method: "GET" });
    let value: unknown;
    try {
      value = (JSON.parse(r.text) as { value?: unknown }).value;
    } catch {
      value = undefined;
    }
    return { answered: true, ok: r.ok, value };
  } catch {
    return { answered: false };
  }
}

const LOOPBACK = new Set(["localhost", "::1", "[::1]"]);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || /^127\./.test(host);
}

/** The WebDriverAgent base URL, or the warning row that explains why there is none. */
function wdaBase(env: NodeJS.ProcessEnv): string | Check {
  const raw = env.BROWX_IOS_WDA_URL?.trim();
  const start =
    "start WebDriverAgent on the phone, then set BROWX_IOS_WDA_URL to http://<phone address>:8100";
  if (!raw) return warn("WebDriverAgent URL: BROWX_IOS_WDA_URL is unset", start);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return warn("WebDriverAgent URL: BROWX_IOS_WDA_URL is not a URL", start);
  }
  if (isLoopback(url.hostname)) {
    return warn(
      "WebDriverAgent URL: points at this Mac",
      "a loopback address reaches a simulator's WebDriverAgent, not the phone's. Set the phone's address",
    );
  }
  return raw.replace(/\/+$/, "");
}

function unreachableFix(phone: DevicectlDevice | undefined): string {
  const runner = "check that the runner is running on the phone and its screen is not locked";
  const localNetwork =
    "allow the program that started browxai in System Settings, Privacy & Security, Local Network";
  return phone?.tunnelState === "connected"
    ? `${localNetwork}. Then ${runner}`
    : `${runner}. Then ${localNetwork}`;
}

async function wdaRows(
  env: NodeJS.ProcessEnv,
  http: WdaHttp,
  phone: DevicectlDevice | undefined,
): Promise<Check[]> {
  const base = wdaBase(env);
  if (typeof base !== "string") return [base];
  const status = await getValue(http, `${base}/status`);
  if (!status.answered) {
    return [warn("WebDriverAgent: no answer at BROWX_IOS_WDA_URL", unreachableFix(phone))];
  }
  const value = status.value as { ready?: unknown } | undefined;
  if (!status.ok || value?.ready === false) {
    return [warn("WebDriverAgent: answered and is not ready", "restart the runner on the phone")];
  }
  return [pass("WebDriverAgent: ready"), buildRow(status.value, phone), await lockRow(http, base)];
}

function buildRow(value: unknown, phone: DevicectlDevice | undefined): Check {
  const v = (value ?? {}) as { os?: { version?: unknown }; ios?: { simulatorVersion?: unknown } };
  if (v.ios?.simulatorVersion !== undefined) {
    return warn(
      "WebDriverAgent build: reports a simulator",
      "BROWX_IOS_WDA_URL reaches a simulator's WebDriverAgent. Set the phone's address",
    );
  }
  const wdaOs = typeof v.os?.version === "string" ? v.os.version : undefined;
  if (!wdaOs) return info("WebDriverAgent build: no iOS version in /status");
  if (phone?.osVersion && phone.osVersion !== wdaOs) {
    return warn(
      `WebDriverAgent build: iOS ${wdaOs}, devicectl reports iOS ${phone.osVersion}`,
      "BROWX_IOS_WDA_URL may reach another device. Check the address",
    );
  }
  return pass(`WebDriverAgent build: iOS ${wdaOs}`);
}

async function lockRow(http: WdaHttp, base: string): Promise<Check> {
  const locked = await getValue(http, `${base}/wda/locked`);
  if (locked.answered && locked.ok && locked.value === true) {
    return warn("lock state: locked", "open the phone with its passcode. browxai never does");
  }
  if (locked.answered && locked.ok && locked.value === false) return pass("lock state: open");
  return info("lock state: unknown, WebDriverAgent did not answer /wda/locked");
}
