import { describe, it, expect } from "vitest";
import {
  assertSafariAvailable,
  launchSafaridriver,
  SafariUnavailableError,
  SafariLaunchTimeoutError,
  type ProcessLike,
} from "./launch.js";

// The launch orchestration — platform/binary precheck + the readiness poll —
// tested with injected seams (spawn, the readiness probe, the sleep, the port
// pick), entirely WITHOUT safaridriver or macOS. The real IO is covered by the
// Safari-gated keystone.

function fakeProc(): { proc: ProcessLike; killed: () => number } {
  let kills = 0;
  return {
    proc: { pid: 7, kill: () => (kills++, true) },
    killed: () => kills,
  };
}

describe("assertSafariAvailable", () => {
  it("throws off-macOS", () => {
    expect(() => assertSafariAvailable({ platform: "linux" })).toThrow(SafariUnavailableError);
  });

  it("throws when safaridriver is absent", () => {
    expect(() => assertSafariAvailable({ platform: "darwin", binaryExists: () => false })).toThrow(
      /not found/,
    );
  });

  it("passes when macOS + binary present", () => {
    expect(() =>
      assertSafariAvailable({ platform: "darwin", binaryExists: () => true }),
    ).not.toThrow();
  });
});

describe("launchSafaridriver", () => {
  const base = {
    platform: "darwin" as NodeJS.Platform,
    binaryExists: () => true,
    pickPort: async () => 4444,
    sleep: async () => undefined,
  };

  it("spawns the driver and returns once /status reports ready", async () => {
    const { proc } = fakeProc();
    const spawnCalls: string[][] = [];
    let probes = 0;
    const result = await launchSafaridriver({
      ...base,
      spawnImpl: (cmd, args) => {
        spawnCalls.push([cmd, ...args]);
        return proc;
      },
      // not ready for the first two polls, then ready
      probeReady: async () => ++probes >= 3,
      pollIntervalMs: 1,
      readinessTimeoutMs: 100,
    });
    expect(result.baseUrl).toBe("http://127.0.0.1:4444");
    expect(spawnCalls[0]?.[0]).toMatch(/safaridriver$/);
    expect(spawnCalls[0]).toContain("--bidi");
    expect(probes).toBe(3);
  });

  it("kills the process and throws on readiness timeout", async () => {
    const { proc, killed } = fakeProc();
    await expect(
      launchSafaridriver({
        ...base,
        spawnImpl: () => proc,
        probeReady: async () => false,
        pollIntervalMs: 1,
        readinessTimeoutMs: 3,
      }),
    ).rejects.toBeInstanceOf(SafariLaunchTimeoutError);
    expect(killed()).toBeGreaterThan(0);
  });

  it("fast-fails off-macOS without spawning", async () => {
    let spawned = false;
    await expect(
      launchSafaridriver({
        platform: "linux",
        spawnImpl: () => {
          spawned = true;
          return fakeProc().proc;
        },
      }),
    ).rejects.toBeInstanceOf(SafariUnavailableError);
    expect(spawned).toBe(false);
  });
});
