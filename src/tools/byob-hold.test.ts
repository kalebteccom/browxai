// The attached-session hold: which tools it covers, and the order the `register`
// wrapper runs it in. The wrapper cases go through the real `buildHost` with
// stub dependencies, so no browser.

import { describe, it, expect } from "vitest";
import "./tool-metadata.js";
import { buildHost, type HostDeps } from "./host-build.js";
import {
  BYOB_HOLD_CAPABILITIES,
  holdAttached,
  shouldHold,
  type ByobHoldDeps,
} from "./byob-hold.js";
import type { ToolResponse } from "./host.js";
import type { SessionEntry } from "../session/registry.js";
import { ApprovalStore, type ConfirmContext } from "../policy/confirm.js";
import type { Capability, ConfirmHook } from "../util/capabilities.js";

type Handler = (args: unknown) => Promise<ToolResponse>;

const OK: ToolResponse = { content: [{ type: "text", text: '{"ok":true}' }] };
const bodyOf = (r: ToolResponse): Record<string, unknown> =>
  JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

describe("shouldHold", () => {
  it("holds the capabilities that change the browser", () => {
    expect([...BYOB_HOLD_CAPABILITIES].sort()).toEqual([
      "action",
      "canvas",
      "clipboard",
      "device-emulation",
      "eval",
      "extensions",
      "file-io",
      "navigation",
    ]);
    for (const cap of BYOB_HOLD_CAPABILITIES) expect(shouldHold(cap, {})).toBe(true);
  });

  it("does not hold a read tool, a human tool or a tool with no capability", () => {
    expect(shouldHold("read", {})).toBe(false);
    expect(shouldHold("human", {})).toBe(false);
    expect(shouldHold("self-approval", {})).toBe(false);
    expect(shouldHold(undefined, {})).toBe(false);
  });

  it("lets a registration opt out and opt in", () => {
    expect(shouldHold("action", { byobConfirm: false })).toBe(false);
    expect(shouldHold("read", { byobConfirm: true })).toBe(true);
    expect(shouldHold(undefined, { byobConfirm: true })).toBe(true);
  });
});

/** A bridge whose human answers at once, counting how often it was asked. */
function bridgeAnswering(value: boolean) {
  const asked: string[] = [];
  return {
    asked,
    bridge: {
      humanChannelAvailable: () => true,
      newTicket: () => "t1",
      answerHint: (s: string) => s,
      awaitSignal: async (_k: string, _ms: number, _t: string, prompt: { tool: string }) => {
        asked.push(prompt.tool);
        return { data: { value } };
      },
    },
  };
}

describe("holdAttached", () => {
  const deps = (over: Partial<ByobHoldDeps>, ctx: Partial<ConfirmContext>): ByobHoldDeps => ({
    armed: true,
    entryFor: async (id) => ({ id: id ?? "default" }) as unknown as SessionEntry,
    engineGate: () => null,
    confirmCtxFor: () => ({
      hooks: new Set<ConfirmHook>(["byob_action"]),
      policy: { allowed: [], blocked: [] },
      bridge: null,
      isByob: true,
      ...ctx,
    }),
    denyContent: (tool, d) => ({
      content: [{ type: "text", text: JSON.stringify({ tool, error: `policy: ${d.reason}` }) }],
    }),
    ...over,
  });

  it("resolves no session when it is not armed", async () => {
    let resolved = 0;
    const r = await holdAttached(
      "click",
      {},
      deps({ armed: false, entryFor: async () => (resolved++, {} as SessionEntry) }, {}),
    );
    expect(r).toBeNull();
    expect(resolved).toBe(0);
  });

  it("resolves the session the call names, and the default one otherwise", async () => {
    const seen: Array<string | undefined> = [];
    const d = deps(
      { entryFor: async (id) => (seen.push(id), { id } as unknown as SessionEntry) },
      { isByob: false },
    );
    await holdAttached("click", { session: "s2" }, d);
    await holdAttached("click", {}, d);
    await holdAttached("click", { session: 7 }, d);
    expect(seen).toEqual(["s2", undefined, undefined]);
  });

  it("lets a session that is not attached through without asking", async () => {
    const { asked, bridge } = bridgeAnswering(false);
    const r = await holdAttached("click", {}, deps({}, { isByob: false, bridge: bridge as never }));
    expect(r).toBeNull();
    expect(asked).toEqual([]);
  });

  it("returns the policy refusal when the human declines", async () => {
    const { asked, bridge } = bridgeAnswering(false);
    const r = await holdAttached("drag", {}, deps({}, { bridge: bridge as never }));
    expect(asked).toEqual(["drag"]);
    expect(bodyOf(r!)).toEqual({ tool: "drag", error: "policy: human-declined" });
  });

  it("returns the engine refusal first and never asks", async () => {
    const { asked, bridge } = bridgeAnswering(true);
    const refusal: ToolResponse = { content: [{ type: "text", text: '{"engine":"x"}' }] };
    const r = await holdAttached(
      "navigate",
      {},
      deps({ engineGate: () => refusal }, { bridge: bridge as never }),
    );
    expect(r).toBe(refusal);
    expect(asked).toEqual([]);
  });

  it("returns the tool's precheck refusal before asking", async () => {
    const { asked, bridge } = bridgeAnswering(true);
    const refusal: ToolResponse = { content: [{ type: "text", text: '{"scheme":"chrome"}' }] };
    const seen: string[] = [];
    const r = await holdAttached(
      "navigate",
      { session: "s1" },
      deps({}, { bridge: bridge as never }),
      (e) => (seen.push(e.id), refusal),
    );
    expect(r).toBe(refusal);
    expect(seen).toEqual(["s1"]);
    expect(asked).toEqual([]);
  });

  it("asks when the precheck passes", async () => {
    const { asked, bridge } = bridgeAnswering(true);
    const r = await holdAttached("navigate", {}, deps({}, { bridge: bridge as never }), () => null);
    expect(r).toBeNull();
    expect(asked).toEqual(["navigate"]);
  });

  it("runs no precheck for a session that is not attached", async () => {
    let ran = 0;
    const r = await holdAttached("navigate", {}, deps({}, { isByob: false }), () => {
      ran++;
      return null;
    });
    expect(r).toBeNull();
    expect(ran).toBe(0);
  });

  it("uses a pre-approval without asking, and counts one use", async () => {
    const approvals = new ApprovalStore();
    approvals.grant("byob_action", 60);
    const { asked, bridge } = bridgeAnswering(false);
    const r = await holdAttached("click", {}, deps({}, { approvals, bridge: bridge as never }));
    expect(r).toBeNull();
    expect(asked).toEqual([]);
    expect(approvals.list().map((g) => g.uses)).toEqual([1]);
  });

  it("fails closed with no human channel", async () => {
    const r = await holdAttached("click", {}, deps({}, { bridge: null }));
    expect(String(bodyOf(r!).error)).toMatch(/^policy: byob: this session has no human channel/);
  });
});

/** A real host over one stub session, with a log of what ran. */
function hostOver(opts: {
  mode: SessionEntry["mode"];
  caps: Capability[];
  hooks?: ConfirmHook[];
  engine?: string;
  answer?: boolean;
  approvals?: ApprovalStore;
}) {
  const ran: string[] = [];
  const toolHandlers: Record<string, Handler> = {};
  const { asked, bridge } = bridgeAnswering(opts.answer ?? false);
  let resolved = 0;
  const entry = {
    id: "s1",
    mode: opts.mode,
    bridge,
    session: { engine: opts.engine ?? "chromium" },
  };
  const host = buildHost({
    server: { registerTool: () => undefined },
    toolHandlers,
    registry: {
      list: () => [],
      peek: () => undefined,
      get: async () => (resolved++, entry),
    },
    config: { testAttributes: [] },
    caps: { enabled: new Set(opts.caps) },
    confirmHooks: new Set(opts.hooks ?? ["byob_action"]),
    originPolicy: { allowed: [], blocked: [] },
    approvals: opts.approvals ?? new ApprovalStore(),
    diagnostics: { enabled: false },
    pluginRecords: () => [],
  } as unknown as HostDeps);
  const add = (
    name: string,
    def: { capability?: Capability; deep?: boolean; byobConfirm?: boolean },
  ): void =>
    host.register(name, { description: "hold probe", ...def }, async () => {
      ran.push(name);
      return OK;
    });
  return {
    add,
    ran,
    asked,
    call: (name: string) => toolHandlers[name]!({}),
    resolved: () => resolved,
  };
}

const ATTACH: Capability[] = ["read", "action", "human", "byob-attach"];

describe("register wrapper — capability gate, then engine gate, then hold, then handler", () => {
  it("refuses a tool whose capability is off before its handler, with no in-handler gate", async () => {
    const h = hostOver({ mode: "persistent", caps: ["read"] });
    h.add("hold_probe_gate_only", { capability: "eval" });
    const body = bodyOf(await h.call("hold_probe_gate_only"));
    expect(body.requiredCapability).toBe("eval");
    expect(h.ran).toEqual([]);
  });

  it("never reaches the hold for a call the capability refuses", async () => {
    const h = hostOver({ mode: "attached", caps: ["read", "byob-attach"] });
    h.add("hold_probe_cap_first", { capability: "action" });
    const body = bodyOf(await h.call("hold_probe_cap_first"));
    expect(body.requiredCapability).toBe("action");
    expect(h.resolved()).toBe(0);
    expect(h.asked).toEqual([]);
  });

  it("holds an action tool on an attached session and skips the handler on a no", async () => {
    const h = hostOver({ mode: "attached", caps: ATTACH });
    h.add("hold_probe_declined", { capability: "action" });
    const body = bodyOf(await h.call("hold_probe_declined"));
    expect(body.error).toBe("policy: human-declined");
    expect(body.action).toEqual({ type: "hold_probe_declined" });
    expect(h.asked).toEqual(["hold_probe_declined"]);
    expect(h.ran).toEqual([]);
  });

  it("runs the handler once the human says yes, asking once", async () => {
    const h = hostOver({ mode: "attached", caps: ATTACH, answer: true });
    h.add("hold_probe_approved", { capability: "action" });
    expect(bodyOf(await h.call("hold_probe_approved"))).toEqual({ ok: true });
    expect(h.asked).toEqual(["hold_probe_approved"]);
    expect(h.ran).toEqual(["hold_probe_approved"]);
  });

  it("consumes a pre-approval once per call", async () => {
    const approvals = new ApprovalStore();
    approvals.grant("byob_action", 60);
    const h = hostOver({ mode: "attached", caps: ATTACH, approvals });
    h.add("hold_probe_granted", { capability: "action" });
    await h.call("hold_probe_granted");
    expect(h.asked).toEqual([]);
    expect(h.ran).toEqual(["hold_probe_granted"]);
    expect(approvals.list().map((g) => g.uses)).toEqual([1]);
  });

  it("returns the engine refusal before asking", async () => {
    const h = hostOver({ mode: "attached", caps: ATTACH, engine: "firefox", answer: true });
    h.add("hold_probe_deep", { capability: "action", deep: true });
    const body = bodyOf(await h.call("hold_probe_deep"));
    expect(body.ok).toBe(false);
    expect(body.engine).toBe("firefox");
    expect(h.asked).toEqual([]);
    expect(h.ran).toEqual([]);
  });

  it("does not hold a managed session on a server that can attach", async () => {
    const h = hostOver({ mode: "incognito", caps: ATTACH });
    h.add("hold_probe_managed", { capability: "action" });
    expect(bodyOf(await h.call("hold_probe_managed"))).toEqual({ ok: true });
    expect(h.asked).toEqual([]);
  });

  it("does not hold a read tool or an opted-out tool on an attached session", async () => {
    const h = hostOver({ mode: "attached", caps: ATTACH });
    h.add("hold_probe_read", { capability: "read" });
    h.add("hold_probe_exempt", { capability: "action", byobConfirm: false });
    await h.call("hold_probe_read");
    await h.call("hold_probe_exempt");
    expect(h.ran).toEqual(["hold_probe_read", "hold_probe_exempt"]);
    expect(h.asked).toEqual([]);
    expect(h.resolved()).toBe(0);
  });

  it("holds an opted-in tool outside the held capabilities", async () => {
    const h = hostOver({ mode: "attached", caps: ATTACH });
    h.add("hold_probe_opt_in", { capability: "read", byobConfirm: true });
    expect(bodyOf(await h.call("hold_probe_opt_in")).error).toBe("policy: human-declined");
  });

  it("resolves no session in the wrapper when the hook is off or the server cannot attach", async () => {
    const noHook = hostOver({ mode: "attached", caps: ATTACH, hooks: ["navigate_off_allowlist"] });
    noHook.add("hold_probe_no_hook", { capability: "action" });
    await noHook.call("hold_probe_no_hook");
    const noAttach = hostOver({ mode: "persistent", caps: ["read", "action"] });
    noAttach.add("hold_probe_no_attach", { capability: "action" });
    await noAttach.call("hold_probe_no_attach");
    expect(noHook.resolved() + noAttach.resolved()).toBe(0);
    expect(noHook.ran.concat(noAttach.ran)).toEqual(["hold_probe_no_hook", "hold_probe_no_attach"]);
  });
});
