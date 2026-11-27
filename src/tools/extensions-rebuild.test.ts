// The extension rebuild refuses a session with no channel before it closes
// anything: Google Chrome ignores `--load-extension`, so the relaunch would come
// up without the extension, and a refusal after teardown would leave the session
// with no browser.

import { describe, it, expect, vi } from "vitest";

const managed = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../session/managed.js", () => ({
  openManagedSession: (opts: unknown) => {
    managed.calls.push(opts);
    return Promise.reject(new Error("stop after the relaunch options"));
  },
}));

import { rebuildPersistentForExtensions, type ExtensionRebuildDeps } from "./extensions-rebuild.js";
import { LaunchChannelRefusal } from "../session/chromium-launch-posture.js";
import type { SessionEntry } from "../session/registry.js";

function entry(launchChannel?: string) {
  const close = vi.fn().mockResolvedValue(undefined);
  const detach = vi.fn().mockResolvedValue(undefined);
  const e = {
    session: { profileDir: "/ws/profile", engine: "chromium", close },
    bridge: { detach },
    extensions: { loaded: [{ id: "a", path: "/ws/extensions/a", enabled: true }] },
    ...(launchChannel ? { launchChannel } : {}),
  } as unknown as SessionEntry;
  return { e, close, detach };
}

const deps = {
  caps: {},
  configStore: { resolve: () => ({}), chromiumSandboxSource: () => "default" },
  workspace: {},
  opts: { headless: false },
  resolvedConfig: {},
} as unknown as ExtensionRebuildDeps;

describe("rebuildPersistentForExtensions — channel", () => {
  it("refuses with extensions-need-chromium and leaves the session open when no channel is set", async () => {
    const { e, close, detach } = entry();
    const err = await rebuildPersistentForExtensions(e, deps).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(LaunchChannelRefusal);
    expect((err as LaunchChannelRefusal).code).toBe("extensions-need-chromium");
    expect(close).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("relaunches on the channel the session opened with", async () => {
    managed.calls = [];
    const { e, close } = entry("chromium");
    await expect(rebuildPersistentForExtensions(e, deps)).rejects.toThrow(/stop after/);
    expect(close).toHaveBeenCalledOnce();
    expect(managed.calls[0]).toMatchObject({
      channel: "chromium",
      extensionPaths: ["/ws/extensions/a"],
    });
  });
});
