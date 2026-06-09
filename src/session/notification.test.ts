import { describe, it, expect, vi } from "vitest";
import {
  NotificationPolicyState,
  attachNotificationPolicy,
  parseNotificationPolicyArg,
  propagateSyncDecision,
  syncDecisionFor,
  UNHANDLED_NOTIFICATION_HINT,
  NOTIFICATION_PAGE_SCRIPT,
  type NotificationAskHandler,
} from "./notification.js";
import type { BrowserContext, Page } from "playwright-core";

// ---- fakes ----------------------------------------------------------------

function fakePage(): Page {
  return {
    url: () => "https://example.com/x",
    evaluate: vi.fn(async () => undefined),
  } as unknown as Page;
}

function fakeContext(
  opts: {
    bindings?: Map<string, (source: unknown, payload: string) => unknown>;
    initScripts?: string[];
    pages?: Page[];
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
  } as unknown as BrowserContext;
}

// ---- parseNotificationPolicyArg ------------------------------------------

describe("parseNotificationPolicyArg", () => {
  it("defaults to allow when undefined", () => {
    expect(parseNotificationPolicyArg(undefined)).toEqual({ mode: "allow" });
  });
  it("parses each simple string mode", () => {
    for (const m of ["allow", "deny", "raise", "ask-human"] as const) {
      expect(parseNotificationPolicyArg(m)).toEqual({ mode: m });
    }
  });
  it("accepts object form", () => {
    expect(parseNotificationPolicyArg({ mode: "deny" })).toEqual({ mode: "deny" });
  });
  it("rejects unknown modes", () => {
    expect(() => parseNotificationPolicyArg("yes")).toThrow(/invalid/i);
    expect(() => parseNotificationPolicyArg({ mode: "yes" as never })).toThrow(/invalid/i);
  });
});

// ---- NotificationPolicyState basics --------------------------------------

describe("NotificationPolicyState", () => {
  it("defaults to allow", () => {
    const s = new NotificationPolicyState();
    expect(s.current()).toEqual({ mode: "allow" });
  });

  it("set() flips the policy for the NEXT call; prior records unchanged", () => {
    const s = new NotificationPolicyState({ mode: "allow" });
    const t0 = Date.now();
    s.record({ title: "first", timestamp: t0, handledAs: "allowed" });
    s.set({ mode: "deny" });
    expect(s.current().mode).toBe("deny");
    expect(s.since(t0)).toHaveLength(1);
    expect(s.since(t0)[0]?.handledAs).toBe("allowed");
  });

  it("buffer is capped — oldest record evicted past cap", () => {
    const s = new NotificationPolicyState({ mode: "allow" }, 3);
    const t = Date.now();
    for (let i = 0; i < 5; i++) {
      s.record({ title: `t${i}`, timestamp: t + i, handledAs: "allowed" });
    }
    const slice = s.since(0);
    expect(slice).toHaveLength(3);
    expect(slice.map((r) => r.title)).toEqual(["t2", "t3", "t4"]);
  });

  it("raisedSince() — true iff a raised record sits in the window", () => {
    const s = new NotificationPolicyState();
    const t = Date.now();
    s.record({ title: "ok", timestamp: t, handledAs: "allowed" });
    expect(s.raisedSince(t)).toBe(false);
    s.record({ title: "bad", timestamp: t + 1, handledAs: "raised" });
    expect(s.raisedSince(t)).toBe(true);
  });

  it("normalise rejects unknown modes at construction", () => {
    expect(() => new NotificationPolicyState({ mode: "yes" as never })).toThrow(/invalid mode/i);
  });
});

// ---- exposed constants / mapping -----------------------------------------

describe("syncDecisionFor", () => {
  it("maps allow / ask-human → allow (no sync throw)", () => {
    expect(syncDecisionFor("allow")).toBe("allow");
    expect(syncDecisionFor("ask-human")).toBe("allow");
  });
  it("maps deny / raise to themselves (sync throw)", () => {
    expect(syncDecisionFor("deny")).toBe("deny");
    expect(syncDecisionFor("raise")).toBe("raise");
  });
});

describe("UNHANDLED_NOTIFICATION_HINT", () => {
  it("mentions both set knobs", () => {
    expect(UNHANDLED_NOTIFICATION_HINT).toMatch(/open_session/);
    expect(UNHANDLED_NOTIFICATION_HINT).toMatch(/set_notification_policy/);
    expect(UNHANDLED_NOTIFICATION_HINT).toMatch(/rejected page-side/);
  });
});

// ---- exposeBinding handler per-mode behaviour ----------------------------

describe("attachNotificationPolicy — binding handler per mode", () => {
  async function setupCheck(
    policy: ConstructorParameters<typeof NotificationPolicyState>[0],
    ask?: NotificationAskHandler,
  ) {
    const state = new NotificationPolicyState(policy);
    const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
    const initScripts: string[] = [];
    const ctx = fakeContext({ bindings, initScripts });
    await attachNotificationPolicy(ctx, state, ask ?? (async () => "deny"));
    const check = bindings.get("__browx_notification_check");
    if (!check) throw new Error("__browx_notification_check not installed");
    return { state, check, initScripts };
  }

  it('allow → returns allow, records handledAs:"allowed"', async () => {
    const { state, check } = await setupCheck({ mode: "allow" });
    const t = Date.now();
    const decision = await check(
      {},
      JSON.stringify({ title: "T", body: "B", icon: "i.png", tag: "tag1", origin: "https://app" }),
    );
    expect(decision).toBe("allow");
    const rec = state.since(t)[0];
    expect(rec?.title).toBe("T");
    expect(rec?.body).toBe("B");
    expect(rec?.icon).toBe("i.png");
    expect(rec?.tag).toBe("tag1");
    expect(rec?.origin).toBe("https://app");
    expect(rec?.handledAs).toBe("allowed");
  });

  it('deny → returns deny, records handledAs:"denied"', async () => {
    const { state, check } = await setupCheck({ mode: "deny" });
    const t = Date.now();
    expect(await check({}, JSON.stringify({ title: "X" }))).toBe("deny");
    expect(state.since(t)[0]?.handledAs).toBe("denied");
  });

  it('raise → returns deny, records handledAs:"raised", flips raisedSince()', async () => {
    const { state, check } = await setupCheck({ mode: "raise" });
    const t = Date.now();
    expect(await check({}, JSON.stringify({ title: "X" }))).toBe("deny");
    expect(state.since(t)[0]?.handledAs).toBe("raised");
    expect(state.raisedSince(t)).toBe(true);
  });

  it("ask-human → defers to handler; 'allow' → returns allow, handledAs:\"asked-human\"", async () => {
    const asks: Array<{ title: string; origin?: string }> = [];
    const ask: NotificationAskHandler = async (n) => {
      const entry: { title: string; origin?: string } = { title: n.title };
      if (n.origin !== undefined) entry.origin = n.origin;
      asks.push(entry);
      return "allow";
    };
    const { state, check } = await setupCheck({ mode: "ask-human" }, ask);
    const t = Date.now();
    expect(await check({}, JSON.stringify({ title: "Ask", origin: "https://a" }))).toBe("allow");
    expect(asks).toEqual([{ title: "Ask", origin: "https://a" }]);
    expect(state.since(t)[0]?.handledAs).toBe("asked-human");
  });

  it("ask-human → handler 'deny' → returns deny", async () => {
    const { check } = await setupCheck({ mode: "ask-human" }, async () => "deny");
    expect(await check({}, JSON.stringify({ title: "X" }))).toBe("deny");
  });

  it("ask-human → handler throws → safe-by-default deny", async () => {
    const { check } = await setupCheck({ mode: "ask-human" }, async () => {
      throw new Error("boom");
    });
    expect(await check({}, JSON.stringify({ title: "X" }))).toBe("deny");
  });

  it("runtime set() takes effect on the very next check", async () => {
    const { state, check } = await setupCheck({ mode: "allow" });
    expect(await check({}, JSON.stringify({ title: "X" }))).toBe("allow");
    state.set({ mode: "deny" });
    expect(await check({}, JSON.stringify({ title: "X" }))).toBe("deny");
  });

  it("omitted body/icon/tag are not recorded as keys", async () => {
    const { state, check } = await setupCheck({ mode: "allow" });
    const t = Date.now();
    await check({}, JSON.stringify({ title: "bare" }));
    const rec = state.since(t)[0]!;
    expect(rec.title).toBe("bare");
    expect(rec.body).toBeUndefined();
    expect(rec.icon).toBeUndefined();
    expect(rec.tag).toBeUndefined();
  });
});

// ---- attach install plumbing ---------------------------------------------

describe("attachNotificationPolicy — install plumbing", () => {
  it("installs the check binding + the page script + a sync-decision seed", async () => {
    const state = new NotificationPolicyState();
    const bindings = new Map();
    const initScripts: string[] = [];
    const ctx = fakeContext({ bindings, initScripts });
    await attachNotificationPolicy(ctx, state, async () => "deny");
    expect(bindings.has("__browx_notification_check")).toBe(true);
    // two init scripts: the wrapper, then the sync-decision seed
    expect(initScripts.length).toBe(2);
    expect(initScripts[0]).toBe(NOTIFICATION_PAGE_SCRIPT);
    expect(initScripts[1]).toMatch(/__browx_notification_sync_decision/);
  });

  it("idempotent on the same context — second call is a no-op", async () => {
    const state = new NotificationPolicyState();
    const bindings = new Map();
    const initScripts: string[] = [];
    const ctx = fakeContext({ bindings, initScripts });
    await attachNotificationPolicy(ctx, state, async () => "deny");
    await attachNotificationPolicy(ctx, state, async () => "deny");
    expect(initScripts.length).toBe(2);
  });

  it("evaluates init scripts on every already-attached page", async () => {
    const state = new NotificationPolicyState();
    const p1 = fakePage();
    const p2 = fakePage();
    const ctx = fakeContext({ pages: [p1, p2] });
    await attachNotificationPolicy(ctx, state, async () => "deny");
    expect(p1.evaluate).toHaveBeenCalledWith(NOTIFICATION_PAGE_SCRIPT);
    expect(p2.evaluate).toHaveBeenCalledWith(NOTIFICATION_PAGE_SCRIPT);
  });
});

// ---- propagateSyncDecision -----------------------------------------------

describe("propagateSyncDecision", () => {
  it("re-seeds the sync hint on every live page + adds a new init script", async () => {
    const state = new NotificationPolicyState({ mode: "allow" });
    const p = fakePage();
    const initScripts: string[] = [];
    const ctx = fakeContext({ pages: [p], initScripts });
    state.set({ mode: "raise" });
    await propagateSyncDecision(ctx, state);
    expect(p.evaluate).toHaveBeenCalled();
    const lastInit = initScripts[initScripts.length - 1]!;
    expect(lastInit).toMatch(/"raise"/);
  });
});

// ---- the init script is browser-only JS ----------------------------------

describe("NOTIFICATION_PAGE_SCRIPT", () => {
  it("contains the install guard so re-injection is a no-op", () => {
    expect(NOTIFICATION_PAGE_SCRIPT).toMatch(/__browx_notification_installed/);
  });

  it("wraps the constructor", () => {
    expect(NOTIFICATION_PAGE_SCRIPT).toMatch(/window\.Notification = ProxyNotification/);
  });

  it("preserves the static permission / requestPermission surface for permission_policy", () => {
    expect(NOTIFICATION_PAGE_SCRIPT).toMatch(/ProxyNotification\.requestPermission/);
    expect(NOTIFICATION_PAGE_SCRIPT).toMatch(/OrigNotification\.requestPermission/);
    expect(NOTIFICATION_PAGE_SCRIPT).toMatch(/return OrigNotification\.permission/);
  });

  it("consults the check binding and falls back to allow when missing", () => {
    expect(NOTIFICATION_PAGE_SCRIPT).toMatch(/__browx_notification_check/);
    expect(NOTIFICATION_PAGE_SCRIPT).toMatch(/return Promise\.resolve\("allow"\)/);
  });

  it("reads the synchronous decision hint to throw at construction time", () => {
    expect(NOTIFICATION_PAGE_SCRIPT).toMatch(/__browx_notification_sync_decision/);
  });

  it("does NOT touch Notification.permission's getter on Notification itself (permission_policy owns it)", () => {
    // The script must NOT override Notification.permission via
    // Object.defineProperty(OrigNotification, "permission", …) — only forward
    // it on the proxy. (permission_policy installs its own getter override.)
    expect(NOTIFICATION_PAGE_SCRIPT).not.toMatch(/defineProperty\(OrigNotification, ?"permission"/);
  });
});
