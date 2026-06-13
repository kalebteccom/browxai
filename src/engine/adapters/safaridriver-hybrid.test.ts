import { describe, it, expect } from "vitest";
import {
  SafaridriverHybridAdapter,
  SafariSessionBusyError,
  SafariRemoteAutomationDisabledError,
} from "./safaridriver-hybrid.js";
import { SafariWebDriverClient, WebDriverError } from "./safari/webdriver-client.js";
import { SafariBidiClient } from "./safari/bidi-client.js";
import type { SafariDriverProcess } from "./safari/launch.js";

// Orchestration tests for the hybrid adapter — caps negotiation, the additive/
// optional BiDi layer, single-session enforcement, and the structured refusals —
// entirely WITHOUT safaridriver. The real IO is covered by the Safari-gated
// keystone.

function fakeDriver(): SafariDriverProcess {
  return {
    baseUrl: "http://127.0.0.1:4444",
    httpPort: 4444,
    process: { pid: 1, kill: () => true },
    stop: () => undefined,
  };
}

/** A fake Classic client; `wsUrl` controls whether BiDi negotiates. */
function fakeWebDriver(
  opts: { wsUrl?: string; sessionError?: WebDriverError } = {},
): SafariWebDriverClient {
  return {
    newSession: async () => {
      if (opts.sessionError) throw opts.sessionError;
      return { sessionId: "SID", capabilities: {}, webSocketUrl: opts.wsUrl };
    },
    deleteSession: async () => undefined,
  } as unknown as SafariWebDriverClient;
}

function fakeBidi(connectThrows = false): SafariBidiClient {
  return {
    connect: async () => {
      if (connectThrows) throw new Error("ws refused");
    },
    close: () => undefined,
  } as unknown as SafariBidiClient;
}

function adapterWith(opts: {
  wsUrl?: string;
  sessionError?: WebDriverError;
  bidiConnectThrows?: boolean;
}): SafaridriverHybridAdapter {
  return new SafaridriverHybridAdapter({
    launch: async () => fakeDriver(),
    webDriverFactory: () => fakeWebDriver({ wsUrl: opts.wsUrl, sessionError: opts.sessionError }),
    bidiFactory: () => fakeBidi(opts.bidiConnectThrows),
  });
}

describe("SafaridriverHybridAdapter — session creation", () => {
  it("creates a hybrid session with BiDi when the experimental cap yields a ws:// URL", async () => {
    const adapter = adapterWith({ wsUrl: "ws://127.0.0.1:8085/session/SID" });
    const s = await adapter.launchManaged();
    expect(s.engine).toBe("safari");
    expect(s.sessionId).toBe("SID");
    expect(s.hasBidi).toBe(true);
    expect(s.bidi).toBeDefined();
    expect(s.capabilities.deep).toBe(false);
  });

  it("falls back to Classic-only when no ws:// URL is granted (boolean placeholder)", async () => {
    const adapter = adapterWith({ wsUrl: undefined });
    const s = await adapter.launchManaged();
    expect(s.hasBidi).toBe(false);
    expect(s.bidi).toBeUndefined();
  });

  it("degrades to Classic-only when BiDi connect fails (BiDi is strictly optional)", async () => {
    const adapter = adapterWith({ wsUrl: "ws://x", bidiConnectThrows: true });
    const s = await adapter.launchManaged();
    expect(s.hasBidi).toBe(false);
  });
});

describe("SafaridriverHybridAdapter — single-session + refusals", () => {
  it("refuses a second concurrent session (safaridriver is single-session)", async () => {
    const adapter = adapterWith({ wsUrl: undefined });
    await adapter.launchManaged();
    await expect(adapter.launchManaged()).rejects.toBeInstanceOf(SafariSessionBusyError);
  });

  it("allows a new session after the first is closed", async () => {
    const adapter = adapterWith({ wsUrl: undefined });
    const s1 = await adapter.launchManaged();
    await s1.close();
    const s2 = await adapter.launchManaged();
    expect(s2.sessionId).toBe("SID");
  });

  it("maps a session-not-created failure to remote-automation-disabled", async () => {
    const adapter = adapterWith({
      sessionError: new WebDriverError("session not created", "automation not enabled", 500),
    });
    await expect(adapter.launchManaged()).rejects.toBeInstanceOf(
      SafariRemoteAutomationDisabledError,
    );
  });

  it("refuses attach() — Safari automation is non-BYOB by construction", async () => {
    const adapter = new SafaridriverHybridAdapter();
    await expect(adapter.attach()).rejects.toThrow(/safari-attach-not-supported/);
  });
});
