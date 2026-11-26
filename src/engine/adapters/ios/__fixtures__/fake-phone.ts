// Fakes for the physical-device path: a devicectl runner, a plutil runner and a
// WebDriverAgent `Http`, each answering from a mutable state object and recording
// every call. No Xcode, no phone and no network. Identifiers come from
// `devicectl-devices.ts` and are made up.

import type { DevicectlRunner } from "../devicectl.js";
import type { PlutilRunner } from "../bundle-id.js";
import { WdaUnreachableError, type Http } from "../wda-client.js";
import { DEVICECTL_LIST } from "./devicectl-devices.js";

export const APP_ID = "com.acme.checkout";
export const APP_PID = 4242;
export const WDA_URL = "http://192.0.2.10:8100";

export interface FakePhoneState {
  devices: unknown;
  installed: string[];
  processes: Array<{ processIdentifier: number; bundleIdentifier?: string; executable?: string }>;
  bundleId: string;
  status: Record<string, unknown>;
  locked: boolean;
  front: { bundleId: string; pid?: number };
  /** Routes that answer WebDriverAgent's "unknown command". */
  missingRoutes: string[];
  /** Make every WebDriverAgent call fail at the transport. */
  unreachable: boolean;
  /** Make every scoped call answer "invalid session id". */
  sessionLost: boolean;
}

export function phoneState(over: Partial<FakePhoneState> = {}): FakePhoneState {
  return {
    devices: DEVICECTL_LIST,
    installed: [APP_ID, "com.acme.other", "com.apple.Preferences", "com.bank.app"],
    processes: [
      {
        processIdentifier: APP_PID,
        executable: "file:///private/var/containers/Bundle/Application/F/Checkout.app/Checkout",
      },
    ],
    bundleId: APP_ID,
    status: { ready: true, os: { name: "iOS", version: "27.2" }, build: { version: "16.15.3" } },
    locked: false,
    front: { bundleId: APP_ID, pid: APP_PID },
    missingRoutes: [],
    unreachable: false,
    sessionLost: false,
    ...over,
  };
}

export function fakeDevicectl(state: FakePhoneState): { run: DevicectlRunner; calls: string[] } {
  const calls: string[] = [];
  const run: DevicectlRunner = (args) => {
    const line = args.join(" ");
    calls.push(line);
    if (line.startsWith("devicectl list devices")) return Promise.resolve(state.devices);
    if (line.includes("device info apps")) {
      return Promise.resolve({
        result: { apps: state.installed.map((bundleIdentifier) => ({ bundleIdentifier })) },
      });
    }
    if (line.includes("device info processes")) {
      return Promise.resolve({ result: { runningProcesses: state.processes } });
    }
    if (line.includes("device install app")) return Promise.resolve({ result: {} });
    return Promise.reject(new Error(`unexpected devicectl call: ${line}`));
  };
  return { run, calls };
}

export function fakePlutil(state: FakePhoneState): PlutilRunner {
  return () => Promise.resolve(`${state.bundleId}\n`);
}

export interface WdaCall {
  method: string;
  route: string;
  body?: string;
}

const SESSION = "S1";

function envelope(value: unknown): { ok: boolean; status: number; text: string } {
  return { ok: true, status: 200, text: JSON.stringify({ value, sessionId: SESSION }) };
}

function wdaError(code: string, status: number): { ok: boolean; status: number; text: string } {
  return { ok: false, status, text: JSON.stringify({ value: { error: code, message: code } }) };
}

function answer(state: FakePhoneState, method: string, route: string): unknown {
  if (route === "/status") return state.status;
  if (route === "/wda/locked") return state.locked;
  if (route === "/session" && method === "POST") return { sessionId: SESSION };
  if (route.endsWith("/wda/activeAppInfo")) return state.front;
  if (route.endsWith("/screenshot")) return Buffer.from("PNGDATA").toString("base64");
  if (route.endsWith("/source")) return { type: "XCUIElementTypeApplication", children: [] };
  if (route === "/element" && method === "POST") return { ELEMENT: "ROOT" };
  return null;
}

export function fakeWda(state: FakePhoneState): { http: Http; calls: WdaCall[] } {
  const calls: WdaCall[] = [];
  const http: Http = (url, init) => {
    const route = url.slice(WDA_URL.length).replace(`/session/${SESSION}`, "").split("?")[0]!;
    calls.push({ method: init.method, route, ...(init.body ? { body: init.body } : {}) });
    if (state.unreachable) {
      return Promise.reject(
        new WdaUnreachableError(url, "connect ECONNREFUSED 192.0.2.10:8100", "device"),
      );
    }
    if (state.missingRoutes.includes(route))
      return Promise.resolve(wdaError("unknown command", 404));
    if (state.sessionLost && url.includes(`/session/${SESSION}`)) {
      return Promise.resolve(wdaError("invalid session id", 404));
    }
    return Promise.resolve(envelope(answer(state, init.method, route)));
  };
  return { http, calls };
}
