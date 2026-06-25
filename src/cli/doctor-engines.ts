// `browxai doctor` — the per-engine availability probes.
//
// One probe per browser engine doctor reports on: chromium (the managed-mode
// dependency — a missing binary FAILS doctor) and the three opt-in lanes —
// firefox, webkit, android — whose probes are always INFORMATIONAL (a missing
// binary / no device just tells the operator how to enable the engine; it never
// fails doctor). Each returns a doctor `Check` row; doctor.ts owns the checklist
// orchestration + the engine-SELECTION diagnostic (which engine the server would
// run on) and calls these for the readiness rows the selection line points at.
//
// These probes never reach past the engine port: the android adb-chain probe
// drives the adb/CDP helpers re-exported from src/engine/index.ts, so the gate
// stays routed through its existing seam.

import { existsSync } from "node:fs";
import type { Check } from "./doctor.js";
import {
  AndroidCdpAdapter,
  defaultAdbRunner,
  defaultFetcher,
  pickFreePort,
  forwardArgs,
  forwardRemoveArgs,
  versionUrl,
  extractWsUrl,
} from "../engine/index.js";

// Chromium installed (managed-mode dependency). Lazy import so doctor doesn't pay
// the playwright-core cost on bare invocation. A missing binary FAILS doctor —
// chromium is the default engine, not opt-in.
export async function chromiumCheck(): Promise<Check> {
  try {
    const { chromium } = await import("playwright-core");
    const path = chromium.executablePath();
    if (path && existsSync(path)) {
      return { name: "chromium", ok: true, detail: `${path}` };
    }
    return {
      name: "chromium",
      ok: false,
      detail: "playwright-core has no Chromium binary cached",
      fix: "run `pnpm install-browser`",
    };
  } catch (e) {
    return {
      name: "chromium",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "run `pnpm install` and `pnpm install-browser`",
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
      detail: 'not installed (opt-in second engine — browserType:"firefox")',
      fix: "run `npx playwright install firefox` to enable the firefox engine",
    };
  } catch (e) {
    return {
      name: "firefox",
      ok: true,
      info: true,
      detail: e instanceof Error ? e.message : String(e),
      fix: "run `npx playwright install firefox` to enable the firefox engine",
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
      detail: 'not installed (opt-in third engine — browserType:"webkit")',
      fix: "run `npx playwright install webkit` to enable the webkit engine",
    };
  } catch (e) {
    return {
      name: "webkit",
      ok: true,
      info: true,
      detail: e instanceof Error ? e.message : String(e),
      fix: "run `npx playwright install webkit` to enable the webkit engine",
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
      detail: `${msg} (opt-in BYOB lane — browserType:"android")`,
      fix: "connect an Android phone over USB, enable USB debugging, open Chrome",
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
      detail: `device ${serial} ready, Chrome reachable (${browser}) — browserType:"android" attach-ready`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message.split(".")[0] : String(e);
    return {
      name,
      ok: true,
      info: true,
      detail: `device ${serial} ready but Chrome socket not reachable: ${msg}`,
      fix: "open Chrome on the device + enable USB web-debugging (chrome://inspect should list its tabs)",
    };
  } finally {
    if (localPort) {
      await defaultAdbRunner(forwardRemoveArgs(localPort, serial)).catch(() => undefined);
    }
  }
}
