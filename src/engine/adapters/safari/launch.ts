// safaridriver process lifecycle for the SafaridriverHybridAdapter (RFC 0002 P4)
// — spawn the driver, poll it to readiness, and own its teardown. Split into a
// platform/binary precheck + the spawn/poll, with the IO seams (spawn, the
// readiness probe, the sleep) injected so the orchestration unit-tests WITHOUT a
// real safaridriver — the same discipline as adb.ts. The real IO path is covered
// by the Safari-gated keystone.
//
// safaridriver is macOS-only and ships inside the Safari cryptex
// (`/usr/bin/safaridriver` → `/System/Cryptexes/App/usr/bin/safaridriver`). It
// is launched as `safaridriver -p <httpPort> --bidi <bidiPort>`: the HTTP port
// serves WebDriver Classic + session creation; `--bidi` enables BiDi for hosted
// sessions (the actual ws:// socket is allocated dynamically and reported in the
// granted caps — see docs/rfcs/references/06-safari-bidi-probe.md, NOT bound to
// the passed port value).

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { SafariWebDriverClient } from "./webdriver-client.js";

/** Canonical safaridriver path (the symlink in /usr/bin resolves into the Safari
 *  cryptex). Overridable in tests via `SafariLaunchDeps.driverPath`. */
export const SAFARIDRIVER_PATH = "/usr/bin/safaridriver";

/** The minimal child-process surface the launcher owns. Satisfied by Node's
 *  `ChildProcess`; the test double records the kill. */
export interface ProcessLike {
  readonly pid?: number;
  kill(): boolean;
}

export type SpawnLike = (cmd: string, args: string[]) => ProcessLike;

/** Raised when Safari automation cannot run on this host at all — not macOS, or
 *  safaridriver is absent. Structured (no vague crash) per the doctrine, naming
 *  the fix. */
export class SafariUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `safari-unavailable: ${reason}. Real Safari automation needs macOS with safaridriver ` +
        `(${SAFARIDRIVER_PATH}). See docs/rfcs/references/07-safari-adapter-implementation-plan.md.`,
    );
    this.name = "SafariUnavailableError";
  }
}

/** Raised when safaridriver never reaches readiness within the poll window. */
export class SafariLaunchTimeoutError extends Error {
  constructor(ms: number) {
    super(`safari-launch-timeout: safaridriver did not become ready within ${ms}ms`);
    this.name = "SafariLaunchTimeoutError";
  }
}

/** Injectable IO seams (defaults shell out / probe for real). */
export interface SafariLaunchDeps {
  spawnImpl?: SpawnLike;
  /** Resolve a free loopback port (defaults to adb.ts's `pickFreePort`). */
  pickPort?: () => Promise<number>;
  /** Probe whether a driver at `baseUrl` is ready (defaults to a real GET
   *  /status). Injected so the poll loop tests without a driver. */
  probeReady?: (baseUrl: string) => Promise<boolean>;
  /** Whether the safaridriver binary exists (defaults to a real `statSync`). */
  binaryExists?: (path: string) => boolean;
  /** The host platform (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
  /** Override the driver path (tests). */
  driverPath?: string;
  /** Sleep between readiness polls (injected so tests don't wait). */
  sleep?: (ms: number) => Promise<void>;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** A running safaridriver. `baseUrl` is the WebDriver HTTP endpoint; `stop()`
 *  kills the process. */
export interface SafariDriverProcess {
  baseUrl: string;
  httpPort: number;
  process: ProcessLike;
  stop(): void;
}

function defaultBinaryExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function defaultSpawn(cmd: string, args: string[]): ProcessLike {
  // detached:false — the driver dies with the parent; stdio ignored (we talk to
  // it over HTTP, not its stdout).
  return execFile(cmd, args, () => undefined);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Platform + binary precheck. Throws `SafariUnavailableError` off-macOS or when
 *  safaridriver is absent — the launch fast-fails with a clear reason rather than
 *  spawning a doomed process. */
export function assertSafariAvailable(deps: SafariLaunchDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new SafariUnavailableError(`host platform is "${platform}", not macOS`);
  }
  const driverPath = deps.driverPath ?? SAFARIDRIVER_PATH;
  const exists = deps.binaryExists ?? defaultBinaryExists;
  if (!exists(driverPath)) {
    throw new SafariUnavailableError(`safaridriver not found at ${driverPath}`);
  }
}

/** Spawn safaridriver and poll it to readiness. Pre-checks availability, picks a
 *  free HTTP port (+ a BiDi port), spawns `safaridriver -p <http> --bidi <bidi>`,
 *  then polls GET /status until ready or the timeout — killing the process if it
 *  never comes up (no leaked driver). */
export async function launchSafaridriver(
  deps: SafariLaunchDeps = {},
): Promise<SafariDriverProcess> {
  assertSafariAvailable(deps);

  const { pickFreePort } = await import("../adb.js");
  const pickPort = deps.pickPort ?? pickFreePort;
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.readinessTimeoutMs ?? 10_000;
  const intervalMs = deps.pollIntervalMs ?? 150;
  const driverPath = deps.driverPath ?? SAFARIDRIVER_PATH;

  const httpPort = await pickPort();
  const bidiPort = await pickPort();
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const probeReady =
    deps.probeReady ??
    ((url: string) => new SafariWebDriverClient({ baseUrl: url }).status().then((s) => s.ready));

  const proc = spawnImpl(driverPath, ["-p", String(httpPort), "--bidi", String(bidiPort)]);
  const stop = (): void => {
    try {
      proc.kill();
    } catch {
      /* already dead */
    }
  };

  const deadline = timeoutMs / intervalMs;
  for (let attempt = 0; attempt < deadline; attempt++) {
    if (await probeReady(baseUrl)) {
      return { baseUrl, httpPort, process: proc, stop };
    }
    await sleep(intervalMs);
  }
  stop();
  throw new SafariLaunchTimeoutError(timeoutMs);
}
