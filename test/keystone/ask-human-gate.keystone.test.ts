// ask-human gate keystone. `ask-human` permission and file-picker policies hold
// a page's request until a person answers. `set_permission_policy` and
// `set_fs_picker_policy` are `action` tools, so without a gate the agent could
// switch the policy to `allow` and answer the prompt itself. Both setters must
// refuse to move a policy off `ask-human` unless the operator enabled the
// off-by-default `human-gate-override` capability at server start.
//
// Real headless Chromium through the MCP handlers. The policy state is read off
// what the browser does, not off the setter's reply:
//   - permission: the CDP baseline decides what `navigator.permissions.query`
//     reports ("prompt" under ask-human, "granted" under allow).
//   - file picker: a page's `showSaveFilePicker` call stays blocked while the
//     policy is `ask-human`, and resolves as `allowed` once it is `allow`.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

const KEYSTONE_TIMEOUT = 120_000;
const DEFAULT_CAPS = "read,navigation,action,human";

type Server_ = Awaited<ReturnType<typeof createServer>>;

let fixture: Fixture;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};
const servers: Server_[] = [];

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-askhuman-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  fixture = await startFixture();
}, KEYSTONE_TIMEOUT);

afterEach(async () => {
  for (const s of servers.splice(0)) await s.shutdown().catch(() => undefined);
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await fixture?.close().catch(() => undefined);
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

/** Capabilities resolve once at server start, so each capability set gets its own server. */
async function start(caps: string) {
  process.env.BROWX_CAPABILITIES = caps;
  const server = await createServer({ headless: true });
  servers.push(server);
  const call = async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const fn = server.handlers[name];
    if (!fn) throw new Error(`ask-human-gate keystone: no handler "${name}"`);
    const res = await fn(args);
    return JSON.parse((res.content[0] as { text: string }).text) as T;
  };
  return call;
}

type Call = Awaited<ReturnType<typeof start>>;
type Refusal = { ok: boolean; requiredCapability?: string; error?: string; reason?: string };

async function openAskHuman(call: Call, session: string): Promise<void> {
  const opened = await call<{ ok?: boolean }>("open_session", {
    session,
    mode: "incognito",
    permissionPolicy: "ask-human",
    fsPickerPolicy: "ask-human",
    notificationPolicy: "ask-human",
  });
  expect(opened.ok).not.toBe(false);
  await call("navigate", { session, url: `${fixture.url}/` });
}

async function geolocationState(call: Call, session: string): Promise<string> {
  const r = await call<{ ok: boolean; states: Record<string, string> }>("permission_state", {
    session,
    permissions: ["geolocation"],
  });
  expect(r.ok).toBe(true);
  return r.states.geolocation!;
}

async function midiState(call: Call, session: string): Promise<string> {
  const r = await call<{ ok: boolean; states: Record<string, string> }>("permission_state", {
    session,
    permissions: ["midi"],
  });
  expect(r.ok).toBe(true);
  return r.states.midi!;
}

/** `start` plus a raw-text caller, for tools (`snapshot`) that answer in plain text. */
async function startWithText(caps: string) {
  const call = await start(caps);
  const server = servers[servers.length - 1]!;
  const callText = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await server.handlers[name]!(args);
    return (res.content[0] as { text: string }).text;
  };
  return { call, callText };
}

describe("set_permission_policy leaving ask-human", () => {
  it(
    "refuses without human-gate-override, leaves the browser's permission state alone",
    async () => {
      const call = await start(DEFAULT_CAPS);
      const session = "ks-perm-denied";
      await openAskHuman(call, session);
      const before = await geolocationState(call, session);
      expect(before).toBe("prompt");

      const refused = await call<Refusal>("set_permission_policy", { session, mode: "allow" });
      expect(refused.ok).toBe(false);
      expect(refused.requiredCapability).toBe("human-gate-override");
      expect(refused.reason).toMatch(/off "ask-human"/);
      expect(await geolocationState(call, session)).toBe("prompt");

      // A per-permission override is a way out too.
      const viaOverride = await call<Refusal>("set_permission_policy", {
        session,
        mode: "ask-human",
        perPermission: { geolocation: "allow" },
      });
      expect(viaOverride.requiredCapability).toBe("human-gate-override");
      expect(await geolocationState(call, session)).toBe("prompt");

      // The batch path reaches the same gate.
      const batched = await call<{ results: Array<{ ok: boolean }> }>("batch", {
        calls: [{ tool: "set_permission_policy", args: { session, mode: "allow" } }],
      });
      expect(batched.results[0]!.ok).toBe(false);
      expect(await geolocationState(call, session)).toBe("prompt");

      // Staying on ask-human is still allowed.
      const kept = await call<{ ok: boolean; policy: { mode: string } }>("set_permission_policy", {
        session,
        mode: "ask-human",
        perPermission: { camera: "ask-human" },
      });
      expect(kept.ok).toBe(true);
      expect(kept.policy.mode).toBe("ask-human");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "moves off ask-human when the operator enabled human-gate-override",
    async () => {
      const call = await start(`${DEFAULT_CAPS},human-gate-override`);
      const session = "ks-perm-allowed";
      await openAskHuman(call, session);
      expect(await geolocationState(call, session)).toBe("prompt");

      const changed = await call<{ ok: boolean; policy: { mode: string } }>(
        "set_permission_policy",
        { session, mode: "allow" },
      );
      expect(changed.ok).toBe(true);
      expect(changed.policy.mode).toBe("allow");
      expect(await geolocationState(call, session)).toBe("granted");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a session that never used ask-human changes policy freely",
    async () => {
      const call = await start(DEFAULT_CAPS);
      const session = "ks-perm-free";
      await call("open_session", { session, mode: "incognito" });
      await call("navigate", { session, url: `${fixture.url}/` });
      const changed = await call<{ ok: boolean }>("set_permission_policy", {
        session,
        mode: "allow",
      });
      expect(changed.ok).toBe(true);
      expect(await geolocationState(call, session)).toBe("granted");
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("set_fs_picker_policy leaving ask-human", () => {
  it(
    "refuses without human-gate-override, and the picker stays held for a human",
    async () => {
      const { call, callText } = await startWithText(DEFAULT_CAPS);
      const session = "ks-fs-denied";
      await openAskHuman(call, session);

      const refused = await call<Refusal>("set_fs_picker_policy", { session, mode: "allow" });
      expect(refused.ok).toBe(false);
      expect(refused.requiredCapability).toBe("human-gate-override");
      expect(refused.reason).toMatch(/off "ask-human"/);

      const viaPerApi = await call<Refusal>("set_fs_picker_policy", {
        session,
        mode: "ask-human",
        perAPI: { showSaveFilePicker: "allow" },
      });
      expect(viaPerApi.requiredCapability).toBe("human-gate-override");

      const batched = await call<{ results: Array<{ ok: boolean }> }>("batch", {
        calls: [{ tool: "set_fs_picker_policy", args: { session, mode: "allow" } }],
      });
      expect(batched.results[0]!.ok).toBe(false);

      // The page's picker call is still waiting on a human. Under `allow` it
      // resolves at once (the other test), so a wait that outlasts a generous
      // window with no outcome on the page and nothing recorded as handled
      // means the policy did not change. Shutdown (afterEach) releases the wait.
      const clicked = await call<{ fsPickerRequests?: Array<{ handledAs: string }> }>("click", {
        session,
        selector: '[data-testid="save-btn-fs"]',
      });
      expect(clicked.fsPickerRequests ?? []).toEqual([]);
      await new Promise((r) => setTimeout(r, 2_500));
      const text = await callText("snapshot", { session });
      expect(text).toContain("pending");
      expect(text).not.toMatch(/got-handle|wrote name=|picker-error/);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "moves off ask-human when the operator enabled human-gate-override",
    async () => {
      const call = await start(`${DEFAULT_CAPS},human-gate-override`);
      const session = "ks-fs-allowed";
      await openAskHuman(call, session);

      const changed = await call<{ ok: boolean; policy: { mode: string } }>(
        "set_fs_picker_policy",
        { session, mode: "allow" },
      );
      expect(changed.ok).toBe(true);
      expect(changed.policy.mode).toBe("allow");

      const clicked = await call<{
        fsPickerRequests?: Array<{ api: string; handledAs: string }>;
      }>("click", { session, selector: '[data-testid="save-btn-fs"]' });
      expect(clicked.fsPickerRequests?.find((r) => r.api === "showSaveFilePicker")?.handledAs).toBe(
        "allowed",
      );
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("set_notification_policy leaving ask-human", () => {
  it(
    "refuses without human-gate-override and keeps the policy; allows it with the capability",
    async () => {
      const call = await start(DEFAULT_CAPS);
      const session = "ks-notif-denied";
      await openAskHuman(call, session);
      const refused = await call<Refusal>("set_notification_policy", { session, mode: "allow" });
      expect(refused.ok).toBe(false);
      expect(refused.requiredCapability).toBe("human-gate-override");
      const kept = await call<{ ok: boolean; policy: { mode: string } }>(
        "set_notification_policy",
        { session, mode: "ask-human" },
      );
      expect(kept.ok).toBe(true);
      expect(kept.policy.mode).toBe("ask-human");

      const callOverride = await start(`${DEFAULT_CAPS},human-gate-override`);
      const s2 = "ks-notif-allowed";
      await openAskHuman(callOverride, s2);
      const changed = await callOverride<{ ok: boolean; policy: { mode: string } }>(
        "set_notification_policy",
        { session: s2, mode: "allow" },
      );
      expect(changed.ok).toBe(true);
      expect(changed.policy.mode).toBe("allow");
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("grant_permissions on an ask-human policy", () => {
  it(
    "refuses a native grant the page wrappers don't intercept, without the capability",
    async () => {
      const call = await start(DEFAULT_CAPS);
      const session = "ks-grant-denied";
      await openAskHuman(call, session);
      expect(await midiState(call, session)).toBe("prompt");

      const refused = await call<Refusal>("grant_permissions", { session, permissions: ["midi"] });
      expect(refused.ok).toBe(false);
      expect(refused.requiredCapability).toBe("human-gate-override");
      expect(refused.reason).toMatch(/midi/);
      expect(await midiState(call, session)).toBe("prompt");

      // Notification.permission reads the native state, so a grant would let the
      // page show notifications with no prompt: refused too.
      const notif = await call<Refusal>("grant_permissions", {
        session,
        permissions: ["notifications"],
      });
      expect(notif.requiredCapability).toBe("human-gate-override");
      const states = await call<{ states: Record<string, string> }>("permission_state", {
        session,
        permissions: ["notifications"],
      });
      expect(states.states.notifications).not.toBe("granted");

      // Wrapped names still go through (their main entry points ask the human), and so does clearing.
      const wrapped = await call<{ ok: boolean }>("grant_permissions", {
        session,
        permissions: ["geolocation"],
      });
      expect(wrapped.ok).toBe(true);
      expect((await call<{ ok: boolean }>("grant_permissions", { session })).ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "grants it when the operator enabled human-gate-override",
    async () => {
      const call = await start(`${DEFAULT_CAPS},human-gate-override`);
      const session = "ks-grant-allowed";
      await openAskHuman(call, session);
      const granted = await call<{ ok: boolean }>("grant_permissions", {
        session,
        permissions: ["midi"],
      });
      expect(granted.ok).toBe(true);
      expect(await midiState(call, session)).toBe("granted");
    },
    KEYSTONE_TIMEOUT,
  );
});
