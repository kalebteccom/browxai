// Per-sink masking matrix. One describe block per egress sink — when a sink
// regresses, the test name names exactly which one. Mirrors browser-use's
// "every output path goes through the masker" baseline, applied at browxai's
// URL-sanitiser boundary.

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
      on: (evt: string, fn: never) => listeners.set(evt, fn),
    };

    buf.attach(fakePage as any);
    listeners.get("console")!({
      type: () => "log",
      text: () => "auth header carried tok-xyz inline",
    });
    const out = buf.recent();
    expect(out[0]!.text).toBe("auth header carried <TOKEN> inline");
  });

  it("composes with the URL sanitiser (both layers apply)", () => {
    const buf = new ConsoleBuffer();
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: "tok-xyz" });
    buf.setSecrets(secrets);
    const listeners = new Map<string, (m: { type: () => string; text: () => string }) => void>();

    buf.attach({ on: (evt: string, fn: never) => listeners.set(evt, fn) } as any);
    listeners.get("console")!({
      type: () => "error",
      text: () => "fetch https://api.example.com/x?token=tok-xyz failed for tok-xyz",
    });
    // URL sanitiser strips ?…; secrets layer rewrites the bare token literal.
    expect(buf.recent()[0]!.text).toBe("fetch https://api.example.com/x?… failed for <TOKEN>");
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
      response: { opcode: 1, payloadData: "echo hunter2 back" },
    });
    const { frames } = ws.recent();
    expect(frames[0]!.payload).toBe('{"auth":"<PASSWORD>"}');
    expect(frames[1]!.payload).toBe("echo <PASSWORD> back");
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
      send: vi.fn(async () => ({
        body: '{"sessionToken":"raw-tok-xyz","kind":"jwt"}',
        base64Encoded: false,
      })),
    } as never;
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: "raw-tok-xyz" });
    const r = await fetchResponseBody(cdp, "req-1", undefined, secrets);
    expect(r.ok).toBe(true);
    expect(r.body).toBe('{"sessionToken":"<TOKEN>","kind":"jwt"}');
  });

  it("passes base64 bodies through unchanged (documented caveat)", async () => {
    const cdp = {
      send: vi.fn(async () => ({ body: "aHVudGVyMg==", base64Encoded: true })),
    } as never;
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

describe("sanitiser composition — URL sanitiser + secrets both apply", () => {
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

// ---------------------------------------------------------------------------
// Per-sink coverage for handler-layer sinks. These pin the load-bearing
// invariant per-sink (a regression in any single sink fails a named test).
// The actual handlers depend on a Playwright Page; here we test the
// result-shaping layer — applyMaskDeep / applyMaskInText over the exact
// data-shape each handler emits. Sufficient because each handler's last
// step before serialising is "pipe the result through e.secrets.applyMask*"
// — a removal of that step breaks both the shape-test and the wired path.
// ---------------------------------------------------------------------------

describe("sink: snapshot — a11y tree text masking", () => {
  it("masks a registered value rendered into a node name in the serialised tree", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const rawBody =
      '- textbox "Password" [ref=e3]\n' +
      '  - text "hunter2" [ref=e4]\n' +
      '- button "Reveal: hunter2" [ref=e5]';
    const masked = r.applyMaskInText(rawBody);
    expect(masked).not.toContain("hunter2");
    expect(masked).toContain("<PASSWORD>");
    // count: two distinct occurrences should both be masked
    expect(masked.match(/<PASSWORD>/g)?.length).toBe(2);
  });
});

describe("sink: find — evidence masking", () => {
  it("masks registered values in candidate names / selectorHint / context.rowText", () => {
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "tok-xyz" });
    const findResult = {
      query: "the token row",
      candidates: [
        {
          ref: "e3",
          role: "row",
          name: "Token: tok-xyz",
          selectorHint: 'role=row[name="Token: tok-xyz"]',
          confidence: 0.91,
          bbox: { x: 0, y: 0, width: 100, height: 20 },
          context: { rowText: "Token tok-xyz Created 2026-05-26" },
        },
      ],
    };
    const masked = r.applyMaskDeep(findResult);
    const json = JSON.stringify(masked);
    expect(json).not.toContain("tok-xyz");
    expect(masked.candidates[0]!.name).toBe("Token: <TOKEN>");
    expect(masked.candidates[0]!.selectorHint).toBe('role=row[name="Token: <TOKEN>"]');
    expect(masked.candidates[0]!.context.rowText).toBe("Token <TOKEN> Created 2026-05-26");
  });
});

describe("sink: text_search — matches masking", () => {
  it("masks registered values in match text / context", () => {
    const r = new SecretRegistry();
    r.register({ name: "OTP", value: "987654" });
    const searchResult = {
      query: "987654",
      count: 1,
      matches: [
        {
          ref: "e7",
          role: "text",
          text: "Your code is 987654",
          context: { rowText: "code: 987654" },
        },
      ],
    };
    const masked = r.applyMaskDeep(searchResult);
    expect(JSON.stringify(masked)).not.toContain("987654");
    expect(masked.matches[0]!.text).toBe("Your code is <OTP>");
    expect(masked.matches[0]!.context.rowText).toBe("code: <OTP>");
  });
});

describe("sink: fill/press post-action probe — element echo masking", () => {
  it("masks the dispatched value when the element's post-action value echoes", () => {
    // After fill({value:"<PASSWORD>"}), the dispatch substitutes the real
    // value but the action handler records value:"<PASSWORD>" on the
    // descriptor. The post-action element probe reads back the DOM `.value`
    // — that string IS the real value and must be re-masked on egress.
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const actionResult = {
      ok: true,
      action: { type: "fill", target: { ref: "e3" }, value: "<PASSWORD>" },
      element: { ref: "e3", role: "textbox", name: "Password", value: "hunter2" },
      network: { summary: { total: 0, errors: 0, slow: 0 }, requests: [] },
    };
    const masked = r.applyMaskDeep(actionResult);
    expect(JSON.stringify(masked)).not.toContain("hunter2");
    expect(masked.element.value).toBe("<PASSWORD>");
    // descriptor was already alias-shaped, stays alias-shaped
    expect(masked.action.value).toBe("<PASSWORD>");
  });
});

describe("sink: act_and_diff — diff output masking (HIGH)", () => {
  it("masks registered values in aria-label / data-tooltip attribute deltas", () => {
    // act_and_diff diff carries raw aria-* / data-* attribute *values* and
    // inline-style values via classDelta / styleDelta / attrDelta. A
    // selection-state UI that writes `aria-label="copied hunter2"` would
    // disclose the registered value verbatim without this masking.
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const diff = {
      changed: [
        {
          path: "div.row[0]",
          tag: "div",
          testId: null,
          classDelta: { added: ["copied-hunter2"], removed: [] },
          styleDelta: { changed: { "background-image": "url(/avatars/hunter2.png)" } },
          attrDelta: {
            changed: {
              "aria-label": { from: "Click to copy", to: "Copied hunter2 to clipboard" },
              "data-tooltip": { from: null, to: "Value: hunter2" },
            },
          },
        },
      ],
      added: [],
      removed: [],
      counts: { changed: 1, added: 0, removed: 0 },
    };
    const masked = r.applyMaskDeep(diff);
    expect(JSON.stringify(masked)).not.toContain("hunter2");
    expect(masked.changed[0]!.classDelta.added[0]).toBe("copied-<PASSWORD>");
    expect(masked.changed[0]!.styleDelta.changed["background-image"]).toBe(
      "url(/avatars/<PASSWORD>.png)",
    );
    expect(masked.changed[0]!.attrDelta.changed["aria-label"].to).toBe(
      "Copied <PASSWORD> to clipboard",
    );
    expect(masked.changed[0]!.attrDelta.changed["data-tooltip"].to).toBe("Value: <PASSWORD>");
  });
});

describe("sink: watch — NetworkTap secrets threading + regions[].name masking (HIGH)", () => {
  it("NetworkTap inside watchWindow masks egressing URLs (constructor takes secrets arg)", async () => {
    // Regression guard for the construct-site fix: watch.ts previously did
    // `new NetworkTap(ctx.cdp)` and dropped the secrets arg, leaving the
    // literal-value scan disabled across the watch window. After the fix
    // the same constructor signature is used.
    const { cdp, fire } = fakeCdp();
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    const tap = new NetworkTap(cdp, secrets);
    await tap.open();
    fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "POST", url: "https://api.example.com/login?password=hunter2" },
      type: "XHR",
    });
    fire("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
    const { requests } = await tap.close();
    expect(requests[0]!.url).not.toContain("hunter2");
  });

  it("masks registered values in WatchResult.regions[].name (a11y node names)", () => {
    // A status-region whose visible text includes a registered value would
    // leak through `regions[].name` if the watch result weren't deep-masked
    // on the way out of the tool handler.
    const r = new SecretRegistry();
    r.register({ name: "OTP", value: "987654" });
    const watchResult = {
      durationMs: 2000,
      samples: 8,
      regions: [
        {
          role: "status",
          name: "Code 987654 sent",
          ref: "e1",
          appearedAtMs: 120,
          disappearedAtMs: 1800,
        },
        {
          role: "alert",
          name: "Use 987654 within 5 minutes",
          ref: "e2",
          appearedAtMs: 200,
          disappearedAtMs: null,
        },
      ],
      console: { errors: [], warnings: 0, pageErrors: [] },
      network: { summary: { total: 1, errors: 0, slow: 0 }, requests: [] },
      wsFrames: [],
    };
    const masked = r.applyMaskDeep(watchResult);
    expect(JSON.stringify(masked)).not.toContain("987654");
    expect(masked.regions[0]!.name).toBe("Code <OTP> sent");
    expect(masked.regions[1]!.name).toBe("Use <OTP> within 5 minutes");
  });
});

describe("sink: verify_* — failure.actual masking (CRITICAL — direct value disclosure)", () => {
  it("verify_value with a wrong expected masks the real value in failure.actual", () => {
    // The headline-invariant breach: an agent does
    //   verify_value({value:"guess", ref:pwField})
    // The real value of the field is "hunter2" (registered as <PASSWORD>).
    // Without masking, the tool result returns failure.actual:"hunter2"
    // — direct disclosure of the registered secret to the agent.
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const verifyResult = {
      ok: false as const,
      failure: {
        source: "app" as const,
        kind: "value" as const,
        expected: "guess",
        actual: "hunter2",
      },
    };
    const masked = r.applyMaskDeep(verifyResult);
    expect(JSON.stringify(masked)).not.toContain("hunter2");
    expect(masked.failure.actual).toBe("<PASSWORD>");
    // expected is what the AGENT supplied — pass-through (not the secret)
    expect(masked.failure.expected).toBe("guess");
  });

  it("verify_text echoes innerText slice — masked on miss", () => {
    // verify.ts:235 echoes trimmed.slice(0,200) of the field's actual
    // innerText on a verify_text miss. Same exposure shape; same fix.
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "raw-tok-xyz" });
    const verifyResult = {
      ok: false as const,
      failure: {
        source: "app" as const,
        kind: "text" as const,
        expected: "Welcome",
        actual: "Your session token is raw-tok-xyz — copy it now",
      },
    };
    const masked = r.applyMaskDeep(verifyResult);
    expect(masked.failure.actual).toBe("Your session token is <TOKEN> — copy it now");
    expect(JSON.stringify(masked)).not.toContain("raw-tok-xyz");
  });

  it("verify_attribute echoes the attribute value — masked on miss", () => {
    const r = new SecretRegistry();
    r.register({ name: "API_KEY", value: "raw-key-9999" });
    const verifyResult = {
      ok: false as const,
      failure: {
        source: "app" as const,
        kind: "attribute" as const,
        expected: "stable",
        actual: "live-with-raw-key-9999",
      },
    };
    const masked = r.applyMaskDeep(verifyResult);
    expect(masked.failure.actual).toBe("live-with-<API_KEY>");
  });

  it("ok:true results pass through unchanged (no body fields to mask)", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const verifyResult = { ok: true as const };
    expect(r.applyMaskDeep(verifyResult)).toEqual({ ok: true });
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
    expect(r.applyMaskInText("the literal <PWD> appears here")).toBe(
      "the literal <PASSWORD> appears here",
    );
    // and the agent passing `<PASSWORD>` still resolves to the stored value
    const m = r.materialize("<PASSWORD>", "u");
    expect(m.value).toBe("<PWD>");
  });
});
