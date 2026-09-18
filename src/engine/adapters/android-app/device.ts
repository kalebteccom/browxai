// The device transport for the `android-app` engine — one thin seam over `adb`,
// and the object every native substrate is built on.
//
// THE SEAM IS THE TEST STRATEGY. `AndroidDeviceIO` is two methods, injected at
// construction, exactly the way `AdbRunner`/`Fetcher` are injected into
// `AndroidCdpAdapter`. Every unit test in this engine drives the REAL
// `AndroidDevice` code against a faked IO, so the argv a test asserts on is the
// argv production sends. The device-gated keystones drive the same class against
// the default IO.
//
// NO SHELL, EVER. `execFile` takes an argv array; `adb-commands.ts` builds it.
// The device-side `sh` that `adb shell` feeds is handled by `shellQuote` there.
//
// Errors are NAMED, not raw. A failure that an operator can act on
// (`native-device-not-found`, `native-hierarchy-not-idle`, `native-app-not-installed`)
// says which one it is in a greppable prefix, so a handler renders a refusal that
// names the fix instead of surfacing adb's stderr.

import { execFile } from "node:child_process";
import {
  clearAppArgs,
  deepLinkArgs,
  dumpHierarchyArgs,
  forceStopArgs,
  foregroundArgs,
  getPropArgs,
  inputTextArgs,
  installArgs,
  installFailure,
  keyEventArgs,
  listPackagesArgs,
  motionEventArgs,
  parseForeground,
  parsePackages,
  parseResolvedActivity,
  parseScreenSize,
  resolveActivityArgs,
  screencapArgs,
  screenSizeArgs,
  startActivityArgs,
  stripDumpTrailer,
  swipeArgs,
  tapArgs,
  uninstallArgs,
  type ForegroundApp,
} from "./adb-commands.js";

/** The injected IO seam. `text` is every command whose output is a string;
 *  `binary` is the two (`screencap`, the hierarchy dump) whose output must not be
 *  decoded as UTF-8 before the caller decides. Both take an argv array — there is
 *  no string-command entry point, by construction. */
export interface AndroidDeviceIO {
  text(args: readonly string[], timeoutMs?: number): Promise<string>;
  binary(args: readonly string[], timeoutMs?: number): Promise<Buffer>;
}

/** A named device failure. `code` is the greppable reason a handler renders; the
 *  message carries the operator-facing fix. */
export class NativeDeviceError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "NativeDeviceError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** `uiautomator dump` blocks until the window goes idle and gives up at ~10s, so
 *  its own budget must exceed that or the transport times out first and reports
 *  the wrong cause. */
const DUMP_TIMEOUT_MS = 30_000;
/** `adb install` pushes an APK and runs the package manager over it. */
const INSTALL_TIMEOUT_MS = 180_000;
/** `input motionevent` — the raw touch pipeline — arrived in API 30. */
const MIN_SDK_FOR_MOTION_EVENT = 30;

/** The default IO: `execFile("adb", argv)`. No shell on the host side; the argv
 *  array is passed through verbatim. `maxBuffer` is raised because a screenshot
 *  of a 1080x2220 display is ~1.4MB and a deep hierarchy dump can pass 1MB, both
 *  of which exceed Node's 1MB default and would surface as a truncated-output
 *  parse error rather than as the size problem it is. */
export function defaultDeviceIO(adbPath = "adb"): AndroidDeviceIO {
  const run = (args: readonly string[], timeoutMs: number, encoding: "utf8" | "buffer") =>
    new Promise<string | Buffer>((resolve, reject) => {
      execFile(
        adbPath,
        [...args],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding },
        (err, stdout, stderr) => {
          if (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              reject(
                new NativeDeviceError(
                  "adb-missing",
                  "the Android Debug Bridge (`adb`) was not found on PATH. The android-app engine " +
                    "drives an emulator over adb. Install the Android platform-tools and put `adb` " +
                    "on PATH (https://developer.android.com/tools/releases/platform-tools).",
                ),
              );
              return;
            }
            const detail = String(stderr || err.message).trim();
            reject(
              new NativeDeviceError("adb-failed", `\`adb ${args.join(" ")}\` failed: ${detail}`),
            );
            return;
          }
          resolve(stdout as string | Buffer);
        },
      );
    });
  return {
    text: async (args, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      String(await run(args, timeoutMs, "utf8")),
    binary: async (args, timeoutMs = DEFAULT_TIMEOUT_MS) =>
      Buffer.from((await run(args, timeoutMs, "buffer")) as Buffer),
  };
}

/** One Android device or emulator, addressed by serial. Every method is `async`
 *  — the `substrate-adapter-async` rule applies here for the same reason: these
 *  are the injected accessors the substrates call, and a synchronous throw from
 *  one would escape the substrate's own error handling. */
export class AndroidDevice {
  constructor(
    readonly serial: string,
    private readonly io: AndroidDeviceIO,
  ) {}

  // ─── Reading the screen ─────────────────────────────────────────────────────

  /** The UiAutomator view hierarchy as XML.
   *
   *  `uiautomator dump` waits for the window to go idle and fails outright if it
   *  never does — an app with a running animation or an indeterminate spinner
   *  produces `ERROR: could not get idle state.` and no XML. That is a REAL and
   *  common failure (a React Native splash screen with a spinner reproduces it),
   *  so it gets its own named error telling the agent to wait, rather than being
   *  handed to a parser that would report malformed XML. */
  async dumpHierarchy(): Promise<string> {
    const raw = (await this.io.binary(dumpHierarchyArgs(this.serial), DUMP_TIMEOUT_MS)).toString(
      "utf8",
    );
    const xml = stripDumpTrailer(raw);
    if (xml) return xml;
    if (/could not get idle state/i.test(raw)) {
      throw new NativeDeviceError(
        "native-hierarchy-not-idle",
        "UiAutomator could not dump the view hierarchy because the window never went idle. " +
          "A running animation, an indeterminate progress spinner or a video keeps the window " +
          "busy indefinitely. Wait for the screen to settle and retry, or drive the app to a " +
          "static screen first. This is a UiAutomator limitation, not a browxai timeout.",
      );
    }
    throw new NativeDeviceError(
      "native-hierarchy-unavailable",
      `UiAutomator returned no hierarchy XML (got ${JSON.stringify(raw.slice(0, 200))}). ` +
        "Another UiAutomator client (a second driver, an Espresso run, a manual `uiautomator " +
        "dump`, or an accessibility service) may hold the connection — only one owner per device.",
    );
  }

  /** A PNG of the whole screen. */
  async screenshot(): Promise<Buffer> {
    const png = await this.io.binary(screencapArgs(this.serial));
    // `screencap -p` emits a PNG; anything else means the transport mangled it
    // (the classic `shell` vs `exec-out` CRLF corruption) and a caller would get
    // an unreadable image with no explanation.
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
      throw new NativeDeviceError(
        "native-screenshot-failed",
        `screencap returned ${png.length} bytes that are not a PNG.`,
      );
    }
    return png;
  }

  /** The package + activity that currently has window focus. */
  async foreground(): Promise<ForegroundApp | null> {
    return parseForeground(await this.io.text(foregroundArgs(this.serial)));
  }

  /** The display size UiAutomator bounds are expressed in. */
  async screenSize(): Promise<{ width: number; height: number }> {
    const size = parseScreenSize(await this.io.text(screenSizeArgs(this.serial)));
    if (!size)
      throw new NativeDeviceError("native-screen-size-unknown", "`wm size` returned no size");
    return size;
  }

  /** One system property, trimmed. */
  async prop(name: string): Promise<string> {
    return (await this.io.text(getPropArgs(name, this.serial))).trim();
  }

  /** The device's API level, for the capability checks that key on it. */
  async sdkLevel(): Promise<number> {
    const raw = await this.prop("ro.build.version.sdk");
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  // ─── Input primitives ───────────────────────────────────────────────────────

  /** A real tap through the OS input pipeline. */
  async tap(x: number, y: number): Promise<void> {
    await this.io.text(tapArgs(x, y, this.serial));
  }

  /** A real single-finger drag. `input swipe` IS the platform primitive — this
   *  is not three touch events glued together. */
  async swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void> {
    await this.io.text(swipeArgs(from, to, durationMs, this.serial));
  }

  /** One raw touch phase. Refuses below API 30 by NAME rather than running a
   *  command the shell reports as unknown-argument noise. */
  async motionEvent(phase: "DOWN" | "MOVE" | "UP", x: number, y: number): Promise<void> {
    const sdk = await this.sdkLevel();
    if (sdk < MIN_SDK_FOR_MOTION_EVENT) {
      throw new NativeDeviceError(
        "native-touch-unsupported",
        `\`input motionevent\` needs API ${MIN_SDK_FOR_MOTION_EVENT} or later; this device reports ` +
          `API ${sdk}. Use \`gesture_swipe\`, which is available on every API level.`,
      );
    }
    await this.io.text(motionEventArgs(phase, x, y, this.serial));
  }

  /** Type text into whatever has focus. Newlines have no `input text` encoding,
   *  so they are dispatched as ENTER keyevents — dropping them silently would
   *  make a multi-line fill land wrong with no signal. */
  async typeText(value: string): Promise<void> {
    const lines = value.split("\n");
    for (const [i, line] of lines.entries()) {
      if (i > 0) await this.keyEvent("KEYCODE_ENTER");
      if (line.length > 0) await this.io.text(inputTextArgs(line, this.serial));
    }
  }

  /** Press a hardware or software key by its `KEYCODE_*` name. */
  async keyEvent(keycode: string): Promise<void> {
    await this.io.text(keyEventArgs(keycode, this.serial));
  }

  // ─── App lifecycle ──────────────────────────────────────────────────────────

  /** Installed packages. */
  async packages(thirdPartyOnly = true): Promise<string[]> {
    return parsePackages(await this.io.text(listPackagesArgs(thirdPartyOnly, this.serial)));
  }

  /** Install an APK from a host path. `adb install` reports some failures on
   *  stdout with a zero exit code, so the output is checked too. */
  async install(apkPath: string, reinstall: boolean): Promise<void> {
    const out = await this.io.text(
      installArgs(apkPath, reinstall, this.serial),
      INSTALL_TIMEOUT_MS,
    );
    const failure = installFailure(out);
    if (failure) throw new NativeDeviceError("native-install-failed", `${apkPath}: ${failure}`);
  }

  async uninstall(packageName: string): Promise<void> {
    const out = await this.io.text(uninstallArgs(packageName, this.serial));
    const failure = installFailure(out);
    if (failure)
      throw new NativeDeviceError("native-uninstall-failed", `${packageName}: ${failure}`);
  }

  /** Launch an app at its declared launcher activity. Resolving the activity
   *  first means a missing package is reported as a missing package, where
   *  `monkey -p <pkg>` would report success having done nothing. */
  async launchApp(packageName: string): Promise<string> {
    const resolved = parseResolvedActivity(
      await this.io.text(resolveActivityArgs(packageName, this.serial)),
    );
    if (!resolved) {
      throw new NativeDeviceError(
        "native-app-not-installed",
        `no launchable activity for "${packageName}". Install it first (\`app_install\`), or check ` +
          "the id with `app_list`.",
      );
    }
    await this.io.text(startActivityArgs(resolved, this.serial));
    return resolved;
  }

  async terminateApp(packageName: string): Promise<void> {
    await this.io.text(forceStopArgs(packageName, this.serial));
  }

  /** Clear app data and granted runtime permissions. */
  async clearApp(packageName: string): Promise<void> {
    const out = await this.io.text(clearAppArgs(packageName, this.serial));
    if (!/Success/i.test(out)) {
      throw new NativeDeviceError("native-app-clear-failed", `${packageName}: ${out.trim()}`);
    }
  }

  /** Open a deep link. `navigate` maps onto this — a native screen has no
   *  address bar, so a URL only means anything as an intent. */
  async openDeepLink(url: string): Promise<void> {
    const out = await this.io.text(deepLinkArgs(url, this.serial));
    if (/Error:/i.test(out)) {
      throw new NativeDeviceError("native-deep-link-failed", `${url}: ${out.trim()}`);
    }
  }
}
