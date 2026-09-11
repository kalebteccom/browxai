import { describe, it, expect } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import {
  DOM_EVENT_TYPE,
  DOM_PAYLOAD_VERSION,
  attachDomCapture,
  eventTimestamp,
  rrwebBundleSource,
  toReplayEvent,
} from "./dom-capture.js";

type Binding = (source: { page?: Page }, payload: string) => unknown;

interface FakeContext {
  context: BrowserContext;
  bindings: Map<string, Binding>;
  initScripts: string[];
  exposeCalls: number;
}

function fakePage(): Page {
  return {
    evaluate: async () => undefined,
    isClosed: () => false,
  } as unknown as Page;
}

function fakeContext(pages: Page[] = [], exposeThrows = false): FakeContext {
  const bindings = new Map<string, Binding>();
  const initScripts: string[] = [];
  const state = { exposeCalls: 0 };
  const livePages = [...pages];
  const context = {
    exposeBinding: async (name: string, fn: Binding) => {
      state.exposeCalls += 1;
      if (exposeThrows) throw new Error(`Function "${name}" has been already registered`);
      bindings.set(name, fn);
    },
    addInitScript: async (script: { content: string }) => {
      initScripts.push(script.content);
    },
    pages: () => livePages,
  } as unknown as BrowserContext;
  return {
    context,
    bindings,
    initScripts,
    get exposeCalls() {
      return state.exposeCalls;
    },
  };
}

// ---- envelope wrapping ---------------------------------------------------

describe("toReplayEvent — the browxai envelope around an rrweb event", () => {
  it("carries the rrweb event verbatim under a dom/rrweb envelope", () => {
    const rrwebEvent = { type: 2, data: { node: { id: 1 } }, timestamp: 1_700_000_000_000 };
    const ev = toReplayEvent(rrwebEvent, { t: 1432, multiTarget: false });

    expect(ev.type).toBe(DOM_EVENT_TYPE);
    expect(ev.type).toBe("dom/rrweb");
    expect(ev.v).toBe(DOM_PAYLOAD_VERSION);
    expect(ev.t).toBe(1432);
    // Identity, not a structural copy: nothing is reshaped on the way through.
    expect(ev.payload).toBe(rrwebEvent);
  });

  it("rounds and floors t at zero so a page clock ahead of the origin cannot go negative", () => {
    expect(toReplayEvent({}, { t: 12.6, multiTarget: false }).t).toBe(13);
    expect(toReplayEvent({}, { t: -50, multiTarget: false }).t).toBe(0);
  });
});

// ---- the targetId rule ---------------------------------------------------

describe("toReplayEvent — targetId is written only on a multi-target session", () => {
  it("omits the key entirely on a single-target session", () => {
    const ev = toReplayEvent({}, { t: 1, targetId: "T1", multiTarget: false });
    expect("targetId" in ev).toBe(false);
  });

  it("writes targetId when the session holds more than one target", () => {
    const ev = toReplayEvent({}, { t: 1, targetId: "T1", multiTarget: true });
    expect(ev.targetId).toBe("T1");
  });

  it("omits the key when multi-target but no id could be resolved", () => {
    const ev = toReplayEvent({}, { t: 1, targetId: undefined, multiTarget: true });
    expect("targetId" in ev).toBe(false);
  });
});

// ---- the clock -----------------------------------------------------------

describe("eventTimestamp", () => {
  it("prefers the rrweb event's own timestamp, relative to clockOrigin", () => {
    expect(eventTimestamp({ timestamp: 1_000_500 }, 1_000_000, 9_999_999)).toBe(500);
  });

  it("falls back to arrival time when rrweb carried no usable timestamp", () => {
    expect(eventTimestamp({}, 1_000_000, 1_000_250)).toBe(250);
    expect(eventTimestamp({ timestamp: "nope" }, 1_000_000, 1_000_250)).toBe(250);
    expect(eventTimestamp(null, 1_000_000, 1_000_250)).toBe(250);
  });
});

// ---- injection wiring ----------------------------------------------------

describe("attachDomCapture — injection", () => {
  it("registers the emit binding and an init script carrying the rrweb bundle", async () => {
    const f = fakeContext();
    await attachDomCapture(f.context, { clockOrigin: 0, onEvent: () => undefined });

    expect(f.bindings.has("__browx_rrweb_emit")).toBe(true);
    expect(f.initScripts).toHaveLength(1);
    const script = f.initScripts[0]!;
    expect(script).toContain(rrwebBundleSource());
    expect(script).toContain("rr.record(");
  });

  it("masks input[type=password] by default and appends the configured selectors", async () => {
    const f = fakeContext();
    await attachDomCapture(f.context, {
      clockOrigin: 0,
      onEvent: () => undefined,
      maskSelectors: [".pii", "#ssn"],
    });

    const script = f.initScripts[0]!;
    expect(script).toContain('"always":"input[type=password]"');
    expect(script).toContain('"extra":".pii,#ssn"');
    expect(script).toContain('"password"');
  });

  it("never turns off password masking when no selectors are configured", async () => {
    const f = fakeContext();
    await attachDomCapture(f.context, { clockOrigin: 0, onEvent: () => undefined });
    expect(f.initScripts[0]!).toContain('"always":"input[type=password]"');
  });

  it("survives a binding that is already registered by another attach", async () => {
    const f = fakeContext([], true);
    const handle = await attachDomCapture(f.context, { clockOrigin: 0, onEvent: () => undefined });
    // Injection still happens; the stream is simply empty until the owner
    // releases the binding. No throw reaches the caller.
    expect(f.initScripts).toHaveLength(1);
    expect(handle.eventCount).toBe(0);
  });

  it("re-points the sink on re-attach instead of re-registering the binding", async () => {
    const f = fakeContext();
    const first: unknown[] = [];
    const second: unknown[] = [];
    await attachDomCapture(f.context, { clockOrigin: 0, onEvent: (e) => first.push(e) });
    await attachDomCapture(f.context, { clockOrigin: 0, onEvent: (e) => second.push(e) });

    expect(f.exposeCalls).toBe(1);
    expect(f.initScripts).toHaveLength(1);

    f.bindings.get("__browx_rrweb_emit")!({}, JSON.stringify({ type: 3, timestamp: 5 }));
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });
});

describe("attachDomCapture — the emitted stream", () => {
  it("wraps each rrweb event the binding delivers", async () => {
    const f = fakeContext();
    const out: Array<{ t: number; type: string; payload: unknown }> = [];
    await attachDomCapture(f.context, {
      clockOrigin: 1_000_000,
      onEvent: (e) => out.push(e),
    });

    const emit = f.bindings.get("__browx_rrweb_emit")!;
    emit({}, JSON.stringify({ type: 2, timestamp: 1_000_100, data: { href: "/a" } }));
    emit({}, JSON.stringify({ type: 3, timestamp: 1_000_400, data: { source: 0 } }));

    expect(out.map((e) => e.type)).toEqual(["dom/rrweb", "dom/rrweb"]);
    expect(out.map((e) => e.t)).toEqual([100, 400]);
    expect(out[0]!.payload).toEqual({ type: 2, timestamp: 1_000_100, data: { href: "/a" } });
  });

  it("drops an unparseable payload without emitting or throwing", async () => {
    const f = fakeContext();
    const out: unknown[] = [];
    const handle = await attachDomCapture(f.context, {
      clockOrigin: 0,
      onEvent: (e) => out.push(e),
    });

    f.bindings.get("__browx_rrweb_emit")!({}, "{not json");
    expect(out).toHaveLength(0);
    expect(handle.eventCount).toBe(0);
  });

  it("routes registered secrets through applyMaskDeep and nothing else", async () => {
    const f = fakeContext();
    const seen: string[] = [];
    const out: Array<{ payload: unknown }> = [];
    await attachDomCapture(f.context, {
      clockOrigin: 0,
      onEvent: (e) => out.push(e),
      secrets: {
        applyMaskDeep<T>(value: T): T {
          seen.push("called");
          return JSON.parse(JSON.stringify(value).replaceAll("hunter2", "<PASSWORD>")) as T;
        },
      },
    });

    f.bindings.get("__browx_rrweb_emit")!(
      {},
      JSON.stringify({ type: 3, timestamp: 0, data: { text: "hunter2" } }),
    );

    expect(seen).toEqual(["called"]);
    expect(JSON.stringify(out[0]!.payload)).not.toContain("hunter2");
    expect(JSON.stringify(out[0]!.payload)).toContain("<PASSWORD>");
  });

  it("stops emitting after detach", async () => {
    const f = fakeContext([fakePage()]);
    const out: unknown[] = [];
    const handle = await attachDomCapture(f.context, {
      clockOrigin: 0,
      onEvent: (e) => out.push(e),
    });
    await handle.detach();

    f.bindings.get("__browx_rrweb_emit")!({}, JSON.stringify({ type: 3, timestamp: 0 }));
    expect(out).toHaveLength(0);
  });
});

describe("attachDomCapture — targetId against a live context", () => {
  it("omits targetId while the context holds one page and writes it once a second opens", async () => {
    const a = fakePage();
    const b = fakePage();
    const pages: Page[] = [a];
    const f = fakeContext(pages);
    const out: Array<{ targetId?: string }> = [];
    await attachDomCapture(f.context, {
      clockOrigin: 0,
      onEvent: (e) => out.push(e),
      targetIdFor: (p) => (p === a ? "T-A" : "T-B"),
      targetCount: () => pages.length,
    });

    const emit = f.bindings.get("__browx_rrweb_emit")!;
    emit({ page: a }, JSON.stringify({ type: 3, timestamp: 0 }));
    expect("targetId" in out[0]!).toBe(false);

    pages.push(b);
    emit({ page: a }, JSON.stringify({ type: 3, timestamp: 0 }));
    emit({ page: b }, JSON.stringify({ type: 3, timestamp: 0 }));
    expect(out[1]!.targetId).toBe("T-A");
    expect(out[2]!.targetId).toBe("T-B");
  });

  it("mints a stable synthetic id per page when the session layer supplies none", async () => {
    const a = fakePage();
    const b = fakePage();
    const f = fakeContext([a, b]);
    const out: Array<{ targetId?: string }> = [];
    await attachDomCapture(f.context, {
      clockOrigin: 0,
      onEvent: (e) => out.push(e),
    });

    const emit = f.bindings.get("__browx_rrweb_emit")!;
    emit({ page: a }, JSON.stringify({ type: 3, timestamp: 0 }));
    emit({ page: b }, JSON.stringify({ type: 3, timestamp: 0 }));
    emit({ page: a }, JSON.stringify({ type: 3, timestamp: 0 }));

    expect(out[0]!.targetId).toBeTruthy();
    expect(out[1]!.targetId).not.toBe(out[0]!.targetId);
    expect(out[2]!.targetId).toBe(out[0]!.targetId);
  });
});
