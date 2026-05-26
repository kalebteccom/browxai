// Per-sink masking matrix. One describe block per egress sink — when a sink
// regresses, the test name names exactly which one. Mirrors browser-use's
// "every output path goes through the masker" baseline, applied at browxai's
// W-O1 sanitiser boundary.

import { describe, it, expect, vi } from "vitest";
import { SecretRegistry } from "./secrets.js";
import { ConsoleBuffer } from "../page/console.js";
import { NetworkBuffer, NetworkTap, WsBuffer, fetchResponseBody } from "../page/network.js";

// Minimal CDP stub: records `on` handlers by event name and lets the test
// fire them. `send` resolves (Network.enable is idempotent).
function fakeCdp() {
  const handlers = new Map<string, (e: unknown) => void>();
  return {
    cdp: {
      send: vi.fn(async () => undefined),
      on: (evt: string, fn: (e: unknown) => void) => handlers.set(evt, fn),
      off: () => undefined,
    } as never,
    fire: (evt: string, e: unknown) => handlers.get(evt)?.(e),
  };
}

describe("sink: console_read", () => {
  it("masks registered values appearing in console message text", () => {
    const buf = new ConsoleBuffer();
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: "tok-xyz" });
    buf.setSecrets(secrets);
    // Synthesise a buffered message by calling the internal events the way
    // Playwright would. We re-attach a fake page by directly pushing through
    // the public surface — but the simplest path is to drive through `recent`
    // after manually populating the ring; instead, inject a console-like
    // event via attach() and a fake Page emitter.
    const listeners = new Map<string, (m: { type: () => string; text: () => string }) => void>();
    const fakePage = {
      on: (evt: string, fn: never) => listeners.set(evt, fn as never),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buf.attach(fakePage as any);
    listeners.get("console")!({ type: () => "log", text: () => "auth header carried tok-xyz inline" });
    const out = buf.recent();
    expect(out[0]!.text).toBe("auth header carried <TOKEN> inline");
  });

  it("composes with the W-O1 URL sanitiser (both layers apply)", () => {
    const buf = new ConsoleBuffer();
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: "tok-xyz" });
    buf.setSecrets(secrets);
    const listeners = new Map<string, (m: { type: () => string; text: () => string }) => void>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buf.attach({ on: (evt: string, fn: never) => listeners.set(evt, fn as never) } as any);
    listeners.get("console")!({
      type: () => "error",
      text: () => 'fetch https://api.example.com/x?token=tok-xyz failed for tok-xyz',
    });
    // URL sanitiser strips ?…; secrets layer rewrites the bare token literal.
    expect(buf.recent()[0]!.text).toBe('fetch https://api.example.com/x?… failed for <TOKEN>');
  });
});

describe("sink: network_read (NetworkBuffer)", () => {
  it("masks registered values in egressing URLs (literal-substring scan)", () => {
    const { cdp, fire } = fakeCdp();
    const buf = new NetworkBuffer(cdp);
    const secrets = new SecretRegistry();
    secrets.register({ name: "API_KEY", value: "raw-key-9999" });
    buf.setSecrets(secrets);
    // attach() registers handlers; calling sync via fire keeps the body
    // path simple — but NetworkBuffer.attach awaits Network.enable, so:
    void buf.attach();
    // give the microtask a tick to bind handlers (we drive synchronously)
    return Promise.resolve().then(() => {
      fire("Network.requestWillBeSent", {
        requestId: "r1",
        request: { method: "GET", url: "https://api.example.com/raw-key-9999/data" },
        type: "XHR",
      });
      fire("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
      const { requests } = buf.recent();
      // URL sanitiser may patternise the path segment; secrets layer
      // independently catches a literal value in the URL. Either way, the
      // raw key must NOT appear in the egressed URL.
      expect(requests[0]!.url).not.toContain("raw-key-9999");
    });
  });
});

describe("sink: ws_read (WsBuffer)", () => {
  it("masks registered values in WS frame payloads (both directions)", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp);
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    ws.setSecrets(secrets);
    await ws.attach();
    fire("Network.webSocketCreated", { requestId: "r1", url: "wss://rt.example/socket" });
    fire("Network.webSocketFrameSent", {
      requestId: "r1",
      response: { opcode: 1, payloadData: '{"auth":"hunter2"}' },
    });
    fire("Network.webSocketFrameReceived", {
      requestId: "r1",
      response: { opcode: 1, payloadData: 'echo hunter2 back' },
    });
    const { frames } = ws.recent();
    expect(frames[0]!.payload).toBe('{"auth":"<PASSWORD>"}');
    expect(frames[1]!.payload).toBe('echo <PASSWORD> back');
  });

  it("masks registered values in SSE event data", async () => {
    const { cdp, fire } = fakeCdp();
    const ws = new WsBuffer(cdp);
    const secrets = new SecretRegistry();
    secrets.register({ name: "OTP", value: "987654" });
    ws.setSecrets(secrets);
    await ws.attach();
    fire("Network.requestWillBeSent", {
      requestId: "sse1",
      request: { url: "https://api.example/stream" },
      type: "EventSource",
    });
    fire("Network.eventSourceMessageReceived", {
      requestId: "sse1",
      eventName: "ping",
      data: '{"otp":"987654"}',
    });
    expect(ws.recent().frames[0]!.payload).toBe('{"otp":"<OTP>"}');
  });
});

describe("sink: network_body (fetchResponseBody)", () => {
  it("masks registered values in the response body", async () => {
    const cdp = {
      send: vi.fn(async () => ({ body: '{"sessionToken":"raw-tok-xyz","kind":"jwt"}', base64Encoded: false })),
    } as never;
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: "raw-tok-xyz" });
    const r = await fetchResponseBody(cdp, "req-1", undefined, secrets);
    expect(r.ok).toBe(true);
    expect(r.body).toBe('{"sessionToken":"<TOKEN>","kind":"jwt"}');
  });

  it("passes base64 bodies through unchanged (documented caveat)", async () => {
    const cdp = { send: vi.fn(async () => ({ body: "aHVudGVyMg==", base64Encoded: true })) } as never;
    const secrets = new SecretRegistry();
    secrets.register({ name: "PWD", value: "hunter2" });
    const r = await fetchResponseBody(cdp, "req-1", undefined, secrets);
    expect(r.body).toBe("aHVudGVyMg=="); // unchanged — literal scan can't match encoded form
    expect(r.base64Encoded).toBe(true);
  });
});

describe("sink: NetworkTap (ActionResult.network)", () => {
  it("masks registered values in egressing request URLs through the action-window tap", async () => {
    const { cdp, fire } = fakeCdp();
    const secrets = new SecretRegistry();
    secrets.register({ name: "API_KEY", value: "raw-key-9999" });
    const tap = new NetworkTap(cdp, secrets);
    await tap.open();
    fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "GET", url: "https://api.example.com/raw-key-9999/data" },
      type: "XHR",
    });
    fire("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
    const { requests } = await tap.close();
    expect(requests[0]!.url).not.toContain("raw-key-9999");
  });
});

describe("sanitiser composition — W-O1 + secrets both apply", () => {
  it("URL sanitiser patternises path; secrets layer catches a literal value elsewhere", () => {
    // The URL sanitiser handles URL structure (query/fragment/userinfo/
    // token-paths via regex). The secrets layer handles literal real-value
    // substring scans. They compose at the egress boundary — neither layer
    // depends on the other's output shape.
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: "tok-xyz" });
    // Verified indirectly by the per-sink tests above; this one is the
    // declarative invariant — both layers are reachable independently and
    // ordering is "URL first, then secrets" (so a secret that landed in a
    // path segment that the URL sanitiser patternised away is fine — the
    // value vanished before the secrets-scan ran; the scan is defence-in-
    // depth for values that landed OUTSIDE URL shape).
    const out = secrets.applyMaskInText("a tok-xyz b");
    expect(out).toBe("a <TOKEN> b");
  });
});

describe("capability gate — registering without `secrets` capability", () => {
  // The capability gate lives at the server.ts handler boundary (see
  // gateCheck("register_secret")). The SecretRegistry itself is a plain
  // data structure — the gate is enforced by the MCP tool registration,
  // not by the registry. This test pins the contract: the registry can be
  // constructed and queried freely; gating is the handler's job. Verified
  // end-to-end via the capabilities.test.ts gate suite, where any tool
  // whose capability isn't in the active set returns the standard
  // disabled-tool early-return shape.
  it("registry construction is unconditional (gate is at the MCP handler boundary)", () => {
    const r = new SecretRegistry();
    expect(r.size()).toBe(0);
    expect(r.names()).toEqual([]);
  });
});

describe("literal-protection: <SECRET_NAME> as plain text", () => {
  it("a registered secret whose VALUE happens to be `<NAME>` still materialises (alias detection is structural, not value-based)", () => {
    // Edge case: the user registers a value that happens to look like a
    // mask. The registry's contract is that `materialize` only triggers
    // on `<UPPERCASE>`-shaped INPUTS, not on registered values. So the
    // value `<PWD>` registered under name `PASSWORD` stores literally;
    // egress masking of OTHER text mentioning `<PWD>` is unchanged.
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "<PWD>" });
    expect(r.applyMaskInText("the literal <PWD> appears here")).toBe("the literal <PASSWORD> appears here");
    // and the agent passing `<PASSWORD>` still resolves to the stored value
    const m = r.materialize("<PASSWORD>", "u");
    expect(m.value).toBe("<PWD>");
  });
});
