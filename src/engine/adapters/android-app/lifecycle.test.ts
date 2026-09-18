// `AndroidLifecycle` — the `app_*` family's android implementation.
//
// The translation is thin, and the two cases worth pinning are the ones a thin
// translation gets wrong: `includeSystem` inverts into `AndroidDevice`'s
// `thirdPartyOnly`, and a foreground reading is `{packageName, activity}` on one
// side and `{appId, activity}` on the other. Both are silent-wrong-answer shapes
// if they drift, not crashes.

import { describe, it, expect } from "vitest";
import { AndroidLifecycle } from "./lifecycle.js";
import type { AndroidDevice } from "./device.js";

function rig(): { lifecycle: AndroidLifecycle; calls: string[] } {
  const calls: string[] = [];
  const device = {
    packages: async (thirdPartyOnly: boolean) => {
      calls.push(`packages:${thirdPartyOnly}`);
      return ["com.acme.app"];
    },
    install: async (p: string, reinstall: boolean) => {
      calls.push(`install:${p}:${reinstall}`);
    },
    uninstall: async (pkg: string) => {
      calls.push(`uninstall:${pkg}`);
    },
    launchApp: async (pkg: string) => {
      calls.push(`launch:${pkg}`);
      return `${pkg}/.MainActivity`;
    },
    terminateApp: async (pkg: string) => {
      calls.push(`terminate:${pkg}`);
    },
    clearApp: async (pkg: string) => {
      calls.push(`clear:${pkg}`);
    },
    foreground: async () => ({
      packageName: "com.acme.app",
      activity: "com.acme.app.MainActivity",
    }),
  } as unknown as AndroidDevice;
  return { lifecycle: new AndroidLifecycle(device), calls };
}

describe("AndroidLifecycle — the app_* family on android-app", () => {
  it("inverts includeSystem into thirdPartyOnly", async () => {
    const { lifecycle, calls } = rig();
    await lifecycle.apps(false);
    await lifecycle.apps(true);
    expect(calls).toEqual(["packages:true", "packages:false"]);
  });

  it("carries the resolved activity onto the app target", async () => {
    await expect(rig().lifecycle.launch("com.acme.app")).resolves.toEqual({
      appId: "com.acme.app",
      activity: "com.acme.app/.MainActivity",
    });
  });

  it("renames packageName to appId on a foreground reading", async () => {
    await expect(rig().lifecycle.foreground()).resolves.toEqual({
      appId: "com.acme.app",
      activity: "com.acme.app.MainActivity",
    });
  });

  it("implements uninstall and reset, which ios-app refuses", async () => {
    const { lifecycle, calls } = rig();
    await lifecycle.uninstall("com.acme.app");
    await lifecycle.reset("com.acme.app");
    await lifecycle.install("/tmp/app.apk", true);
    await lifecycle.terminate("com.acme.app");
    expect(calls).toEqual([
      "uninstall:com.acme.app",
      "clear:com.acme.app",
      "install:/tmp/app.apk:true",
      "terminate:com.acme.app",
    ]);
  });
});
