import { describe, it, expect, vi } from "vitest";
import {
  PermissionPolicyState,
  attachPermissionPolicy,
  applyCdpBaseline,
  parsePermissionPolicyArg,
  cdpPermissionName,
  cdpSettingFor,
  SUPPORTED_PERMISSIONS,
  UNHANDLED_PERMISSION_HINT,
  PERMISSION_PAGE_SCRIPT,
  type PermissionAskHandler,
} from "./permission.js";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

// ---- fakes ----------------------------------------------------------------

function fakePage(): Page {
  return {
    url: () => "https://example.com/x",
    evaluate: vi.fn(async () => undefined),
  } as unknown as Page;
}

function fakeContext(
  opts: {
    cdp?: CDPSession;
    bindings?: Map<string, (source: unknown, payload: string) => unknown>;
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
    exposeBinding: async (name: string, fn: (source: unknown, payload: string) => unknown) => {
      bindings.set(name, fn);
    },
    addInitScript: async (script: { content: string }) => {
      initScripts.push(script.content);
    },
    pages: () => pages,
    newCDPSession: async () => opts.cdp ?? fakeCdp(),
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

function fakeCdp(
  opts: {
    setPermission?: (params: unknown) => unknown;
    getPermissionState?: (params: unknown) => unknown;
  } = {},
): CDPSession {
  return {
    send: vi.fn(async (method: string, params?: unknown) => {
      if (method === "Browser.setPermission" && opts.setPermission)
        return opts.setPermission(params);
      if (method === "Browser.getPermissionState" && opts.getPermissionState)
        return opts.getPermissionState(params);
      return undefined;
    }),
    detach: vi.fn(async () => undefined),
  } as unknown as CDPSession;
}

// ---- parsePermissionPolicyArg --------------------------------------------

describe("parsePermissionPolicyArg", () => {
  it("defaults to raise when undefined", () => {
    expect(parsePermissionPolicyArg(undefined)).toEqual({ mode: "raise" });
  });
  it("parses each simple string mode", () => {
    for (const m of ["allow", "deny", "raise", "ask-human"] as const) {
      expect(parsePermissionPolicyArg(m)).toEqual({ mode: m });
    }
  });
  it("accepts object form with perPermission overrides", () => {
    expect(
      parsePermissionPolicyArg({
        mode: "raise",
        perPermission: { camera: "allow", notifications: "deny" },
      }),
    ).toEqual({ mode: "raise", perPermission: { camera: "allow", notifications: "deny" } });
  });
  it("rejects unknown top-level modes", () => {
    expect(() => parsePermissionPolicyArg("yes")).toThrow(/invalid/i);
  });
  it("rejects unknown per-permission keys", () => {
    expect(() =>
      parsePermissionPolicyArg({ mode: "raise", perPermission: { usb: "allow" } as never }),
    ).toThrow(/unknown permission "usb"/);
  });
  it("rejects unknown per-permission modes", () => {
    expect(() =>
      parsePermissionPolicyArg({ mode: "raise", perPermission: { camera: "yes" as never } }),
    ).toThrow(/invalid mode/);
  });
});

// ---- PermissionPolicyState basics + mode resolution ----------------------

describe("PermissionPolicyState", () => {
  it("defaults to raise", () => {
    const s = new PermissionPolicyState();
    expect(s.current()).toEqual({ mode: "raise" });
    expect(s.modeFor("camera")).toBe("raise");
  });

  it("modeFor falls back to top-level when no per-permission override", () => {
    const s = new PermissionPolicyState({ mode: "allow" });
    expect(s.modeFor("microphone")).toBe("allow");
  });

  it("modeFor honours per-permission override over top-level", () => {
    const s = new PermissionPolicyState({
      mode: "allow",
      perPermission: { notifications: "deny", camera: "ask-human" },
    });
    expect(s.modeFor("notifications")).toBe("deny");
    expect(s.modeFor("camera")).toBe("ask-human");
    expect(s.modeFor("microphone")).toBe("allow"); // falls back
  });

  it("set() flips policy for the NEXT request; prior records unchanged", () => {
    const s = new PermissionPolicyState({ mode: "allow" });
    const t0 = Date.now();
    s.record({ permission: "camera", origin: "https://x", handledAs: "allowed", ts: t0 });
    s.set({ mode: "deny" });
    expect(s.current().mode).toBe("deny");
    expect(s.since(t0)).toHaveLength(1);
    expect(s.since(t0)[0]?.handledAs).toBe("allowed");
  });

  it("buffer is capped — oldest record evicted past cap", () => {
    const s = new PermissionPolicyState({ mode: "allow" }, 3);
    const t = Date.now();
    for (let i = 0; i < 5; i++) {
      s.record({ permission: "camera", origin: `o${i}`, handledAs: "allowed", ts: t + i });
    }
    const slice = s.since(0);
    expect(slice).toHaveLength(3);
    expect(slice.map((r) => r.origin)).toEqual(["o2", "o3", "o4"]);
  });

  it("raisedSince() — true iff a raised record sits in the window", () => {
    const s = new PermissionPolicyState();
    const t = Date.now();
    s.record({ permission: "camera", handledAs: "allowed", ts: t });
    expect(s.raisedSince(t)).toBe(false);
    s.record({ permission: "geolocation", handledAs: "raised", ts: t + 1 });
    expect(s.raisedSince(t)).toBe(true);
  });
});

// ---- exposed constants / mapping -----------------------------------------

describe("CDP mapping", () => {
  it("every supported permission has a CDP name", () => {
    for (const name of SUPPORTED_PERMISSIONS) {
      expect(typeof cdpPermissionName(name)).toBe("string");
      expect(cdpPermissionName(name).length).toBeGreaterThan(0);
    }
  });

  it("cdpSettingFor maps each policy mode deterministically", () => {
    expect(cdpSettingFor("allow")).toBe("granted");
    expect(cdpSettingFor("deny")).toBe("denied");
    expect(cdpSettingFor("raise")).toBe("denied");
    expect(cdpSettingFor("ask-human")).toBe("prompt");
  });

  it("UNHANDLED_PERMISSION_HINT mentions both set knobs", () => {
    expect(UNHANDLED_PERMISSION_HINT).toMatch(/open_session/);
    expect(UNHANDLED_PERMISSION_HINT).toMatch(/set_permission_policy/);
    expect(UNHANDLED_PERMISSION_HINT).toMatch(/rejected page-side/);
  });
});

// ---- exposeBinding handler per-mode behaviour ----------------------------

describe("attachPermissionPolicy — binding handler per mode", () => {
  async function setupCheck(
    policy: ConstructorParameters<typeof PermissionPolicyState>[0],
    ask?: PermissionAskHandler,
  ) {
    const state = new PermissionPolicyState(policy);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const initScripts: string[] = [];
    const ctx = fakeContext({ bindings, initScripts });
    await attachPermissionPolicy(ctx, state, ask ?? (async () => "deny"));
    const check = bindings.get("__browx_permission_check");
    if (!check) throw new Error("__browx_permission_check not installed");
    return { state, check, initScripts };
  }

  it('allow → returns allow, records handledAs:"allowed"', async () => {
    const { state, check } = await setupCheck({ mode: "allow" });
    const t = Date.now();
    const decision = await check(
      {},
      JSON.stringify({ permission: "camera", origin: "https://app" }),
    );
    expect(decision).toBe("allow");
    const rec = state.since(t)[0];
    expect(rec?.permission).toBe("camera");
    expect(rec?.handledAs).toBe("allowed");
    expect(rec?.origin).toBe("https://app");
  });

  it('deny → returns deny, records handledAs:"denied"', async () => {
    const { state, check } = await setupCheck({ mode: "deny" });
    const t = Date.now();
    expect(await check({}, JSON.stringify({ permission: "microphone" }))).toBe("deny");
    expect(state.since(t)[0]?.handledAs).toBe("denied");
  });

  it('raise → returns deny, records handledAs:"raised", flips raisedSince()', async () => {
    const { state, check } = await setupCheck({ mode: "raise" });
    const t = Date.now();
    expect(await check({}, JSON.stringify({ permission: "geolocation" }))).toBe("deny");
    expect(state.since(t)[0]?.handledAs).toBe("raised");
    expect(state.raisedSince(t)).toBe(true);
  });

  it("ask-human → defers to handler; handler 'allow' → returns allow, handledAs:\"asked-human\"", async () => {
    const askResults: Array<{ p: string; o?: string }> = [];
    const ask: PermissionAskHandler = async (p, o) => {
      askResults.push({ p, ...(o !== undefined ? { o } : {}) });
      return "allow";
    };
    const { state, check } = await setupCheck({ mode: "ask-human" }, ask);
    const t = Date.now();
    expect(
      await check({}, JSON.stringify({ permission: "notifications", origin: "https://n" })),
    ).toBe("allow");
    expect(askResults).toEqual([{ p: "notifications", o: "https://n" }]);
    expect(state.since(t)[0]?.handledAs).toBe("asked-human");
  });

  it("ask-human → handler 'deny' → returns deny", async () => {
    const { check } = await setupCheck({ mode: "ask-human" }, async () => "deny");
    expect(await check({}, JSON.stringify({ permission: "camera" }))).toBe("deny");
  });

  it("ask-human → handler throws → safe-by-default deny", async () => {
    const { check } = await setupCheck({ mode: "ask-human" }, async () => {
      throw new Error("boom");
    });
    expect(await check({}, JSON.stringify({ permission: "camera" }))).toBe("deny");
  });

  it("per-permission override wins over top-level for SAME request", async () => {
    const { check } = await setupCheck({ mode: "allow", perPermission: { camera: "deny" } });
    expect(await check({}, JSON.stringify({ permission: "camera" }))).toBe("deny");
    expect(await check({}, JSON.stringify({ permission: "microphone" }))).toBe("allow");
  });

  it("unknown permission name → safe-by-default allow (out-of-v1 names fall through)", async () => {
    const { check } = await setupCheck({ mode: "raise" });
    expect(await check({}, JSON.stringify({ permission: "usb" }))).toBe("allow");
  });

  it("runtime set() takes effect on the very next check", async () => {
    const { state, check } = await setupCheck({ mode: "allow" });
    expect(await check({}, JSON.stringify({ permission: "camera" }))).toBe("allow");
    state.set({ mode: "deny" });
    expect(await check({}, JSON.stringify({ permission: "camera" }))).toBe("deny");
  });

  it("each supported permission can have its own mode (all 4 modes for all 12 names)", async () => {
    // Cover the matrix: every supported permission × every mode behaves as expected.
    for (const perm of SUPPORTED_PERMISSIONS) {
      for (const mode of ["allow", "deny", "raise"] as const) {
        const { check, state } = await setupCheck({ mode });
        const t = Date.now();
        const decision = await check({}, JSON.stringify({ permission: perm }));
        expect(decision, `${perm} under ${mode}`).toBe(mode === "allow" ? "allow" : "deny");
        const rec = state.since(t).at(-1);
        expect(rec?.handledAs).toBe(
          mode === "allow" ? "allowed" : mode === "deny" ? "denied" : "raised",
        );
      }
      const { check, state } = await setupCheck({ mode: "ask-human" }, async () => "allow");
      const t = Date.now();
      expect(await check({}, JSON.stringify({ permission: perm }))).toBe("allow");
      expect(state.since(t).at(-1)?.handledAs).toBe("asked-human");
    }
  });
});

// ---- attach idempotency + init-script wiring -----------------------------

describe("attachPermissionPolicy — install plumbing", () => {
  it("installs both bindings + the init script", async () => {
    const state = new PermissionPolicyState();
    const bindings = new Map();
    const initScripts: string[] = [];
    const ctx = fakeContext({ bindings, initScripts });
    await attachPermissionPolicy(ctx, state, async () => "deny");
    expect(bindings.has("__browx_permission_check")).toBe(true);
    expect(bindings.has("__browx_permission_observe")).toBe(true);
    expect(initScripts.length).toBe(1);
    expect(initScripts[0]).toBe(PERMISSION_PAGE_SCRIPT);
  });

  it("idempotent on the same context — second call is a no-op", async () => {
    const state = new PermissionPolicyState();
    const bindings = new Map();
    const initScripts: string[] = [];
    const ctx = fakeContext({ bindings, initScripts });
    await attachPermissionPolicy(ctx, state, async () => "deny");
    await attachPermissionPolicy(ctx, state, async () => "deny");
    await attachPermissionPolicy(ctx, state, async () => "deny");
    expect(initScripts.length).toBe(1);
  });

  it("evaluates the init script on every already-attached page", async () => {
    const state = new PermissionPolicyState();
    const p1 = fakePage();
    const p2 = fakePage();
    const ctx = fakeContext({ pages: [p1, p2] });
    await attachPermissionPolicy(ctx, state, async () => "deny");
    expect(p1.evaluate).toHaveBeenCalledWith(PERMISSION_PAGE_SCRIPT);
    expect(p2.evaluate).toHaveBeenCalledWith(PERMISSION_PAGE_SCRIPT);
  });
});

// ---- CDP baseline --------------------------------------------------------

describe("applyCdpBaseline", () => {
  it("clears then grants exactly the permissions in `allow` mode", async () => {
    const grantCalls: Array<{ permissions: string[] }> = [];
    const clearCalls = { count: 0 };
    const ctx = fakeContext({ grantCalls, clearCalls });
    const state = new PermissionPolicyState({
      mode: "allow",
      perPermission: { camera: "deny", notifications: "ask-human", microphone: "raise" },
    });
    await applyCdpBaseline(ctx, state);
    expect(clearCalls.count).toBe(1);
    expect(grantCalls.length).toBe(1);
    const granted = grantCalls[0]!.permissions;
    // microphone (raise), camera (deny), notifications (ask-human) excluded;
    // every other supported name (top-level "allow") included.
    expect(granted).not.toContain("camera");
    expect(granted).not.toContain("microphone");
    expect(granted).not.toContain("notifications");
    expect(granted).toContain("geolocation");
    expect(granted).toContain("clipboard-read");
  });

  it("clears only when the policy grants nothing (no grant call)", async () => {
    const grantCalls: Array<{ permissions: string[] }> = [];
    const clearCalls = { count: 0 };
    const ctx = fakeContext({ grantCalls, clearCalls });
    const state = new PermissionPolicyState({ mode: "raise" });
    await applyCdpBaseline(ctx, state);
    expect(clearCalls.count).toBe(1);
    expect(grantCalls.length).toBe(0);
  });

  it("swallows clear / grant errors without throwing", async () => {
    const ctx = fakeContext({ grantThrows: true, clearThrows: true });
    const state = new PermissionPolicyState({ mode: "allow" });
    await expect(applyCdpBaseline(ctx, state)).resolves.toBeUndefined();
  });
});

// ---- the init script is browser-only JS ----------------------------------

describe("PERMISSION_PAGE_SCRIPT", () => {
  it("contains the install guard so re-injection is a no-op", () => {
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/__browx_permission_installed/);
  });

  it("wraps every API the policy governs", () => {
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/navigator\.mediaDevices/);
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/getCurrentPosition/);
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/watchPosition/);
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/Notification\.requestPermission/);
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/clipboard/);
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/permissions\.query/);
  });

  it("consults the check binding and falls back to allow when missing (BYOB clobber safety)", () => {
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/__browx_permission_check/);
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/return Promise\.resolve\("allow"\)/);
  });

  it("clearWatch proxies the synthetic id back to the native id", () => {
    expect(PERMISSION_PAGE_SCRIPT).toMatch(/__browx_watch_map/);
  });
});
