// `profile_snapshot` and `profile_restore` run under `human` and add a second
// capability for what they change: `profile_snapshot` writes a copy of the
// profile into the workspace, so it needs `file-io`; `profile_restore` replaces
// a profile's cookies and storage, so it needs `action`. Browser-free: the
// handlers run against a stub host whose gate refuses every extra capability
// not enabled, and nothing is copied when the gate refuses.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { registerInputTools } from "./input-tools.js";
import type { ToolResponse } from "./host.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

const root = mkdtempSync(join(tmpdir(), "browxai-profile-gate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function handlers(enabled: readonly string[]): {
  h: Record<string, Handler>;
  asked: Array<[string, readonly string[]]>;
} {
  const h: Record<string, Handler> = {};
  const asked: Array<[string, readonly string[]]> = [];
  const host = {
    z,
    register: (name: string, _def: unknown, handler: Handler) => {
      h[name] = handler;
    },
    gateCheck: (tool: string, extra?: readonly string[], reason?: string) => {
      asked.push([tool, extra ?? []]);
      const missing = (extra ?? []).find((c) => !enabled.includes(c));
      if (!missing) return null;
      const text = JSON.stringify({ ok: false, requiredCapability: missing, reason });
      return { content: [{ type: "text", text }] };
    },
    // One open session, so a call past every gate stops at the "close all
    // sessions first" check and copies nothing.
    registry: { list: () => [{ id: "open" }] },
    workspace: { root, defaultProfile: () => join(root, "profile") },
  };
  registerInputTools(host as never);
  return { h, asked };
}

function bodyOf(r: ToolResponse): Record<string, unknown> {
  return JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("profile_restore", () => {
  it("refuses without action and restores nothing", async () => {
    const { h } = handlers(["read", "navigation", "human"]);
    const body = bodyOf(await h.profile_restore!({ snapshot: "s" }));
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("action");
    expect(body.reason).toMatch(/profile_restore replaces/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("passes the gate with action", async () => {
    const { h, asked } = handlers(["read", "navigation", "human", "action"]);
    const body = bodyOf(await h.profile_restore!({ snapshot: "s" }));
    expect(body.requiredCapability).toBeUndefined();
    expect(body.openSessions).toEqual(["open"]);
    expect(asked).toContainEqual(["profile_restore", ["action"]]);
  });
});

describe("profile_snapshot", () => {
  it("refuses without file-io and copies nothing", async () => {
    const { h } = handlers(["read", "navigation", "action", "human"]);
    const body = bodyOf(await h.profile_snapshot!({ snapshot: "s" }));
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("file-io");
    expect(body.reason).toMatch(/^profile_snapshot writes a copy of the profile directory/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("passes the gate with file-io", async () => {
    const { h, asked } = handlers(["read", "human", "file-io"]);
    const body = bodyOf(await h.profile_snapshot!({ snapshot: "s" }));
    expect(body.requiredCapability).toBeUndefined();
    expect(body.openSessions).toEqual(["open"]);
    expect(asked).toContainEqual(["profile_snapshot", ["file-io"]]);
  });
});
