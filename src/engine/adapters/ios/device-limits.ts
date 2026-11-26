// Per-session rate limits on a phone (RFC 0014 G10). In-memory counters held by
// the session, with limits the operator can lower or raise in the environment.
// They bound a runaway loop. They do not stop one wrong tap.
//
// A call over a limit refuses with `ios-device-rate-limit` and names the limit
// and the variable that sets it. A refused call is not counted.

import { IosDeviceError } from "./device-errors.js";

export type LimitKind = "install" | "launch" | "deepLink" | "input";

export interface DeviceLimits {
  /** Installs per session. */
  install: number;
  /** Launch and terminate calls per session, together. */
  launch: number;
  /** Deep links per session. */
  deepLink: number;
  /** Input actions per session. */
  input: number;
  /** Input actions in any one second. */
  inputsPerSecond: number;
}

export const DEFAULT_DEVICE_LIMITS: Readonly<DeviceLimits> = {
  install: 5,
  launch: 30,
  deepLink: 20,
  input: 3_000,
  inputsPerSecond: 5,
};

export const LIMIT_ENV: Readonly<Record<keyof DeviceLimits, string>> = {
  install: "BROWX_IOS_DEVICE_MAX_INSTALLS",
  launch: "BROWX_IOS_DEVICE_MAX_LAUNCHES",
  deepLink: "BROWX_IOS_DEVICE_MAX_DEEP_LINKS",
  input: "BROWX_IOS_DEVICE_MAX_INPUTS",
  inputsPerSecond: "BROWX_IOS_DEVICE_MAX_INPUTS_PER_SECOND",
};

const NOUN: Readonly<Record<keyof DeviceLimits, string>> = {
  install: "installs per session",
  launch: "launch or terminate calls per session",
  deepLink: "deep links per session",
  input: "input actions per session",
  inputsPerSecond: "input actions per second",
};

/** The limits, each from its variable or its default. A value that is not a
 *  whole number of zero or more refuses the session: a mistyped limit must not
 *  turn into no limit. Zero forbids the action. */
export function deviceLimitsFrom(env: NodeJS.ProcessEnv): DeviceLimits {
  const out = { ...DEFAULT_DEVICE_LIMITS };
  for (const key of Object.keys(LIMIT_ENV) as Array<keyof DeviceLimits>) {
    const raw = env[LIMIT_ENV[key]]?.trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) {
      throw new IosDeviceError(
        "ios-device-rate-limit-invalid",
        `${LIMIT_ENV[key]} is "${raw}". It takes a whole number of zero or more ` +
          `(default ${DEFAULT_DEVICE_LIMITS[key]}).`,
      );
    }
    out[key] = Number(raw);
  }
  return out;
}

const SECOND_MS = 1_000;

export class DeviceRateLimiter {
  private readonly used: Record<LimitKind, number> = {
    install: 0,
    launch: 0,
    deepLink: 0,
    input: 0,
  };
  private recentInputs: number[] = [];

  constructor(
    private readonly limits: DeviceLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one call of `kind`, or refuse it. */
  take(kind: LimitKind): void {
    if (this.used[kind] >= this.limits[kind]) throw this.refusal(kind);
    if (kind === "input") {
      const t = this.now();
      this.recentInputs = this.recentInputs.filter((at) => t - at < SECOND_MS);
      if (this.recentInputs.length >= this.limits.inputsPerSecond) {
        throw this.refusal("inputsPerSecond");
      }
      this.recentInputs.push(t);
    }
    this.used[kind] += 1;
  }

  private refusal(key: keyof DeviceLimits): IosDeviceError {
    return new IosDeviceError(
      "ios-device-rate-limit",
      `this session reached its limit of ${this.limits[key]} ${NOUN[key]} on the phone ` +
        `(${LIMIT_ENV[key]}). The operator sets the limit in the server's environment.`,
    );
  }
}
