// `browxai doctor` — the per-engine availability probes.
//
// One probe per browser engine doctor reports on: chromium (the managed-mode
// dependency — a missing Google Chrome FAILS doctor when no channel is set, and
// a missing bundled binary FAILS it when channel "chromium" is set) and the five opt-in lanes — firefox, webkit, android,
// safari, electron — whose probes are always INFORMATIONAL (a missing binary /
// no device / an unset attach endpoint just tells the operator how to enable
// the engine; it never fails doctor). Each returns a doctor `Check` row;
// doctor.ts owns the checklist orchestration + the engine-SELECTION diagnostic (which engine the server would
// run on) and calls these for the readiness rows the selection line points at.
//
// These probes never reach past the engine port: the android adb-chain probe
// drives the adb/CDP helpers re-exported from src/engine/index.ts, so the gate
// stays routed through its existing seam.

import { existsSync } from "node:fs";
import type { Check } from "./doctor.js";
import { findInstalledChrome } from "./chrome-launch.js";
import { BUNDLED_CHANNEL, isBundledChannel } from "../session/chromium-launch-posture.js";
import { ConfigStore } from "../util/config-store.js";
import { resolveWorkspace } from "../util/workspace.js";
import { playwrightInstallCommand } from "../util/playwright-version.js";
import {
  AndroidCdpAdapter,
  SAFARIDRIVER_PATH,
  assertSafariAvailable,
  defaultAdbRunner,
  defaultFetcher,
  pickFreePort,
  forwardArgs,
  forwardRemoveArgs,
  versionUrl,
  extractWsUrl,
} from "../engine/index.js";
import { docsUrl } from "../util/docs-links.js";
import { sanitizeUrl, sanitizeUrlsInText } from "../util/url-sanitizer.js";

/** The chromium channel a session with no per-session `channel` launches on:
 *  config `channel` over `BROWX_CHANNEL`, read the way the server reads it.
 *  Undefined when unset, or when the config cannot be read (another row reports
 *  that). */
export function configuredChannel(
  env: NodeJS.ProcessEnv = process.env,
  workspaceRoot?: string,
): string | undefined {
  try {
    const store = new ConfigStore(workspaceRoot ?? resolveWorkspace(env).root, {
      ...env,
      BROWX_TOOL_LIST: "",
      BROWX_TOOL_PROFILE: "",
      BROWX_CHROMIUM_SANDBOX: "",
    });
    return store.resolve().channel?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const OPT_IN_HINT = `set BROWX_CHANNEL=${BUNDLED_CHANNEL} to launch the bundled Chromium`;

// The installed Google Chrome, and what a chromium session with no per-session
// `channel` launches on this machine. With no channel configured and no Chrome,
// that launch is refused with `chrome-not-installed`, so the row fails.
export function chromeCheck(
  find: () => string | undefined = findInstalledChrome,
  channel: string | undefined = undefined,
): Check {
  const path = find();
  const where = path ?? "Google Chrome not found";
  if (isBundledChannel(channel)) {
    return {
      name: "chrome",
      ok: true,
      ...(path ? {} : { info: true, enable: "install Google Chrome (google.com/chrome)" }),
      detail: `${where}. Channel "${BUNDLED_CHANNEL}" is set, so sessions launch the bundled Chromium`,
    };
  }
  if (channel) {
    return {
      name: "chrome",
      ok: true,
      info: true,
      detail: `${where}. Channel "${channel}" is set, so sessions launch that installed browser`,
    };
  }
  if (path) {
    return { name: "chrome", ok: true, detail: `${path}. A default session launches it` };
  }
  return {
    name: "chrome",
    ok: false,
    detail:
      "Google Chrome not found, so a default session is refused with chrome-not-installed. `browxai chrome start` / `chrome login` need Chrome too",
    fix: `install Google Chrome (google.com/chrome), or ${OPT_IN_HINT}. See ${docsUrl.troubleshootingChromeNotInstalled}`,
  };
}

// Bundled Chromium (playwright-core's download). Sessions launch it only on
// channel "chromium", so it is a hard requirement only when `required` is true.
// Lazy import so doctor doesn't pay the playwright-core cost on bare invocation.
export async function chromiumCheck(required = false): Promise<Check> {
  const install = playwrightInstallCommand("chromium");
  const optional = {
    ok: true,
    info: true,
    enable: `\`${install}\`, then ${OPT_IN_HINT}`,
  } as const;
  try {
    const { chromium } = await import("playwright-core");
    const path = chromium.executablePath();
    if (path && existsSync(path)) {
      return { name: "chromium", ok: true, ...(required ? {} : { info: true }), detail: path };
    }
    if (!required) {
      return {
        name: "chromium",
        ...optional,
        detail: `bundled build not downloaded. Only channel "${BUNDLED_CHANNEL}" uses it`,
      };
    }
    return {
      name: "chromium",
      ok: false,
      detail: `channel "${BUNDLED_CHANNEL}" is set, and the bundled Chromium is not downloaded`,
      fix: `run \`${install}\`, or unset the channel to launch the installed Google Chrome`,
    };
  } catch (e) {
    return {
      name: "chromium",
      ...(required ? { ok: false } : optional),
      detail: e instanceof Error ? e.message : String(e),
      fix: `reinstall browxai (playwright-core failed to load), then run \`${install}\``,
    };
  }
}

// Firefox binary (opt-in second engine — `browserType:"firefox"`).
// Informational: Firefox is opt-in, so a missing binary never FAILS doctor —
// it just tells the operator how to enable the engine. Mirrors the Chromium
// check above but against the Firefox build (Playwright's bundled Juggler).
export async function firefoxCheck(): Promise<Check> {
  try {
    const { firefox } = await import("playwright-core");
    const path = firefox.executablePath();
    if (path && existsSync(path)) {
      return { name: "firefox", ok: true, info: true, detail: `${path}` };
    }
    return {
      name: "firefox",
      ok: true,
      info: true,
      detail: 'not installed (opt-in second engine, browserType:"firefox")',
      enable: `\`${playwrightInstallCommand("firefox")}\``,
    };
  } catch (e) {
    return {
      name: "firefox",
      ok: true,
      info: true,
      detail: e instanceof Error ? e.message : String(e),
      enable: `\`${playwrightInstallCommand("firefox")}\``,
    };
  }
}

// WebKit binary (opt-in third engine — `browserType:"webkit"`).
// Informational: WebKit is opt-in, so a missing binary never FAILS doctor —
// it just tells the operator how to enable the engine. Mirrors the Chromium +
// Firefox checks above but against the WebKit build (Playwright's bundled
// WebKit — the WebKit-engine correctness lane, NOT Safari).
export async function webkitCheck(): Promise<Check> {
  try {
    const { webkit } = await import("playwright-core");
    const path = webkit.executablePath();
    if (path && existsSync(path)) {
      return { name: "webkit", ok: true, info: true, detail: `${path}` };
    }
    return {
      name: "webkit",
      ok: true,
      info: true,
      detail: 'not installed (opt-in third engine, browserType:"webkit")',
      enable: `\`${playwrightInstallCommand("webkit")}\``,
    };
  } catch (e) {
    return {
      name: "webkit",
      ok: true,
      info: true,
      detail: e instanceof Error ? e.message : String(e),
      enable: `\`${playwrightInstallCommand("webkit")}\``,
    };
  }
}

// Android availability — how far the adb + CDP chain reaches, without opening a
// session. adb present? → a device ready? → the Chrome DevTools socket
// reachable? Always informational (Android is opt-in + device-gated). The probe
// forwards the socket to a transient loopback port, GETs /json/version, then
// removes the forward — no session, no leaked forward.
export async function androidCheck(): Promise<Check> {
  const name = "android";
  const adapter = new AndroidCdpAdapter();
  let serial: string;
  try {
    serial = await adapter.discoverDevice(process.env.BROWX_ANDROID_SERIAL?.trim() || undefined);
  } catch (e) {
    // adb-missing / no-device / ambiguous — report the structured message's first
    // clause; never fails doctor.
    const msg = e instanceof Error ? e.message.split(".")[0] : String(e);
    return {
      name,
      ok: true,
      info: true,
      detail: `${msg} (opt-in BYOB lane, browserType:"android")`,
      enable: "connect an Android phone over USB, turn on USB debugging, open Chrome",
    };
  }
  // Device ready — try to reach the Chrome socket so the operator knows whether
  // Chrome is open + web-debugging is on.
  let localPort = 0;
  try {
    localPort = await pickFreePort();
    await defaultAdbRunner(forwardArgs(localPort, serial));
    const body = await defaultFetcher(versionUrl(localPort));
    extractWsUrl(body);
    const browser = (body as { Browser?: string }).Browser ?? "unknown";
    return {
      name,
      ok: true,
      info: true,
      detail: `device ${serial} ready, Chrome reachable (${browser}), so browserType:"android" is attach-ready`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split(".")[0] : String(e);
    return {
      name,
      ok: true,
      info: true,
      detail: `device ${serial} ready but Chrome socket not reachable: ${msg}`,
      enable: "open Chrome on the device with USB debugging on (chrome://inspect lists its tabs)",
    };
  } finally {
    if (localPort) {
      await defaultAdbRunner(forwardRemoveArgs(localPort, serial)).catch(() => undefined);
    }
  }
}

// Safari availability (opt-in engine, `browserType:"safari"`): real Safari.app
// over safaridriver, so it needs macOS and the driver binary. Always
// informational. Doctor does not open a session, so whether "Allow Remote
// Automation" is on is only known when a session starts; the hint names it.
export function safariCheck(assertAvailable: () => void = assertSafariAvailable): Check {
  const enable =
    "on macOS, run `safaridriver --enable` once (needs admin rights) and turn on Safari > Develop > Allow Remote Automation";
  try {
    assertAvailable();
    return {
      name: "safari",
      ok: true,
      info: true,
      detail: `safaridriver found at ${SAFARIDRIVER_PATH} (Remote Automation is checked when a session opens)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split(". ")[0] : String(e);
    return {
      name: "safari",
      ok: true,
      info: true,
      detail: `${msg} (opt-in engine, browserType:"safari")`,
      enable,
    };
  }
}

/** `Electron/39.8.8` in a DevTools user-agent string. Same token
 *  `adapters/electron-detect.ts` matches at attach; doctor reads the HTTP
 *  `/json/version` endpoint instead of opening a CDP session, so the probe costs
 *  the attached app one GET and holds nothing. */
const ELECTRON_UA = /\bElectron\/([0-9][\w.]*)/;

/** What is on the far end of `BROWX_ATTACH_CDP`, answered before a session is
 *  opened. Always informational: the desktop attach lane is opt-in, and an unset
 *  endpoint or an unreachable one is a configuration state, never a fault.
 *
 *  Doctor is the right place for this because the electron lane's whole risk is
 *  that the operator is not sure what they pointed at. Reporting the app name and
 *  Electron version from the protocol answers that without driving anything. */
export async function electronCheck(): Promise<Check> {
  const name = "electron";
  const enable =
    "start the app with `--remote-debugging-port=9333`, set BROWX_ATTACH_CDP to it, add `byob-attach` to BROWX_CAPABILITIES (that port is unauthenticated, read " +
    docsUrl.threatModelCapabilities +
    ")";
  const endpoint = process.env.BROWX_ATTACH_CDP?.trim();
  if (!endpoint) {
    return {
      name,
      ok: true,
      info: true,
      detail: 'BROWX_ATTACH_CDP not set (opt-in attach-only lane, browserType:"electron")',
      enable,
    };
  }
  // The endpoint is printed without userinfo, query or fragment, as the cdp-attach row does.
  const shown = sanitizeUrl(endpoint);
  try {
    const body = (await defaultFetcher(new URL("/json/version", endpoint).toString())) as {
      Browser?: string;
      "User-Agent"?: string;
    };
    const ua = body["User-Agent"] ?? "";
    const electron = ELECTRON_UA.exec(ua);
    if (!electron) {
      return {
        name,
        ok: true,
        info: true,
        detail: `${shown} answers, but it is not an Electron app (${body.Browser ?? "unknown"}). The attach lane will open a chromium session`,
      };
    }
    return {
      name,
      ok: true,
      info: true,
      detail: `${shown} is an Electron ${electron[1]} app (${body.Browser ?? "unknown"}). It is attach-ready as engine "electron", and \`navigate\` will refuse on it`,
    };
  } catch (e) {
    const msg = sanitizeUrlsInText(e instanceof Error ? e.message.split(".")[0]! : String(e));
    return {
      name,
      ok: true,
      info: true,
      detail: `BROWX_ATTACH_CDP=${shown} not reachable: ${msg}`,
      enable,
    };
  }
}
