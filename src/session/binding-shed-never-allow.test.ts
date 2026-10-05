// Under an `allow` policy, a binding call the per-page budget sheds must never
// come back as an approval. One case per decision binding, with a real attach
// adapter behind a fake context.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import { PermissionPolicyState, attachPermissionPolicy } from "./permission.js";
import { NotificationPolicyState, attachNotificationPolicy } from "./notification.js";
import { FsPickerPolicyState, attachFsPickerPolicy } from "./fs-picker.js";
import { DeviceEmulationState, attachDeviceEmulation } from "./device-emu.js";
import { DEFAULT_BUDGETS } from "./binding-guard.js";

type Binding = (source: unknown, payload: string) => unknown;

function fakeContext(bindings: Map<string, Binding>): BrowserContext {
  return {
    exposeBinding: async (name: string, fn: Binding) => {
      bindings.set(name, fn);
    },
    addInitScript: async () => undefined,
    pages: () => [],
  } as unknown as BrowserContext;
}

/** The value `p` settled to, or `NEVER` when it has not settled after a macrotask. */
const NEVER = Symbol("never");
async function settled(p: unknown): Promise<unknown> {
  return Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r(NEVER), 0))]);
}

/** Fire `calls` from one page and return what each one settled to, in order.
 *  One at a time, as CDP delivers them, so the in-flight cap is not what sheds. */
async function flood(binding: Binding, payload: string, calls: number): Promise<unknown[]> {
  const page = {};
  const out: unknown[] = [];
  for (let i = 0; i < calls; i++) out.push(await settled(binding({ page }, payload)));
  return out;
}

const BURST = DEFAULT_BUDGETS.decision.burst;
const CALLS = BURST + 60;

describe("a shed call is never an approval under an allow policy", () => {
  // A frozen clock: tokens that refill while the test runs would admit calls
  // past the burst and blur which ones were shed.
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("permission_check", async () => {
    const bindings = new Map<string, Binding>();
    await attachPermissionPolicy(
      fakeContext(bindings),
      new PermissionPolicyState({ mode: "allow" }),
      async () => "deny",
    );
    const out = await flood(
      bindings.get("__browx_permission_check")!,
      JSON.stringify({ permission: "geolocation", origin: "https://x.test" }),
      CALLS,
    );
    expect(out.slice(0, BURST).every((v) => v === "allow")).toBe(true);
    const shed = out.slice(BURST);
    expect(shed.some((v) => v === "allow")).toBe(false);
    expect(shed.some((v) => v === "deny")).toBe(true);
    expect(shed.some((v) => v === NEVER)).toBe(true);
  });

  it("notification_check", async () => {
    const bindings = new Map<string, Binding>();
    await attachNotificationPolicy(
      fakeContext(bindings),
      new NotificationPolicyState({ mode: "allow" }),
      async () => "deny",
    );
    const out = await flood(
      bindings.get("__browx_notification_check")!,
      JSON.stringify({ title: "t", origin: "https://x.test" }),
      CALLS,
    );
    expect(out.slice(0, BURST).every((v) => v === "allow")).toBe(true);
    const shed = out.slice(BURST);
    expect(shed.some((v) => v === "allow")).toBe(false);
    expect(shed.some((v) => v === "deny")).toBe(true);
    expect(shed.some((v) => v === NEVER)).toBe(true);
  });

  it("fs_picker_check", async () => {
    const bindings = new Map<string, Binding>();
    await attachFsPickerPolicy(
      fakeContext(bindings),
      new FsPickerPolicyState({ mode: "allow" }),
      "/tmp/browx-shed-test",
      async () => null,
    );
    const out = (
      await flood(
        bindings.get("__browx_fs_picker_check")!,
        JSON.stringify({ api: "showOpenFilePicker" }),
        CALLS,
      )
    ).map((v) => (typeof v === "string" ? (JSON.parse(v) as { decision: string }).decision : v));
    expect(out.slice(0, BURST).every((v) => v === "allow")).toBe(true);
    const shed = out.slice(BURST);
    expect(shed.some((v) => v === "allow")).toBe(false);
    expect(shed.some((v) => v === "deny")).toBe(true);
    expect(shed.some((v) => v === NEVER)).toBe(true);
  });

  it("device_check", async () => {
    const bindings = new Map<string, Binding>();
    const state = new DeviceEmulationState(true);
    state.set("usb", [{ name: "token" }]);
    await attachDeviceEmulation(fakeContext(bindings), state);
    const out = (
      await flood(
        bindings.get("__browx_device_check")!,
        JSON.stringify({ api: "usb", filters: [] }),
        CALLS,
      )
    ).map((v) => (typeof v === "string" ? (JSON.parse(v) as { decision: string }).decision : v));
    // "resolved" hands a device to the page: the approval-equivalent here.
    expect(out.slice(0, BURST).every((v) => v === "resolved")).toBe(true);
    const shed = out.slice(BURST);
    expect(shed.some((v) => v === "resolved")).toBe(false);
    expect(shed.some((v) => v === "refused")).toBe(true);
    expect(shed.some((v) => v === NEVER)).toBe(true);
  });
});
