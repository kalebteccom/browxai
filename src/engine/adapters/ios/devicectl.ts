// `xcrun devicectl` plumbing for the ios-app engine's physical-device target
// (RFC 0014 §2). The same split `simctl.ts` has: PURE argv construction and JSON
// parsing, plus a thin IO seam (`DevicectlRunner`) that shells out.
//
// devicectl writes its JSON to a FILE named by `--json-output`, not to stdout.
// The default runner owns that file: it makes a temporary directory outside the
// workspace, appends the flag, reads the file back and deletes the directory, the
// way `IosSimulator.screenshot` handles simctl's file output. So the runner type
// returns parsed JSON, and a fake runner in a test needs no file system.
//
// WHAT THE PARSER KEEPS. A phone's own name is often a person's name, so the
// parser drops it. The hardware UDID is kept on the row because the operator's
// allowlist may name a phone by it, and nothing that renders a row for a caller
// reads it (`toIosDeviceRow` in `device-discovery.ts`).
//
// The field names follow devicectl's output on Xcode 15 and 16. RFC 0014 §17
// lists them as unverified on Xcode 26.5, and the fixture in `devicectl.test.ts`
// is written by hand from that shape, with made-up identifiers.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs an `xcrun devicectl …` command and resolves the JSON it wrote. Injected
 *  so argv construction and parsing test without Xcode or a phone. */
export type DevicectlRunner = (args: readonly string[]) => Promise<unknown>;

/** devicectl is absent: no Xcode, or an Xcode older than 15. */
export class DevicectlNotFoundError extends Error {
  constructor() {
    super(
      "devicectl-missing: `xcrun devicectl` was not found. It ships with Xcode 15 and later. " +
        "Install Xcode, run `xcode-select --install`, and confirm with `xcrun devicectl --version`.",
    );
    this.name = "DevicectlNotFoundError";
  }
}

/** One physical iPhone or iPad as devicectl reports it, with the device name dropped. */
export interface IosPhysicalDevice {
  /** The CoreDevice identifier. The id the engine passes to `--device`. */
  identifier: string;
  /** The hardware UDID. Matched against the allowlist and never rendered. */
  udid?: string;
  /** The marketing name when devicectl has one, else the product type. */
  model: string;
  productType?: string;
  osVersion?: string;
  /** `paired` or `unpaired`, verbatim. */
  pairingState: string;
  /** `connected`, `disconnected` or `unavailable`, verbatim. */
  tunnelState: string;
  /** `wired` or `localNetwork`, verbatim. */
  transport: string;
  /** `enabled` or `disabled`, verbatim. */
  developerMode: string;
  ddiServicesAvailable?: boolean;
}

// ─── PURE: argv construction ──────────────────────────────────────────────────

/** `devicectl list devices`, without the output flag the runner adds. */
export function listDevicesArgs(): readonly string[] {
  return ["devicectl", "list", "devices"];
}

/** `devicectl --version`, the presence probe doctor runs. */
export function versionArgs(): readonly string[] {
  return ["devicectl", "--version"];
}

/** The argv with devicectl's JSON output flag. The path is its own element. */
export function withJsonOutput(args: readonly string[], file: string): readonly string[] {
  return [...args, "--json-output", file];
}

// ─── PURE: parser ─────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const IOS_DEVICE_TYPES = new Set(["iphone", "ipad"]);

/** Whether a hardware block describes an iPhone or iPad on iOS. A Mac, an Apple
 *  Watch, an Apple TV or a Vision Pro is listed by devicectl too, and dropped. */
function isIosPhone(hw: Obj): boolean {
  const platform = str(hw.platform)?.toLowerCase();
  const type = str(hw.deviceType)?.toLowerCase();
  const reality = str(hw.reality)?.toLowerCase();
  if (reality !== undefined && reality !== "physical") return false;
  return platform === "ios" && type !== undefined && IOS_DEVICE_TYPES.has(type);
}

function parseOne(entry: unknown): IosPhysicalDevice | undefined {
  const row = obj(entry);
  const identifier = str(row.identifier);
  const hw = obj(row.hardwareProperties);
  if (!identifier || !isIosPhone(hw)) return undefined;
  const dev = obj(row.deviceProperties);
  const conn = obj(row.connectionProperties);
  const productType = str(hw.productType);
  const udid = str(hw.udid);
  const osVersion = str(dev.osVersionNumber);
  return {
    identifier,
    ...(udid ? { udid } : {}),
    model: str(hw.marketingName) ?? productType ?? "unknown",
    ...(productType ? { productType } : {}),
    ...(osVersion ? { osVersion } : {}),
    pairingState: str(conn.pairingState) ?? "unknown",
    tunnelState: str(conn.tunnelState) ?? "unknown",
    transport: str(conn.transportType) ?? "unknown",
    developerMode: str(dev.developerModeStatus) ?? "unknown",
    ...(typeof dev.ddiServicesAvailable === "boolean"
      ? { ddiServicesAvailable: dev.ddiServicesAvailable }
      : {}),
  };
}

/** Parse the JSON `devicectl list devices --json-output` writes into iPhone and
 *  iPad rows. A shape it does not recognise yields no rows. */
export function parsePhysicalDevices(json: unknown): IosPhysicalDevice[] {
  const devices = obj(obj(json).result).devices;
  if (!Array.isArray(devices)) return [];
  return devices.map(parseOne).filter((d): d is IosPhysicalDevice => d !== undefined);
}

// ─── IO seam: the default runner ──────────────────────────────────────────────

function execXcrun(args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile("xcrun", [...args], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, _o, e) => {
      if (!err) return resolve();
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return reject(new DevicectlNotFoundError());
      reject(new Error(`xcrun ${args.slice(0, 3).join(" ")} failed: ${e || err.message}`));
    });
  });
}

/** The default runner: `execFile("xcrun", [...args, "--json-output", <file>])`,
 *  no shell. The temporary directory sits outside the workspace and is removed
 *  whatever happens. */
export const defaultDevicectlRunner: DevicectlRunner = async (args) => {
  const dir = await mkdtemp(join(tmpdir(), "browxai-devicectl-"));
  const file = join(dir, "out.json");
  try {
    await execXcrun(withJsonOutput(args, file));
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};
