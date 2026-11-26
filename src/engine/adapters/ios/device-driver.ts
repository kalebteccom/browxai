// The `NativeDriver` a phone session gets: `IosXcuiDriver` wrapped with the
// phone's guard rails (RFC 0014 §6) and its failure handling (§9).
//
//   - The foreground fence (G5). Before every input (tap, type, set-value,
//     swipe, pinch, button) and before every read of the screen (`snapshot`,
//     `screenshot`), the driver asks WebDriverAgent which app is in front. An
//     app off BROWX_IOS_DEVICE_APPS refuses with
//     `ios-device-foreground-not-allowed`, so the home screen, the lock screen,
//     a system alert (G6) and another app are never read or tapped. The fence
//     costs one round trip per call, and it has holes the threat model lists:
//     a banner drawn over the app, a system sheet inside the app's process, and
//     the gap between the check and the input.
//   - Buttons (G8): `home`, `volumeUp` and `volumeDown` only. Never lock.
//   - Input rate limits (G10), counted before the fence.
//
//   - WebDriverAgent's `invalid session id` becomes `ios-device-session-lost`.
//     The driver never opens a new session by itself: a new session relaunches
//     the app, and the evidence would not show it.
//   - A read (`snapshot`, `screenshot`) retries once after 1 s when the network
//     dropped. An input never retries, since the first one may have landed, and
//     the refusal says so.

import type { NativeAppInfo, NativeDriver, NativeNode, NativePoint } from "../../native-types.js";
import { IosDeviceError } from "./device-errors.js";
import { WdaCommandError, WdaUnreachableError } from "./wda-client.js";
import type { DeviceRateLimiter } from "./device-limits.js";

/** What the fence checks against. */
export interface DeviceFence {
  /** BROWX_IOS_DEVICE_APPS. */
  apps: readonly string[];
  limits: DeviceRateLimiter;
}

/** The buttons a phone session may press (G8). The lock button is not one. */
const PHONE_BUTTONS = new Set(["home", "volumeUp", "volumeDown"]);

const SPRINGBOARD = "com.apple.springboard";

function fenceRefusal(bundleId: string): IosDeviceError {
  const shown = bundleId || "unknown";
  const next =
    bundleId === SPRINGBOARD || bundleId === ""
      ? "The home screen, the lock screen or a system alert such as a permission prompt is in " +
        "front. A person taps the alert on the phone, or the operator grants the permission " +
        "before the run. Then bring the app under test back with `app_launch`."
      : "Bring an allowed app to the front with `app_launch`.";
  return new IosDeviceError(
    "ios-device-foreground-not-allowed",
    `the frontmost app is "${shown}", which is not on BROWX_IOS_DEVICE_APPS, so browxai neither ` +
      `reads the screen nor sends input. ${next}`,
  );
}

const READ_RETRY_MS = 1_000;

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionLost(err: unknown): unknown {
  if (err instanceof WdaCommandError && /invalid session id/i.test(err.code)) {
    return new IosDeviceError(
      "ios-device-session-lost",
      "WebDriverAgent no longer knows this session: the runner restarted or the session went " +
        "stale. browxai does not open a new one by itself, because that relaunches the app. " +
        "Close this session and open a new one.",
    );
  }
  return err;
}

export class IosDeviceDriver implements NativeDriver {
  readonly platform = "ios" as const;

  constructor(
    private readonly inner: NativeDriver,
    private readonly fence: DeviceFence,
    private readonly sleep: Sleep = realSleep,
  ) {}

  hierarchy(): Promise<NativeNode> {
    return this.read(() => this.inner.hierarchy());
  }

  screenshot(): Promise<Buffer> {
    return this.read(() => this.inner.screenshot());
  }

  findByIdentifier(identifier: string): Promise<string | null> {
    return this.call(async () => {
      await this.assertForeground();
      return this.inner.findByIdentifier(identifier);
    });
  }

  setValue(elementId: string, text: string): Promise<void> {
    return this.input(() => this.inner.setValue(elementId, text));
  }

  typeText(text: string): Promise<void> {
    return this.input(() => this.inner.typeText(text));
  }

  tap(at: NativePoint): Promise<void> {
    return this.input(() => this.inner.tap(at));
  }

  swipe(from: NativePoint, to: NativePoint, durationMs: number): Promise<void> {
    return this.input(() => this.inner.swipe(from, to, durationMs));
  }

  pinch(centre: NativePoint, scale: number, velocity: number): Promise<void> {
    return this.input(() => this.inner.pinch(centre, scale, velocity));
  }

  async pressButton(name: string): Promise<void> {
    if (!PHONE_BUTTONS.has(name)) {
      throw new IosDeviceError(
        "ios-device-button-refused",
        `the "${name}" button is not pressed on a phone. Only home, volumeUp and volumeDown are. ` +
          "browxai never locks or unlocks a phone.",
      );
    }
    return this.input(() => this.inner.pressButton(name));
  }

  openUrl(url: string): Promise<void> {
    return this.call(() => this.inner.openUrl(url));
  }

  foregroundApp(): Promise<NativeAppInfo> {
    return this.call(() => this.inner.foregroundApp());
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  protected async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw sessionLost(err);
    }
  }

  /** The frontmost app is on the app allowlist, or the fence refuses. */
  private async assertForeground(): Promise<void> {
    const front = await this.inner.foregroundApp();
    if (!this.fence.apps.includes(front.bundleId)) throw fenceRefusal(front.bundleId);
  }

  protected async read<T>(fn: () => Promise<T>): Promise<T> {
    const fenced = async (): Promise<T> => {
      await this.assertForeground();
      return fn();
    };
    try {
      return await this.call(fenced);
    } catch (err) {
      if (!(err instanceof WdaUnreachableError)) throw err;
      await this.sleep(READ_RETRY_MS);
      return this.call(fenced);
    }
  }

  protected async input(fn: () => Promise<void>): Promise<void> {
    this.fence.limits.take("input");
    // A dropped connection during the fence means nothing was sent, so only the
    // input itself is reported as possibly landed.
    await this.call(() => this.assertForeground());
    try {
      await this.call(fn);
    } catch (err) {
      if (!(err instanceof WdaUnreachableError)) throw err;
      throw new IosDeviceError(
        "ios-device-input-unconfirmed",
        "the connection to WebDriverAgent dropped during the input, which may have landed. " +
          `browxai does not retry an input. Read the screen before acting again. ${err.message}`,
      );
    }
  }
}
