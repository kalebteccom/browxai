// The `NativeDriver` a phone session gets: `IosXcuiDriver` wrapped with the
// phone's failure handling (RFC 0014 §9).
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
    private readonly sleep: Sleep = realSleep,
  ) {}

  hierarchy(): Promise<NativeNode> {
    return this.read(() => this.inner.hierarchy());
  }

  screenshot(): Promise<Buffer> {
    return this.read(() => this.inner.screenshot());
  }

  findByIdentifier(identifier: string): Promise<string | null> {
    return this.call(() => this.inner.findByIdentifier(identifier));
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

  pressButton(name: string): Promise<void> {
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

  protected async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.call(fn);
    } catch (err) {
      if (!(err instanceof WdaUnreachableError)) throw err;
      await this.sleep(READ_RETRY_MS);
      return this.call(fn);
    }
  }

  protected async input(fn: () => Promise<void>): Promise<void> {
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
