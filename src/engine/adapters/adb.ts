// adb plumbing for the Android engine (RFC 0002 D3/D8) — discover the Chrome
// DevTools socket on a USB-connected device and forward it to a loopback port so
// `chromium.connectOverCDP` can attach to the user's REAL Chrome-on-Android.
//
// This module is split into PURE logic (command construction, `adb devices`
// parsing, the /json/version → webSocketDebuggerUrl extraction, free-port pick)
// and a thin IO seam (the `AdbRunner` that actually shells out to `adb`, the
// `Fetcher` that GETs the DevTools HTTP endpoint). The pure half is unit-tested
// WITHOUT a device; the IO half is exercised by the device-gated keystone.
//
// The Chrome-136 default-profile-attach block does NOT apply here. That block
// targets the DESKTOP `--remote-debugging-port` switch when combined with the
// default `--user-data-dir`. Android does not use that switch at all: the
// DevTools endpoint is exposed by the OS as an abstract-namespace unix socket
// (`localabstract:chrome_devtools_remote`), reachable only after the user
// enables USB debugging + on-device USB web-debugging. So the full-fidelity
// BYOB-to-the-real-profile win survives on Android (RFC D3/D8) — this is the one
// place real-profile attach still works post-Chrome-136. See
// developer.chrome.com/blog/remote-debugging-port (desktop-only) and
// developer.chrome.com/docs/devtools/remote-debugging (the Android adb path).

import { execFile } from "node:child_process";
import { createServer } from "node:net";

/** The abstract-namespace socket Chrome-on-Android publishes its DevTools
 *  endpoint on. WebView publishes per-process `webview_devtools_remote_<pid>`
 *  sockets; this adapter targets the browser socket (the user's real Chrome). */
export const CHROME_ANDROID_SOCKET = "localabstract:chrome_devtools_remote";

/** A connected adb device row. `state` is `device` for a ready, authorized
 *  device; `unauthorized` / `offline` are surfaced so the caller can tell the
 *  user to accept the on-device RSA prompt rather than fail opaquely. */
export interface AdbDevice {
  serial: string;
  state: string;
}

/** Runs an adb command and resolves its stdout. Injected so the pure command-
 *  construction + parsing logic is unit-testable without a device or a binary. */
export type AdbRunner = (args: readonly string[]) => Promise<string>;

/** GETs a URL and resolves the parsed JSON body. Injected for the same reason —
 *  the /json/version → wsUrl extraction is testable with a mock. */
export type Fetcher = (url: string) => Promise<unknown>;

/** adb is not installed / not on PATH. Structured (names the requirement), not a
 *  raw ENOENT crash. */
export class AdbNotInstalledError extends Error {
  constructor(detail?: string) {
    super(
      "adb-missing: the Android Debug Bridge (`adb`) was not found on PATH. The android " +
        "engine attaches to real Chrome-on-Android over adb + CDP (RFC 0002 D8). Install the " +
        "Android platform-tools (https://developer.android.com/tools/releases/platform-tools) " +
        "and ensure `adb` is on PATH" +
        (detail ? ` (${detail})` : "") +
        ". See docs/rfcs/0002-multi-engine-bidi.md.",
    );
    this.name = "AdbNotInstalledError";
  }
}

/** No usable Android device is connected (none listed, or all unauthorized /
 *  offline). Structured — names exactly what the user must do. */
export class NoAndroidDeviceError extends Error {
  readonly devices: readonly AdbDevice[];
  constructor(devices: readonly AdbDevice[]) {
    const seen = devices.length
      ? `adb sees ${devices.length} device entr${devices.length === 1 ? "y" : "ies"}: ` +
        devices.map((d) => `${d.serial} (${d.state})`).join(", ") +
        ". An `unauthorized` device needs you to accept the USB-debugging RSA prompt on the " +
        "phone; an `offline` device needs a re-plug."
      : "adb sees no connected devices.";
    super(
      "no-device: no ready Android device is connected. " +
        seen +
        " Connect a phone over USB, enable Developer Options → USB debugging, open Chrome, and " +
        "(for web debugging) enable Chrome → Settings → Developer tools / the on-device USB " +
        "web-debugging toggle. See docs/rfcs/0002-multi-engine-bidi.md (RFC D8).",
    );
    this.name = "NoAndroidDeviceError";
    this.devices = devices;
  }
}

/** The Chrome DevTools socket couldn't be reached on the forwarded port — Chrome
 *  isn't open on the device, or web-debugging isn't enabled. Structured. */
export class ChromeSocketUnreachableError extends Error {
  constructor(detail: string) {
    super(
      "chrome-socket-unreachable: forwarded the adb socket but the Chrome DevTools endpoint did " +
        `not answer (${detail}). Open Chrome on the device and enable USB web-debugging ` +
        "(chrome://inspect from the desktop should list the device's tabs). " +
        "See docs/rfcs/0002-multi-engine-bidi.md (RFC D8).",
    );
    this.name = "ChromeSocketUnreachableError";
  }
}

// ─── PURE: adb argv construction ──────────────────────────────────────────────
// `adb -s <serial>` scopes a command to one device; omitted when no serial (adb
// targets the single connected device, or errors if ambiguous — which we pre-empt
// by always resolving a serial first). These build argv arrays for `execFile`
// (no shell, no injection surface) — they are the unit-tested core.

/** `adb [-s serial] devices` argv. */
export function devicesArgs(): readonly string[] {
  return ["devices"];
}

/** `adb [-s serial] forward tcp:<localPort> localabstract:chrome_devtools_remote` argv. */
export function forwardArgs(
  localPort: number,
  serial?: string,
  socket: string = CHROME_ANDROID_SOCKET,
): readonly string[] {
  return [...serialFlag(serial), "forward", `tcp:${localPort}`, socket];
}

/** `adb [-s serial] forward --remove tcp:<localPort>` argv — the cleanup. */
export function forwardRemoveArgs(localPort: number, serial?: string): readonly string[] {
  return [...serialFlag(serial), "forward", "--remove", `tcp:${localPort}`];
}

function serialFlag(serial?: string): readonly string[] {
  return serial ? ["-s", serial] : [];
}

// ─── PURE: parsers + extractors ───────────────────────────────────────────────

/** Parse the multi-line `adb devices` output into rows. The first line is the
 *  "List of devices attached" header; each subsequent non-empty line is
 *  `<serial>\t<state>`. Blank lines + the header are skipped. */
export function parseDevices(stdout: string): AdbDevice[] {
  const rows: AdbDevice[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase().startsWith("list of devices")) continue;
    // serial and state are whitespace/tab separated; serial has no spaces.
    const parts = trimmed.split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state) continue;
    rows.push({ serial, state });
  }
  return rows;
}

/** Choose the device to attach to. Prefers the requested `serial` if given and
 *  ready; else the single ready (`state === "device"`) device. Throws
 *  `NoAndroidDeviceError` (naming the unauthorized/offline rows) when no ready
 *  device exists, or a structured ambiguity error when several are ready and no
 *  serial was specified. */
export function selectDevice(devices: readonly AdbDevice[], serial?: string): AdbDevice {
  const ready = devices.filter((d) => d.state === "device");
  if (serial) {
    const match = ready.find((d) => d.serial === serial);
    if (match) return match;
    throw new NoAndroidDeviceError(devices);
  }
  if (ready.length === 1) return ready[0]!;
  if (ready.length === 0) throw new NoAndroidDeviceError(devices);
  throw new Error(
    `ambiguous-device: ${ready.length} ready Android devices are connected ` +
      `(${ready.map((d) => d.serial).join(", ")}). Pass a serial via BROWX_ANDROID_SERIAL ` +
      "to pick one. See docs/rfcs/0002-multi-engine-bidi.md (RFC D8).",
  );
}

/** The DevTools HTTP base URL for a forwarded local port (loopback by
 *  construction — adb forwards to 127.0.0.1, reusing byob.ts's loopback policy). */
export function devToolsBaseUrl(localPort: number): string {
  return `http://127.0.0.1:${localPort}`;
}

/** The /json/version probe URL for a forwarded local port. */
export function versionUrl(localPort: number): string {
  return `${devToolsBaseUrl(localPort)}/json/version`;
}

/** Extract the `webSocketDebuggerUrl` from a parsed /json/version body. Throws
 *  `ChromeSocketUnreachableError` when the field is absent (Chrome closed, or an
 *  HTML error page came back instead of JSON). This is the field
 *  `chromium.connectOverCDP` attaches to — the same browser-level ws endpoint the
 *  desktop BYOB path uses. */
export function extractWsUrl(versionBody: unknown): string {
  const ws = (versionBody as { webSocketDebuggerUrl?: unknown } | null)?.webSocketDebuggerUrl;
  if (typeof ws !== "string" || !ws) {
    throw new ChromeSocketUnreachableError(
      "/json/version returned no webSocketDebuggerUrl (Chrome may be closed or web-debugging off)",
    );
  }
  return ws;
}

// ─── IO seam: the default runners ─────────────────────────────────────────────

/** The default adb runner — `execFile("adb", args)`. Maps ENOENT to the
 *  structured `AdbNotInstalledError`, and a non-zero exit (with adb present) to a
 *  message carrying adb's own stderr. No shell → no injection. */
export const defaultAdbRunner: AdbRunner = (args) =>
  new Promise<string>((resolve, reject) => {
    execFile("adb", [...args], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(new AdbNotInstalledError());
          return;
        }
        reject(new Error(`adb ${args.join(" ")} failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });

/** The default fetcher — a JSON GET with a short timeout. A non-OK status or a
 *  non-JSON body surfaces as `ChromeSocketUnreachableError` at the call site. */
export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) {
    throw new ChromeSocketUnreachableError(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
};

/** Pick a free local TCP port (loopback) for the adb forward. Lets the OS choose
 *  by binding to port 0, then releases it — there's an inherent TOCTOU window,
 *  but adb's `forward tcp:<port>` re-binds immediately after, and a clash surfaces
 *  as a loud adb error rather than a silent wrong-port attach. */
export function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free local port for adb forward")));
      }
    });
  });
}
