// PURE adb argv construction + output parsing for the `android-app` engine.
//
// Every device operation this engine performs is an `adb` invocation, and every
// one of them is built here as an ARGV ARRAY — never a shell string. `execFile`
// takes the array verbatim, so nothing on the host side is interpreted. The
// device side is the half that needs care and it is handled by `shellQuote`
// below: `adb shell <words…>` joins its words with spaces and hands the result to
// the device's `sh`, so a value carrying `;` or `$(…)` WOULD be interpreted there.
// `shellQuote` is the one chokepoint for that, and `fill`/`press` are its only
// callers with agent-supplied text.
//
// Split pure from IO for the reason `adb.ts` already states: the argv and the
// parsers are unit-tested without a device or a binary, and `device.ts` holds the
// thin seam that actually spawns adb. Every parser here takes a string and
// returns data — no IO, no clock, no environment.

/** A rectangle in device pixels, as UiAutomator reports node bounds. */
export interface DeviceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What is on screen right now: the package and the activity that owns focus. */
export interface ForegroundApp {
  packageName: string;
  activity: string;
}

/** An emulator/device row, richer than `adb.ts`'s `AdbDevice` because the device
 *  tools report a model and an API level alongside the serial. */
export interface AndroidDeviceInfo {
  serial: string;
  state: string;
  /** `ro.product.model`, absent when the device is not ready to be queried. */
  model?: string;
  /** `ro.build.version.release`, e.g. "14". */
  release?: string;
  /** `ro.build.version.sdk` as a number, e.g. 34. */
  sdk?: number;
  /** True when the serial has the `emulator-<port>` shape. */
  emulator: boolean;
}

// ─── The device-shell quoting chokepoint ──────────────────────────────────────

/** Single-quote a value for the DEVICE's `sh`.
 *
 *  `adb shell input text foo` is not `execFile`-safe by itself: adb joins the
 *  argv after `shell` into one command line and the device's `sh` parses it. So
 *  `input text "a; reboot"` reboots the device. Wrapping in single quotes makes
 *  `sh` treat the whole thing as one literal word, and the only character that
 *  can escape single quotes is a single quote, which is spliced as `'\''`.
 *
 *  This is the ONLY way agent-supplied text reaches a device command in this
 *  engine, and `adbShellTextArgs` / `adbKeyEventArgs` are its only callers. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** `adb shell input text` additionally needs spaces as `%s` — the `input`
 *  command's own escaping, applied INSIDE the shell quoting. Newlines have no
 *  `input text` encoding at all, so they become an explicit ENTER keyevent at the
 *  call site rather than being silently dropped here. */
export function encodeInputText(value: string): string {
  return value.replaceAll(" ", "%s");
}

// ─── PURE: argv construction ──────────────────────────────────────────────────

function serialFlag(serial?: string): readonly string[] {
  return serial ? ["-s", serial] : [];
}

/** `adb -s <serial> exec-out uiautomator dump /dev/tty` — the view-hierarchy
 *  dump. `exec-out` (not `shell`) because it is a raw binary-safe stream with no
 *  CRLF translation, and `/dev/tty` streams the XML back instead of writing a
 *  file on the device that a second command then has to `cat` and delete. */
export function dumpHierarchyArgs(serial?: string): readonly string[] {
  return [...serialFlag(serial), "exec-out", "uiautomator", "dump", "/dev/tty"];
}

/** `adb -s <serial> exec-out screencap -p` — a PNG of the whole screen on
 *  stdout. `exec-out` is REQUIRED here: `shell screencap` corrupts the PNG by
 *  translating LF to CRLF on some transports. */
export function screencapArgs(serial?: string): readonly string[] {
  return [...serialFlag(serial), "exec-out", "screencap", "-p"];
}

/** `adb -s <serial> shell input tap <x> <y>` — a real single-pointer tap through
 *  the OS input pipeline, not a synthesised event. */
export function tapArgs(x: number, y: number, serial?: string): readonly string[] {
  return [
    ...serialFlag(serial),
    "shell",
    "input",
    "tap",
    String(Math.round(x)),
    String(Math.round(y)),
  ];
}

/** `adb -s <serial> shell input swipe <x1> <y1> <x2> <y2> <ms>` — a real
 *  single-finger drag primitive. Duration is what separates a swipe (fast) from a
 *  drag (slow) to the platform's gesture detectors, so it is always sent. */
export function swipeArgs(
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
  serial?: string,
): readonly string[] {
  return [
    ...serialFlag(serial),
    "shell",
    "input",
    "swipe",
    String(Math.round(from.x)),
    String(Math.round(from.y)),
    String(Math.round(to.x)),
    String(Math.round(to.y)),
    String(Math.round(durationMs)),
  ];
}

/** `adb -s <serial> shell input motionevent DOWN|MOVE|UP <x> <y>` — the raw
 *  touch pipeline, one pointer per call, which is exactly the shape of browxai's
 *  `touch_start` / `touch_move` / `touch_end`. Added in API 30; `device.ts`
 *  refuses below that rather than silently doing nothing. */
export function motionEventArgs(
  phase: "DOWN" | "MOVE" | "UP",
  x: number,
  y: number,
  serial?: string,
): readonly string[] {
  return [
    ...serialFlag(serial),
    "shell",
    "input",
    "motionevent",
    phase,
    String(Math.round(x)),
    String(Math.round(y)),
  ];
}

/** `adb -s <serial> shell input text '<quoted>'` — quoted for the device shell
 *  and `%s`-encoded for `input` itself. */
export function inputTextArgs(value: string, serial?: string): readonly string[] {
  return [...serialFlag(serial), "shell", "input", "text", shellQuote(encodeInputText(value))];
}

/** `adb -s <serial> shell input keyevent '<KEYCODE>'` — quoted because the key
 *  name reaches the device shell like any other word. */
export function keyEventArgs(keycode: string, serial?: string): readonly string[] {
  return [...serialFlag(serial), "shell", "input", "keyevent", shellQuote(keycode)];
}

/** `adb -s <serial> shell dumpsys window` — the foreground-window query. */
export function foregroundArgs(serial?: string): readonly string[] {
  return [...serialFlag(serial), "shell", "dumpsys", "window"];
}

/** `adb -s <serial> shell wm size` — the display size, physical and override. */
export function screenSizeArgs(serial?: string): readonly string[] {
  return [...serialFlag(serial), "shell", "wm", "size"];
}

/** `adb -s <serial> shell getprop <name>` — one system property. */
export function getPropArgs(name: string, serial?: string): readonly string[] {
  return [...serialFlag(serial), "shell", "getprop", shellQuote(name)];
}

/** `adb -s <serial> install [-r] <apkPath>` — the APK path is a HOST path handed
 *  to `execFile` as its own argv entry, so it is never shell-interpreted. */
export function installArgs(
  apkPath: string,
  reinstall: boolean,
  serial?: string,
): readonly string[] {
  return [...serialFlag(serial), "install", ...(reinstall ? ["-r"] : []), apkPath];
}

/** `adb -s <serial> uninstall <package>`. */
export function uninstallArgs(packageName: string, serial?: string): readonly string[] {
  return [...serialFlag(serial), "uninstall", packageName];
}

/** `adb -s <serial> shell pm list packages [-3]` — `-3` restricts to
 *  third-party packages, which is what an agent picking an app under test wants;
 *  the full list is ~200 system packages of noise. */
export function listPackagesArgs(thirdPartyOnly: boolean, serial?: string): readonly string[] {
  return [
    ...serialFlag(serial),
    "shell",
    "pm",
    "list",
    "packages",
    ...(thirdPartyOnly ? ["-3"] : []),
  ];
}

/** `adb -s <serial> shell cmd package resolve-activity --brief <package>` — the
 *  launcher activity, so launching is a precise `am start -n` rather than a
 *  `monkey` invocation that reports success whatever happened. */
export function resolveActivityArgs(packageName: string, serial?: string): readonly string[] {
  return [
    ...serialFlag(serial),
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    shellQuote(packageName),
  ];
}

/** `adb -s <serial> shell am start -n <package>/<activity>`. */
export function startActivityArgs(component: string, serial?: string): readonly string[] {
  return [...serialFlag(serial), "shell", "am", "start", "-n", shellQuote(component)];
}

/** `adb -s <serial> shell am force-stop <package>` — the app-close primitive.
 *  Force-stop rather than `am kill`: kill only targets background processes and
 *  silently no-ops on the foreground app, which would make `app_close` report
 *  success for a close that did not happen. */
export function forceStopArgs(packageName: string, serial?: string): readonly string[] {
  return [...serialFlag(serial), "shell", "am", "force-stop", shellQuote(packageName)];
}

/** `adb -s <serial> shell pm clear <package>` — clears app data AND granted
 *  runtime permissions, which is what "start from a known state" means. */
export function clearAppArgs(packageName: string, serial?: string): readonly string[] {
  return [...serialFlag(serial), "shell", "pm", "clear", shellQuote(packageName)];
}

/** `adb -s <serial> shell am start -a android.intent.action.VIEW -d <url>` — the
 *  deep-link open that `navigate` maps onto. */
export function deepLinkArgs(url: string, serial?: string): readonly string[] {
  return [
    ...serialFlag(serial),
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    shellQuote(url),
  ];
}

/** `adb -s <serial> emu kill` — the emulator console's shutdown command. Only
 *  meaningful on an `emulator-<port>` serial. */
export function emulatorKillArgs(serial: string): readonly string[] {
  return ["-s", serial, "emu", "kill"];
}

// ─── PURE: output parsers ─────────────────────────────────────────────────────

/** `uiautomator dump /dev/tty` writes the XML and then appends its own status
 *  line — `UI hierchary dumped to: /dev/tty`, Android's typo included. Anything
 *  after the closing tag is that trailer and is cut; anything BEFORE the opening
 *  tag means the dump failed and the caller gets `null` so it can raise a named
 *  error rather than hand a parser an error message. */
export function stripDumpTrailer(raw: string): string | null {
  const open = raw.indexOf("<hierarchy");
  const close = raw.lastIndexOf("</hierarchy>");
  if (open === -1 || close === -1 || close < open) return null;
  return raw.slice(open, close + "</hierarchy>".length);
}

/** The foreground package + activity from `dumpsys window`.
 *
 *  `mCurrentFocus=Window{<hash> u0 <package>/<activity>}` is the line that says
 *  what the USER is looking at. `mFocusedApp` is read as the fallback because
 *  `mCurrentFocus` is momentarily `null` during a transition, and reporting "no
 *  app is foreground" mid-animation would be wrong rather than merely late. */
export function parseForeground(dumpsysWindow: string): ForegroundApp | null {
  return (
    focusFrom(dumpsysWindow, /mCurrentFocus=Window\{[^}]*\s+(\S+)\/(\S+?)\}/) ??
    focusFrom(dumpsysWindow, /mFocusedApp=\S*ActivityRecord\{[^}]*\s+(\S+)\/(\S+?)[\s}]/)
  );
}

function focusFrom(text: string, pattern: RegExp): ForegroundApp | null {
  const m = pattern.exec(text);
  if (!m?.[1] || !m[2]) return null;
  // `am` reports a component-relative activity as `.MainActivity`; expand it so
  // the value is always addressable as a full component name.
  const activity = m[2].startsWith(".") ? `${m[1]}${m[2]}` : m[2];
  return { packageName: m[1], activity };
}

/** Package names from `pm list packages`, which prefixes every line with
 *  `package:`. */
export function parsePackages(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("package:")) continue;
    // `pm list packages -f` appends `=<package>` after the apk path; the plain
    // form has no `=`. Taking the last `=`-segment covers both.
    const name = trimmed.slice("package:".length).split("=").pop()!.trim();
    if (name) out.push(name);
  }
  return out.sort();
}

/** The display size from `wm size`. An `Override size` line wins when present:
 *  it is the size the window manager is actually laying out to, which is what
 *  UiAutomator bounds are expressed in. */
export function parseScreenSize(wmSize: string): { width: number; height: number } | null {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(wmSize);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(wmSize);
  const m = override ?? physical;
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** The `<package>/<activity>` component from `cmd package resolve-activity
 *  --brief`, which prints a `priority=…` preamble line first. */
export function parseResolvedActivity(stdout: string): string | null {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (/^[\w.]+\/[\w.$]+$/.test(trimmed)) return trimmed;
  }
  return null;
}

/** AVD names from `emulator -list-avds` — one bare name per line. Lines carrying
 *  anything else (the tool prints warnings to stdout on some SDK versions) are
 *  skipped, so a warning never becomes a bootable AVD name. */
export function parseAvds(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /^[\w.-]+$/.test(l));
}

/** True when a serial has the emulator shape. Drives which shutdown path
 *  `device_shutdown` takes: `emu kill` for an emulator, a refusal for a physical
 *  device (browxai does not power off someone's phone). */
export function isEmulatorSerial(serial: string): boolean {
  return /^emulator-\d+$/.test(serial);
}

/** `adb install` reports failure on STDOUT with exit code 0 on several
 *  platform-tools versions, so the exit code alone is not the oracle. */
export function installFailure(stdout: string): string | null {
  const m = /\b(Failure|Error)\b\s*\[?([^\]\n]*)\]?/.exec(stdout);
  return m ? `${m[1]}${m[2] ? ` [${m[2].trim()}]` : ""}` : null;
}
