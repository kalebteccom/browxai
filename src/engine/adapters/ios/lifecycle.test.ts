// `IosLifecycle` — the five verbs that run and the two that refuse.
//
// The two refusals are the load-bearing cases. `app_uninstall` and `app_reset`
// are registered tools that an agent can call on any native session, and an
// `ios-app` session has a `NativeLifecycle` like every other one. What must NOT
// happen is a quiet `{ok:true}` for an uninstall that removed nothing or a reset
// that cleared nothing — that is the plausible-empty the whole native gate is
// built against, one layer down from the sub-interface conformance test.

import { describe, it, expect } from "vitest";
import { IosLifecycle } from "./lifecycle.js";
import { NativeUnsupportedError } from "../../native-types.js";
import type { NativeAppInfo, NativeDriver } from "../../native-types.js";
import type { IosSimulator } from "./simulator.js";

function rig(): { lifecycle: IosLifecycle; calls: string[] } {
  const calls: string[] = [];
  const sim = {
    listApps: async (): Promise<NativeAppInfo[]> => [
      { bundleId: "com.acme.checkout" },
      { bundleId: "com.apple.Preferences" },
    ],
    install: async (path: string) => {
      calls.push(`install:${path}`);
    },
    launch: async (bundleId: string): Promise<NativeAppInfo> => {
      calls.push(`launch:${bundleId}`);
      return { bundleId, pid: 4242 };
    },
    terminate: async (bundleId: string) => {
      calls.push(`terminate:${bundleId}`);
    },
  } as unknown as IosSimulator;
  const driver = {
    foregroundApp: async (): Promise<NativeAppInfo> => ({ bundleId: "com.acme.checkout" }),
  } as unknown as NativeDriver;
  return { lifecycle: new IosLifecycle(sim, driver), calls };
}

describe("IosLifecycle — the app_* family on ios-app", () => {
  it("lists every bundle id simctl reported", async () => {
    await expect(rig().lifecycle.apps(false)).resolves.toEqual([
      "com.acme.checkout",
      "com.apple.Preferences",
    ]);
  });

  it("installs and launches through simctl", async () => {
    const { lifecycle, calls } = rig();
    await lifecycle.install("/tmp/Checkout.app", false);
    await expect(lifecycle.launch("com.acme.checkout")).resolves.toEqual({
      appId: "com.acme.checkout",
    });
    await lifecycle.terminate("com.acme.checkout");
    expect(calls).toEqual([
      "install:/tmp/Checkout.app",
      "launch:com.acme.checkout",
      "terminate:com.acme.checkout",
    ]);
  });

  it("reports no activity, because iOS has none", async () => {
    // The android handle carries `{appId, activity}` and this one must not
    // invent a second field to match it — a guessed screen name in the session's
    // own record of what it is driving is worse than an absent one.
    const launched = await rig().lifecycle.launch("com.acme.checkout");
    expect(launched.activity).toBeUndefined();
    await expect(rig().lifecycle.foreground()).resolves.toEqual({ appId: "com.acme.checkout" });
  });

  it("REFUSES app_uninstall, naming the engine and the reason", async () => {
    const err = await rig()
      .lifecycle.uninstall("com.acme.checkout")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NativeUnsupportedError);
    expect((err as NativeUnsupportedError).engine).toBe("ios-app");
    expect((err as NativeUnsupportedError).verb).toBe("app_uninstall");
    expect((err as Error).message).toContain("com.acme.checkout");
    expect((err as Error).message).toContain("xcrun simctl uninstall");
  });

  it("REFUSES app_reset, naming the erase-wipes-everything reason", async () => {
    const err = await rig()
      .lifecycle.reset("com.acme.checkout")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NativeUnsupportedError);
    expect((err as NativeUnsupportedError).verb).toBe("app_reset");
    expect((err as Error).message).toContain("simctl erase");
    expect((err as Error).message).toContain("EVERY app");
  });

  it("rejects rather than throws synchronously, so an awaiting caller catches it", async () => {
    // A bare `throw` from a method typed `Promise<void>` fires at the call site,
    // before the caller's `await` exists. The `async` keyword is what converts it
    // into the rejection the port promises, and this is the test that pins it.
    const { lifecycle } = rig();
    const pending = lifecycle.reset("com.acme.checkout");
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(NativeUnsupportedError);
  });
});
