// The four context-attach policy modules (permission, notification, fs-picker,
// device-emu) share one fake-context fixture and one binding-handler shape, so
// they are tested here as tables: one row per distinct branch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PermissionPolicyState,
  attachPermissionPolicy,
  applyCdpBaseline,
  parsePermissionPolicyArg,
  PERMISSION_PAGE_SCRIPT,
} from "./permission.js";
import {
  NotificationPolicyState,
  attachNotificationPolicy,
  parseNotificationPolicyArg,
  propagateSyncDecision,
  syncDecisionFor,
  NOTIFICATION_PAGE_SCRIPT,
} from "./notification.js";
import {
  FsPickerPolicyState,
  attachFsPickerPolicy,
  parseFsPickerPolicyArg,
  resolveWorkspaceFsPath,
  FS_PICKER_PAGE_SCRIPT,
  type FsPickerAskHandler,
} from "./fs-picker.js";
import {
  DeviceEmulationState,
  attachDeviceEmulation,
  reinjectDeviceEmuOnPage,
  DEVICE_EMU_PAGE_SCRIPT,
} from "./device-emu.js";
import type { BrowserContext, Page } from "playwright-core";

// ---- fakes ----------------------------------------------------------------

type Binding = (source: unknown, payload: string) => unknown;

function fakePage(): Page {
  return {
    url: () => "https://example.com/x",
    evaluate: vi.fn(async () => undefined),
  } as unknown as Page;
}

function fakeContext(
  opts: {
    bindings?: Map<string, Binding>;
    initScripts?: string[];
    pages?: Page[];
    grantCalls?: Array<{ permissions: string[]; opts?: unknown }>;
    clearCalls?: { count: number };
    grantThrows?: boolean;
    clearThrows?: boolean;
  } = {},
): BrowserContext {
  const bindings = opts.bindings ?? new Map();
  const initScripts = opts.initScripts ?? [];
  const pages = opts.pages ?? [fakePage()];
  return {
    exposeBinding: async (name: string, fn: Binding) => {
      bindings.set(name, fn);
    },
    addInitScript: async (script: { content: string }) => {
      initScripts.push(script.content);
    },
    pages: () => pages,
    grantPermissions: async (permissions: string[], optsArg?: unknown) => {
      if (opts.grantThrows) throw new Error("grant boom");
      opts.grantCalls?.push({ permissions, ...(optsArg !== undefined ? { opts: optsArg } : {}) });
    },
    clearPermissions: async () => {
      if (opts.clearThrows) throw new Error("clear boom");
      if (opts.clearCalls) opts.clearCalls.count++;
    },
  } as unknown as BrowserContext;
}

interface Harness {
  state: {
    since(t: number): Array<Record<string, unknown>>;
    raisedSince(t: number): boolean;
  };
  check: Binding;
}

type AskSpy = (...args: unknown[]) => Promise<"allow" | "deny">;

async function permissionHarness(
  policy: ConstructorParameters<typeof PermissionPolicyState>[0],
  ask?: AskSpy,
): Promise<Harness> {
  const state = new PermissionPolicyState(policy);
  const bindings = new Map<string, Binding>();
  await attachPermissionPolicy(fakeContext({ bindings }), state, ask ?? (async () => "deny"));
  const check = bindings.get("__browx_permission_check");
  if (!check) throw new Error("__browx_permission_check not installed");
  return { state: state as unknown as Harness["state"], check };
}

async function notificationHarness(
  policy: ConstructorParameters<typeof NotificationPolicyState>[0],
  ask?: AskSpy,
): Promise<Harness> {
  const state = new NotificationPolicyState(policy);
  const bindings = new Map<string, Binding>();
  await attachNotificationPolicy(fakeContext({ bindings }), state, ask ?? (async () => "deny"));
  const check = bindings.get("__browx_notification_check");
  if (!check) throw new Error("__browx_notification_check not installed");
  return { state: state as unknown as Harness["state"], check };
}

// ---- argument parsing ------------------------------------------------------

const MODES = ["allow", "deny", "raise", "ask-human"] as const;

describe("policy argument parsing", () => {
  it.each([
    {
      label: "permission: undefined defaults to raise, each string mode, perPermission object",
      parse: parsePermissionPolicyArg as (v: unknown) => unknown,
      cases: [
        [undefined, { mode: "raise" }],
        ...MODES.map((m) => [m, { mode: m }]),
        [
          { mode: "raise", perPermission: { camera: "allow", notifications: "deny" } },
          { mode: "raise", perPermission: { camera: "allow", notifications: "deny" } },
        ],
      ],
    },
    {
      label: "notification: undefined defaults to allow, each string mode",
      parse: parseNotificationPolicyArg as (v: unknown) => unknown,
      cases: [[undefined, { mode: "allow" }], ...MODES.map((m) => [m, { mode: m }])],
    },
    {
      label: "fs-picker: undefined defaults to raise, each string mode, perAPI object",
      parse: parseFsPickerPolicyArg as (v: unknown) => unknown,
      cases: [
        [undefined, { mode: "raise" }],
        ...MODES.map((m) => [m, { mode: m }]),
        [
          {
            mode: "raise",
            perAPI: { showSaveFilePicker: "allow", showOpenFilePicker: "deny" },
          },
          {
            mode: "raise",
            perAPI: { showSaveFilePicker: "allow", showOpenFilePicker: "deny" },
          },
        ],
      ],
    },
  ])("$label", ({ parse, cases }) => {
    for (const [input, expected] of cases) expect(parse(input)).toEqual(expected);
  });

  it.each([
    ["permission: unknown top-level mode", parsePermissionPolicyArg, "yes", /invalid/i],
    [
      "permission: unknown per-permission key",
      parsePermissionPolicyArg,
      { mode: "raise", perPermission: { usb: "allow" } },
      /unknown permission "usb"/,
    ],
    [
      "permission: unknown per-permission mode",
      parsePermissionPolicyArg,
      { mode: "raise", perPermission: { camera: "yes" } },
      /invalid mode/,
    ],
    ["notification: unknown string mode", parseNotificationPolicyArg, "yes", /invalid/i],
    ["notification: unknown object mode", parseNotificationPolicyArg, { mode: "yes" }, /invalid/i],
    ["fs-picker: unknown top-level mode", parseFsPickerPolicyArg, "yes", /invalid/i],
    [
      "fs-picker: unknown per-API key",
      parseFsPickerPolicyArg,
      { mode: "raise", perAPI: { showFontPicker: "allow" } },
      /unknown API/,
    ],
    [
      "fs-picker: unknown per-API mode",
      parseFsPickerPolicyArg,
      { mode: "raise", perAPI: { showSaveFilePicker: "yes" } },
      /invalid mode/,
    ],
  ] as Array<[string, (v: never) => unknown, unknown, RegExp]>)(
    "rejects %s",
    (_label, parse, input, message) => {
      expect(() => parse(input as never)).toThrow(message);
    },
  );
});

// ---- policy state ----------------------------------------------------------

describe("policy state", () => {
  it.each([
    {
      label: "permission",
      make: () => new PermissionPolicyState({ mode: "allow" }),
      record: (ts: number) => ({
        permission: "camera",
        origin: "https://x",
        handledAs: "allowed",
        ts,
      }),
    },
    {
      label: "notification",
      make: () => new NotificationPolicyState({ mode: "allow" }),
      record: (ts: number) => ({ title: "first", timestamp: ts, handledAs: "allowed" }),
    },
  ])("$label set() flips the policy for the NEXT call; prior records unchanged", (row) => {
    const s = row.make() as unknown as {
      record(r: unknown): void;
      set(p: { mode: "deny" }): unknown;
      current(): { mode: string };
      since(t: number): Array<{ handledAs: string }>;
    };
    const t0 = Date.now();
    s.record(row.record(t0));
    s.set({ mode: "deny" });
    expect(s.current().mode).toBe("deny");
    expect(s.since(t0)).toHaveLength(1);
    expect(s.since(t0)[0]?.handledAs).toBe("allowed");
  });

  it("permission modeFor honours per-permission override over top-level", () => {
    const s = new PermissionPolicyState({
      mode: "allow",
      perPermission: { notifications: "deny", camera: "ask-human" },
    });
    expect(s.modeFor("notifications")).toBe("deny");
    expect(s.modeFor("camera")).toBe("ask-human");
    expect(s.modeFor("microphone")).toBe("allow"); // falls back
  });

  it("notification normalise rejects unknown modes at construction", () => {
    expect(() => new NotificationPolicyState({ mode: "yes" as never })).toThrow(/invalid mode/i);
  });

  it("syncDecisionFor maps allow / ask-human → allow (no sync throw)", () => {
    expect(syncDecisionFor("allow")).toBe("allow");
    expect(syncDecisionFor("ask-human")).toBe("allow");
  });

  it("fs-picker modeFor honours per-API override over top-level", () => {
    const s = new FsPickerPolicyState({
      mode: "allow",
      perAPI: { showSaveFilePicker: "deny", showDirectoryPicker: "ask-human" },
    });
    expect(s.modeFor("showSaveFilePicker")).toBe("deny");
    expect(s.modeFor("showDirectoryPicker")).toBe("ask-human");
    expect(s.modeFor("showOpenFilePicker")).toBe("allow"); // falls back
  });

  it("fs-picker response queue is per-API and FIFO", () => {
    const s = new FsPickerPolicyState();
    s.pushResponse("showSaveFilePicker", [{ path: "out1.txt" }]);
    s.pushResponse("showSaveFilePicker", [{ path: "out2.txt" }]);
    s.pushResponse("showOpenFilePicker", [{ contents: "AA==" }]);
    expect(s.dequeueResponse("showSaveFilePicker")).toEqual([{ path: "out1.txt" }]);
    expect(s.dequeueResponse("showOpenFilePicker")).toEqual([{ contents: "AA==" }]);
    expect(s.dequeueResponse("showSaveFilePicker")).toEqual([{ path: "out2.txt" }]);
    expect(s.dequeueResponse("showSaveFilePicker")).toBeUndefined();
  });

  it("device-emu set() replaces the catalog for the requested API only", () => {
    const s = new DeviceEmulationState(true);
    s.set("bluetooth", [{ name: "heart-rate" }]);
    expect(s.catalog("bluetooth").devices).toHaveLength(1);
    expect(s.catalog("usb").devices).toEqual([]);
    expect(s.catalog("hid").devices).toEqual([]);
  });

  it("device-emu set() defaults missing fields so the page sees a complete shape", () => {
    const s = new DeviceEmulationState(true);
    const d = s.set("usb", [{}]).devices[0]!;
    expect(d.name).toBe("browxai-virtual");
    expect(d.id).toBe("browxai-usb-0");
    expect(d.vendorId).toBe(0x0000);
    expect(d.productId).toBe(0x0000);
    expect(d.manufacturerName).toBe("browxai virtual");
    expect(d.serialNumber).toBe("BROWX-VIRTUAL");
    expect(d.deviceClass).toBe(0xff);
    expect(d.services).toEqual([]);
    expect(d.collections).toEqual([]);
  });

  it("device-emu set() rejects non-array devices", () => {
    const s = new DeviceEmulationState(true);
    expect(() => s.set("bluetooth", "not-an-array" as never)).toThrow(/must be an array/);
  });
});

// ---- permission + notification: binding handler per mode --------------------

describe("permission and notification binding handlers", () => {
  it.each([
    {
      label: "permission allow",
      harness: permissionHarness,
      mode: "allow",
      payload: { permission: "camera", origin: "https://app" },
      decision: "allow",
      handledAs: "allowed",
      raised: false,
    },
    {
      label: "permission deny",
      harness: permissionHarness,
      mode: "deny",
      payload: { permission: "microphone" },
      decision: "deny",
      handledAs: "denied",
      raised: false,
    },
    {
      label: "permission raise",
      harness: permissionHarness,
      mode: "raise",
      payload: { permission: "geolocation" },
      decision: "deny",
      handledAs: "raised",
      raised: true,
    },
    {
      label: "notification allow",
      harness: notificationHarness,
      mode: "allow",
      payload: { title: "T", body: "B", icon: "i.png", tag: "tag1", origin: "https://app" },
      decision: "allow",
      handledAs: "allowed",
      raised: false,
    },
    {
      label: "notification deny",
      harness: notificationHarness,
      mode: "deny",
      payload: { title: "X" },
      decision: "deny",
      handledAs: "denied",
      raised: false,
    },
    {
      label: "notification raise",
      harness: notificationHarness,
      mode: "raise",
      payload: { title: "X" },
      decision: "deny",
      handledAs: "raised",
      raised: true,
    },
  ])(
    "$label → $decision, records handledAs:$handledAs",
    async ({ harness, mode, payload, decision, handledAs, raised }) => {
      const { state, check } = await harness({ mode } as never);
      const t = Date.now();
      expect(await check({}, JSON.stringify(payload))).toBe(decision);
      expect(state.since(t)[0]).toMatchObject({ ...payload, handledAs });
      expect(state.raisedSince(t)).toBe(raised);
    },
  );

  it.each([
    {
      label: "permission ask-human, handler allows",
      harness: permissionHarness,
      payload: { permission: "notifications", origin: "https://n" },
      askArgs: [["notifications", "https://n"]],
      answer: "allow" as const,
      decision: "allow",
    },
    {
      label: "notification ask-human, handler allows",
      harness: notificationHarness,
      payload: { title: "Ask", origin: "https://a" },
      askArgs: [[{ title: "Ask", origin: "https://a" }]],
      answer: "allow" as const,
      decision: "allow",
    },
    {
      label: "permission ask-human, handler throws → safe-by-default deny",
      harness: permissionHarness,
      payload: { permission: "camera" },
      askArgs: [["camera", undefined]],
      answer: "throw" as const,
      decision: "deny",
    },
    {
      label: "notification ask-human, handler throws → safe-by-default deny",
      harness: notificationHarness,
      payload: { title: "X" },
      askArgs: [[{ title: "X" }]],
      answer: "throw" as const,
      decision: "deny",
    },
  ])("$label", async ({ harness, payload, askArgs, answer, decision }) => {
    const ask = vi.fn(async (..._args: unknown[]): Promise<"allow" | "deny"> => {
      if (answer === "throw") throw new Error("boom");
      return answer;
    });
    const { state, check } = await harness({ mode: "ask-human" } as never, ask);
    const t = Date.now();
    expect(await check({}, JSON.stringify(payload))).toBe(decision);
    expect(ask.mock.calls).toEqual(askArgs);
    expect(state.since(t)[0]?.handledAs).toBe("asked-human");
  });

  it("an unknown permission name is allowed through (out-of-v1 names fall through)", async () => {
    const { check } = await permissionHarness({ mode: "raise" });
    expect(await check({}, JSON.stringify({ permission: "usb" }))).toBe("allow");
  });

  it("propagateSyncDecision re-seeds the sync hint on every live page and adds an init script", async () => {
    const state = new NotificationPolicyState({ mode: "allow" });
    const p = fakePage();
    const initScripts: string[] = [];
    const ctx = fakeContext({ pages: [p], initScripts });
    state.set({ mode: "raise" });
    await propagateSyncDecision(ctx, state);
    expect(p.evaluate).toHaveBeenCalled();
    expect(initScripts[initScripts.length - 1]!).toMatch(/"raise"/);
  });

  const baselineRows: Array<{
    label: string;
    policy: ConstructorParameters<typeof PermissionPolicyState>[0];
    grants: number;
    included: string[];
    excluded: string[];
  }> = [
    {
      label: "allow mode grants every supported permission the overrides do not exclude",
      policy: {
        mode: "allow",
        perPermission: { camera: "deny", notifications: "ask-human", microphone: "raise" },
      },
      grants: 1,
      included: ["geolocation", "clipboard-read"],
      excluded: ["camera", "microphone", "notifications"],
    },
    {
      label: "raise mode only clears (no grant call)",
      policy: { mode: "raise" },
      grants: 0,
      included: [],
      excluded: [],
    },
  ];
  it.each(baselineRows)(
    "applyCdpBaseline: $label",
    async ({ policy, grants, included, excluded }) => {
      const grantCalls: Array<{ permissions: string[] }> = [];
      const clearCalls = { count: 0 };
      await applyCdpBaseline(
        fakeContext({ grantCalls, clearCalls }),
        new PermissionPolicyState(policy),
      );
      expect(clearCalls.count).toBe(1);
      expect(grantCalls.length).toBe(grants);
      for (const name of included) expect(grantCalls[0]!.permissions).toContain(name);
      for (const name of excluded) expect(grantCalls[0]!.permissions).not.toContain(name);
    },
  );

  it("applyCdpBaseline swallows clear / grant errors without throwing", async () => {
    const ctx = fakeContext({ grantThrows: true, clearThrows: true });
    await expect(
      applyCdpBaseline(ctx, new PermissionPolicyState({ mode: "allow" })),
    ).resolves.toBeUndefined();
  });
});

// ---- fs-picker: check and write handlers ------------------------------------

describe("fs-picker binding handlers", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "browx-fspol-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  async function setupCheck(
    policy: ConstructorParameters<typeof FsPickerPolicyState>[0],
    ask?: FsPickerAskHandler,
  ) {
    const state = new FsPickerPolicyState(policy);
    const bindings = new Map<string, Binding>();
    await attachFsPickerPolicy(fakeContext({ bindings }), state, ws, ask ?? (async () => null));
    const check = bindings.get("__browx_fs_picker_check");
    const write = bindings.get("__browx_fs_picker_write");
    if (!check || !write) throw new Error("bindings not installed");
    return { state, check, write };
  }

  type Decision = {
    decision: string;
    files: Array<{ name: string; handleId: string; contents?: string }>;
  };
  const decide = async (check: Binding, payload: unknown) =>
    JSON.parse(String(await check({}, JSON.stringify(payload)))) as Decision;

  it("rejects a path escaping the workspace", () => {
    expect(() => resolveWorkspaceFsPath(ws, "../escape.txt")).toThrow(/inside \$BROWX_WORKSPACE/);
  });

  it.each([
    {
      label: "deny mode",
      policy: { mode: "deny" },
      payload: { api: "showSaveFilePicker", suggestedName: "a.txt" },
      record: { api: "showSaveFilePicker", handledAs: "denied", suggestedName: "a.txt" },
    },
    {
      label: "raise mode flips raisedSince",
      policy: { mode: "raise" },
      payload: { api: "showOpenFilePicker" },
      record: { handledAs: "raised" },
      raised: true,
    },
    {
      label: "ask-human handler answers null",
      policy: { mode: "ask-human" },
      payload: { api: "showSaveFilePicker" },
      ask: async () => null,
    },
    {
      label: "ask-human handler throws",
      policy: { mode: "ask-human" },
      payload: { api: "showSaveFilePicker" },
      ask: async () => {
        throw new Error("boom");
      },
    },
    {
      label: "unknown API name under allow",
      policy: { mode: "allow" },
      payload: { api: "showFontPicker" },
    },
  ] as Array<{
    label: string;
    policy: ConstructorParameters<typeof FsPickerPolicyState>[0];
    payload: unknown;
    record?: Record<string, unknown>;
    raised?: boolean;
    ask?: FsPickerAskHandler;
  }>)("answers deny: $label", async ({ policy, payload, record, raised, ask }) => {
    const { state, check } = await setupCheck(policy, ask);
    const t = Date.now();
    expect(await decide(check, payload)).toEqual({ decision: "deny" });
    if (record) expect(state.since(t)[0]).toMatchObject(record);
    if (raised) expect(state.raisedSince(t)).toBe(true);
  });

  it.each([
    {
      label: "queued save response",
      policy: { mode: "allow" },
      api: "showSaveFilePicker",
      response: [{ path: "out.txt" }],
      names: ["out.txt"],
    },
    {
      label: "empty queue still yields one virtual file",
      policy: { mode: "allow" },
      api: "showSaveFilePicker",
      names: ["browxai-virtual"],
    },
    {
      label: "showOpenFilePicker returns the multi-file shape",
      policy: { mode: "allow" },
      api: "showOpenFilePicker",
      response: [
        { contents: "QUFB", name: "a.txt" },
        { contents: "QkJC", name: "b.txt" },
      ],
      names: ["a.txt", "b.txt"],
    },
    {
      label: "ask-human handler approves files",
      policy: { mode: "ask-human" },
      api: "showSaveFilePicker",
      ask: async () => [{ path: "approved.txt" }],
      names: ["approved.txt"],
      handledAs: "asked-human",
    },
  ] as Array<{
    label: string;
    policy: ConstructorParameters<typeof FsPickerPolicyState>[0];
    api: "showSaveFilePicker" | "showOpenFilePicker";
    response?: Array<{ path?: string; contents?: string; name?: string }>;
    ask?: FsPickerAskHandler;
    names: string[];
    handledAs?: string;
  }>)("answers allow: $label", async ({ policy, api, response, ask, names, handledAs }) => {
    const { state, check } = await setupCheck(policy, ask);
    if (response) state.pushResponse(api, response);
    const t = Date.now();
    const parsed = await decide(check, { api, suggestedName: "x.txt" });
    expect(parsed.decision).toBe("allow");
    expect(parsed.files.map((f) => f.name)).toEqual(names);
    for (const f of parsed.files) expect(f.handleId).toMatch(/^h\d+/);
    if (handledAs) expect(state.since(t)[0]?.handledAs).toBe(handledAs);
  });

  it("runtime set() takes effect on the very next check", async () => {
    const { state, check } = await setupCheck({ mode: "allow" });
    state.pushResponse("showSaveFilePicker", [{ path: "first.txt" }]);
    expect((await decide(check, { api: "showSaveFilePicker" })).decision).toBe("allow");
    state.set({ mode: "deny" });
    expect(await decide(check, { api: "showSaveFilePicker" })).toEqual({ decision: "deny" });
  });

  it("a queued response escaping the workspace is answered deny by the check handler", async () => {
    const { state, check } = await setupCheck({ mode: "allow" });
    state.pushResponse("showSaveFilePicker", [{ path: "../escape.txt" }]);
    expect(await decide(check, { api: "showSaveFilePicker" })).toEqual({ decision: "deny" });
  });

  it.each([
    {
      label: "write, append, close persists to the workspace path",
      path: "out.txt",
      ops: [{ op: "write", data: "hello " }, { op: "write", data: "world" }, { op: "close" }],
      expected: "hello world",
    },
    {
      label: "close without a write creates an empty file",
      path: "empty.bin",
      ops: [{ op: "close" }],
      expected: "",
    },
    {
      label: "a nested directory is created on first write",
      path: "deep/nested/dir/out.txt",
      ops: [{ op: "write", data: "x" }, { op: "close" }],
      expected: "x",
    },
    {
      label: "ops after close are no-ops",
      path: "closeme.txt",
      ops: [{ op: "write", data: "first" }, { op: "close" }, { op: "write", data: "after-close" }],
      expected: "first",
    },
  ])("write handler: $label", async ({ path, ops, expected }) => {
    const { state, check, write } = await setupCheck({ mode: "allow" });
    state.pushResponse("showSaveFilePicker", [{ path }]);
    const handleId = (await decide(check, { api: "showSaveFilePicker" })).files[0]!.handleId;
    for (const o of ops) await write({}, JSON.stringify({ handleId, ...o }));
    const persisted = join(ws, path);
    expect(existsSync(persisted)).toBe(true);
    expect(readFileSync(persisted, "utf8")).toBe(expected);
  });

  it("write to an open-picker handle is a no-op (read-only virtual handle)", async () => {
    const { state, check, write } = await setupCheck({ mode: "allow" });
    state.pushResponse("showOpenFilePicker", [{ contents: "QUE=", name: "a.txt" }]);
    const handleId = (await decide(check, { api: "showOpenFilePicker" })).files[0]!.handleId;
    await write({}, JSON.stringify({ handleId, op: "write", data: "should-be-dropped" }));
    await write({}, JSON.stringify({ handleId, op: "close" }));
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
  });

  it("an unknown handle id is a silent no-op", async () => {
    const { write } = await setupCheck({ mode: "allow" });
    // exposeBinding callback is sync; Playwright accepts sync or async handlers.
    expect(
      write({}, JSON.stringify({ handleId: "h-nonexistent", op: "write", data: "x" })),
    ).toBeUndefined();
  });

  it("a write shed over budget truncates the file, and every later op rejects", async () => {
    const { state, check, write } = await setupCheck({ mode: "allow" });
    state.pushResponse("showSaveFilePicker", [{ path: "flood.txt" }]);
    const handleId = (await decide(check, { api: "showSaveFilePicker" })).files[0]!.handleId;
    const source = { page: {} };
    const op = (name: string, data: string | null = null) =>
      JSON.stringify({ handleId, op: name, data });
    // A writer that does not await each chunk: 1100 one-byte chunks at once.
    for (let i = 0; i < 1100; i++) {
      try {
        void write(source, op("write", "b64:QQ=="));
      } catch {
        // A chunk admitted after the first shed rejects; the loop does not await.
      }
    }
    // Wait for a few tokens to refill: this chunk is admitted but follows a gap.
    await new Promise((r) => setTimeout(r, 120));
    const call = (o: string) => Promise.resolve().then(() => write(source, o));
    await expect(call(op("write", "b64:Qg=="))).rejects.toThrow(/dropped/);
    // close finalises the file with what arrived, and still reports the failure.
    await expect(call(op("close"))).rejects.toThrow(/dropped/);
    const body = readFileSync(join(ws, "flood.txt"), "utf8");
    expect(body).toMatch(/^A+$/);
    // The burst plus whatever refilled while the loop ran, and well short of 1100.
    expect(body.length).toBeGreaterThanOrEqual(1024);
    expect(body.length).toBeLessThan(1100);
  });
});

// ---- device-emu: binding handler --------------------------------------------

describe("device-emu binding handler", () => {
  it.each([
    {
      label: "bluetooth with a staged catalog resolves and records the filters",
      enabled: true,
      catalogs: { bluetooth: [{ name: "x" }] },
      payload: { api: "bluetooth", filters: { acceptAllDevices: true } },
      decision: "resolved",
      names: ["x"],
      records: [{ handledAs: "resolved", returned: 1, filters: { acceptAllDevices: true } }],
    },
    {
      label: "bluetooth with an empty catalog is rejected",
      enabled: true,
      catalogs: {},
      payload: { api: "bluetooth", filters: null },
      decision: "rejected",
      names: [],
      records: [{ handledAs: "rejected" }],
    },
    {
      label: "hid with an empty catalog is empty",
      enabled: true,
      catalogs: {},
      payload: { api: "hid", filters: null },
      decision: "empty",
      names: [],
      records: [{ handledAs: "empty" }],
    },
    {
      label: "hid returns the whole catalog",
      enabled: true,
      catalogs: { hid: [{ name: "one" }, { name: "two" }, { name: "three" }] },
      payload: { api: "hid", filters: null },
      decision: "resolved",
      names: ["one", "two", "three"],
      records: [{ handledAs: "resolved", returned: 3 }],
    },
    {
      label: "usb returns only the first of a multi-device catalog",
      enabled: true,
      catalogs: { usb: [{ name: "one" }, { name: "two" }] },
      payload: { api: "usb", filters: null },
      decision: "resolved",
      names: ["one"],
      records: [{ handledAs: "resolved", returned: 1 }],
    },
    {
      label: "capability off is refused and still recorded; staged devices do not leak",
      enabled: false,
      catalogs: { bluetooth: [{ name: "x" }] },
      payload: { api: "bluetooth", filters: null },
      decision: "refused",
      names: [],
      records: [{ handledAs: "refused", returned: 0 }],
    },
    {
      label: "an unknown api name is refused and not recorded",
      enabled: true,
      catalogs: {},
      payload: { api: "midi", filters: null },
      decision: "refused",
      names: [],
      records: [],
    },
    {
      label: "a payload that is not JSON is swallowed into the refused shape",
      enabled: true,
      catalogs: {},
      payload: "not-json",
      decision: "refused",
      names: [],
      records: [],
    },
  ] as Array<{
    label: string;
    enabled: boolean;
    catalogs: Partial<Record<"bluetooth" | "usb" | "hid", Array<{ name: string }>>>;
    payload: unknown;
    decision: string;
    names: string[];
    records: Array<Record<string, unknown>>;
  }>)("$label", async ({ enabled, catalogs, payload, decision, names, records }) => {
    const s = new DeviceEmulationState(enabled);
    for (const [api, devices] of Object.entries(catalogs)) {
      s.set(api as "bluetooth" | "usb" | "hid", devices);
    }
    const bindings = new Map<string, Binding>();
    await attachDeviceEmulation(fakeContext({ bindings }), s);
    const handler = bindings.get("__browx_device_check")!;
    const raw = await handler(
      null,
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
    const r = JSON.parse(raw as string) as { decision: string; devices: Array<{ name: string }> };
    expect(r.decision).toBe(decision);
    expect(r.devices.map((d) => d.name)).toEqual(names);
    const recorded = s.since(0);
    expect(recorded).toHaveLength(records.length);
    records.forEach((rec, i) => expect(recorded[i]).toMatchObject(rec));
  });

  it("reinjectDeviceEmuOnPage calls page.evaluate", async () => {
    const page = fakePage();
    await reinjectDeviceEmuOnPage(page);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});

// ---- install plumbing shared by all four modules ----------------------------

describe("attach install plumbing", () => {
  // Each row builds its own state once per test: the install guard lives on the
  // state, so the same state must serve every attach call on one context.
  const INSTALLERS: Array<{
    label: string;
    makeAttach: () => (ctx: BrowserContext) => Promise<void>;
    script: string;
    scriptsPerAttach: number;
  }> = [
    {
      label: "permission",
      makeAttach: () => {
        const state = new PermissionPolicyState();
        return (ctx) => attachPermissionPolicy(ctx, state, async () => "deny");
      },
      script: PERMISSION_PAGE_SCRIPT,
      scriptsPerAttach: 1,
    },
    {
      label: "notification (page script plus the sync-decision seed)",
      makeAttach: () => {
        const state = new NotificationPolicyState();
        return (ctx) => attachNotificationPolicy(ctx, state, async () => "deny");
      },
      script: NOTIFICATION_PAGE_SCRIPT,
      scriptsPerAttach: 2,
    },
    {
      label: "fs-picker",
      makeAttach: () => {
        const state = new FsPickerPolicyState();
        return (ctx) => attachFsPickerPolicy(ctx, state, tmpdir(), async () => null);
      },
      script: FS_PICKER_PAGE_SCRIPT,
      scriptsPerAttach: 1,
    },
    {
      label: "device-emu",
      makeAttach: () => {
        const state = new DeviceEmulationState(true);
        return (ctx) => attachDeviceEmulation(ctx, state);
      },
      script: DEVICE_EMU_PAGE_SCRIPT,
      scriptsPerAttach: 1,
    },
  ];

  it.each(INSTALLERS)(
    "$label: attach is idempotent on the same context",
    async ({ makeAttach, scriptsPerAttach }) => {
      const attach = makeAttach();
      const initScripts: string[] = [];
      const ctx = fakeContext({ initScripts });
      await attach(ctx);
      await attach(ctx);
      await attach(ctx);
      expect(initScripts.length).toBe(scriptsPerAttach);
    },
  );

  it.each(INSTALLERS)(
    "$label: the init script is evaluated on every already-attached page",
    async ({ makeAttach, script }) => {
      const p1 = fakePage();
      const p2 = fakePage();
      await makeAttach()(fakeContext({ pages: [p1, p2] }));
      expect(p1.evaluate).toHaveBeenCalledWith(script);
      expect(p2.evaluate).toHaveBeenCalledWith(script);
    },
  );
});
