// Per-sink masking matrix. One describe block per egress sink — when a sink
// regresses, the test name names exactly which one. Mirrors browser-use's
// "every output path goes through the masker" baseline, applied at browxai's
// URL-sanitiser boundary.

import { describe, it, expect, vi } from "vitest";
import { SecretRegistry } from "./secrets.js";
import { EgressSanitiser } from "./egress-sanitiser.js";
import { ConsoleBuffer } from "../page/console.js";
import { NetworkBuffer, NetworkTap, WsBuffer, fetchResponseBody } from "../page/network.js";
import { verifyPredicate } from "../page/verify.js";
import { maskToolResponse } from "../tools/host-egress-mask.js";
import { cacheEntryForCaps } from "../tools/storage-caches-tools.js";

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
  it.each([
    [
      "masks registered values appearing in console message text",
      "log",
      "auth header carried tok-xyz inline",
      "auth header carried <TOKEN> inline",
    ],
    [
      // URL sanitiser strips ?…; secrets layer rewrites the bare token literal.
      "composes with the URL sanitiser (both layers apply)",
      "error",
      "fetch https://api.example.com/x?token=tok-xyz failed for tok-xyz",
      "fetch https://api.example.com/x?… failed for <TOKEN>",
    ],
  ])("%s", (_label, type, text, expected) => {
    const buf = new ConsoleBuffer();
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: "tok-xyz" });
    buf.setSecrets(secrets);
    // Drive a console event through a fake Page emitter.
    const listeners = new Map<string, (m: { type: () => string; text: () => string }) => void>();
    buf.attach({ on: (evt: string, fn: never) => listeners.set(evt, fn) } as any);
    listeners.get("console")!({ type: () => type, text: () => text });
    expect(buf.recent()[0]!.text).toBe(expected);
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

describe("sink: NetworkTap (ActionResult.network and watch window)", () => {
  // watch.ts once built `new NetworkTap(ctx.cdp)` and dropped the secrets arg,
  // leaving the literal-value scan off across the watch window. Both consumers
  // use the constructor signature below.
  it.each([
    [
      "masks registered values in egressing request URLs through the action-window tap",
      "API_KEY",
      "raw-key-9999",
      "GET",
      "https://api.example.com/raw-key-9999/data",
    ],
    [
      "NetworkTap inside watchWindow masks egressing URLs (constructor takes secrets arg)",
      "PASSWORD",
      "hunter2",
      "POST",
      "https://api.example.com/login?password=hunter2",
    ],
  ])("%s", async (_label, name, value, method, url) => {
    const { cdp, fire } = fakeCdp();
    const secrets = new SecretRegistry();
    secrets.register({ name, value });
    const tap = new NetworkTap(cdp, secrets);
    await tap.open();
    fire("Network.requestWillBeSent", { requestId: "r1", request: { method, url }, type: "XHR" });
    fire("Network.responseReceived", { requestId: "r1", response: { status: 200 } });
    const { requests } = await tap.close();
    expect(requests[0]!.url).not.toContain(value);
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

// Per-sink coverage for handler-layer sinks. The handlers depend on a
// Playwright Page, so each row runs the exact data shape the handler emits
// through the masker its last step uses (applyMaskDeep / applyMaskInText). Each
// row is one sink; a regression in any single sink fails its named row.
type Check = [(masked: any) => unknown, unknown];
const verifyFail = (kind: string, expected: string, actual: string) => ({
  ok: false as const,
  failure: { source: "app" as const, kind, expected, actual },
});

describe("handler-layer sinks — applyMask* over each handler's result shape", () => {
  it.each<{
    sink: string;
    name: string;
    value: string;
    text?: string;
    input: unknown;
    checks: Check[];
  }>([
    {
      sink: "snapshot: masks a registered value rendered into a node name in the serialised tree (both occurrences)",
      name: "PASSWORD",
      value: "hunter2",
      text:
        '- textbox "Password" [ref=e3]\n' +
        '  - text "hunter2" [ref=e4]\n' +
        '- button "Reveal: hunter2" [ref=e5]',
      input: undefined,
      checks: [[(m) => m.match(/<PASSWORD>/g)?.length, 2]],
    },
    {
      sink: "find: masks registered values in candidate names / selectorHint / context.rowText",
      name: "TOKEN",
      value: "tok-xyz",
      input: {
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
      },
      checks: [
        [(m) => m.candidates[0].name, "Token: <TOKEN>"],
        [(m) => m.candidates[0].selectorHint, 'role=row[name="Token: <TOKEN>"]'],
        [(m) => m.candidates[0].context.rowText, "Token <TOKEN> Created 2026-05-26"],
      ],
    },
    {
      sink: "text_search: masks registered values in match text / context",
      name: "OTP",
      value: "987654",
      input: {
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
      },
      checks: [
        [(m) => m.matches[0].text, "Your code is <OTP>"],
        [(m) => m.matches[0].context.rowText, "code: <OTP>"],
      ],
    },
    {
      // After fill({value:"<PASSWORD>"}) the dispatch substitutes the real value,
      // and the post-action probe reads the DOM `.value` back: that string IS the
      // real value and must be re-masked on egress.
      sink: "fill/press post-action probe: masks the dispatched value when the element's value echoes",
      name: "PASSWORD",
      value: "hunter2",
      input: {
        ok: true,
        action: { type: "fill", target: { ref: "e3" }, value: "<PASSWORD>" },
        element: { ref: "e3", role: "textbox", name: "Password", value: "hunter2" },
        network: { summary: { total: 0, errors: 0, slow: 0 }, requests: [] },
      },
      checks: [
        [(m) => m.element.value, "<PASSWORD>"],
        // descriptor was already alias-shaped, stays alias-shaped
        [(m) => m.action.value, "<PASSWORD>"],
      ],
    },
    {
      // act_and_diff carries raw aria-* / data-* attribute values and inline-style
      // values; `aria-label="copied hunter2"` would disclose the value verbatim.
      sink: "act_and_diff: masks registered values in aria-label / data-tooltip / class / style deltas",
      name: "PASSWORD",
      value: "hunter2",
      input: {
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
      },
      checks: [
        [(m) => m.changed[0].classDelta.added[0], "copied-<PASSWORD>"],
        [
          (m) => m.changed[0].styleDelta.changed["background-image"],
          "url(/avatars/<PASSWORD>.png)",
        ],
        [(m) => m.changed[0].attrDelta.changed["aria-label"].to, "Copied <PASSWORD> to clipboard"],
        [(m) => m.changed[0].attrDelta.changed["data-tooltip"].to, "Value: <PASSWORD>"],
      ],
    },
    {
      // A status region whose visible text includes a registered value would leak
      // through `regions[].name` if the watch result weren't deep-masked.
      sink: "watch: masks registered values in WatchResult.regions[].name (a11y node names)",
      name: "OTP",
      value: "987654",
      input: {
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
      },
      checks: [
        [(m) => m.regions[0].name, "Code <OTP> sent"],
        [(m) => m.regions[1].name, "Use <OTP> within 5 minutes"],
      ],
    },
    {
      // Headline invariant: verify_value({value:"guess", ref:pwField}) must not
      // return failure.actual:"hunter2". `expected` is the agent's own input.
      sink: "verify_value: a wrong expected masks the real value in failure.actual",
      name: "PASSWORD",
      value: "hunter2",
      input: verifyFail("value", "guess", "hunter2"),
      checks: [
        [(m) => m.failure.actual, "<PASSWORD>"],
        [(m) => m.failure.expected, "guess"],
      ],
    },
    {
      sink: "verify_text: the echoed innerText slice is masked on miss",
      name: "TOKEN",
      value: "raw-tok-xyz",
      input: verifyFail("text", "Welcome", "Your session token is raw-tok-xyz — copy it now"),
      checks: [[(m) => m.failure.actual, "Your session token is <TOKEN> — copy it now"]],
    },
    {
      sink: "verify_attribute: the echoed attribute value is masked on miss",
      name: "API_KEY",
      value: "raw-key-9999",
      input: verifyFail("attribute", "stable", "live-with-raw-key-9999"),
      checks: [[(m) => m.failure.actual, "live-with-<API_KEY>"]],
    },
    {
      sink: "verify_*: ok:true results pass through unchanged (no body fields to mask)",
      name: "PASSWORD",
      value: "hunter2",
      input: { ok: true as const },
      checks: [[(m) => m, { ok: true }]],
    },
  ])("sink: $sink", ({ name, value, text, input, checks }) => {
    const r = new SecretRegistry();
    r.register({ name, value });
    const masked = text !== undefined ? r.applyMaskInText(text) : r.applyMaskDeep(input as never);
    expect(typeof masked === "string" ? masked : JSON.stringify(masked)).not.toContain(value);
    if (text !== undefined) expect(masked).toContain(`<${name}>`);
    for (const [pick, expected] of checks) expect(pick(masked)).toEqual(expected);
  });
});

describe("sink: worker_messages_read / workers_list / worker_message_send", () => {
  // The worker tools mask through `egressFor(e).maskDeep`, the same chokepoint
  // the other handler sinks use; `ws_read` masks its frames in the buffer.
  const egress = () => {
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "tok-xyz" });
    return new EgressSanitiser(r);
  };

  it("masks registered values in Web Worker (ww-*) and Service Worker (sw-*) message data", () => {
    const messages = [
      { workerId: "ww-1", data: '{"auth":"tok-xyz"}', at: 1 },
      { workerId: "sw-2", data: "push payload tok-xyz", at: 2 },
      { workerId: "sw-2", data: "nothing secret", at: 3 },
    ];
    const masked = egress().maskDeep({ ok: true, messages });
    expect(JSON.stringify(masked)).not.toContain("tok-xyz");
    expect(masked.messages[0]!.data).toBe('{"auth":"<TOKEN>"}');
    expect(masked.messages[1]!.data).toBe("push payload <TOKEN>");
    expect(masked.messages[2]!.data).toBe("nothing secret");
    expect(masked.messages.map((m) => m.workerId)).toEqual(["ww-1", "sw-2", "sw-2"]);
  });

  it("masks registered values in worker URLs and in an echoed send error", () => {
    const list = [
      {
        workerId: "ww-1",
        type: "web",
        url: "https://app.example/w.js?k=tok-xyz",
        state: "running",
      },
      { workerId: "sw-1", type: "service", url: "https://app.example/sw-tok-xyz.js" },
    ];
    expect(JSON.stringify(egress().maskDeep(list))).not.toContain("tok-xyz");
    const sent = egress().maskDeep({ ok: false, workerId: "sw-1", error: "rejected tok-xyz" });
    expect(sent.error).toBe("rejected <TOKEN>");
  });

  it("passes data through unchanged when the secrets capability is off", () => {
    const messages = [{ workerId: "ww-1", data: "tok-xyz", at: 1 }];
    expect(new EgressSanitiser(null).maskDeep(messages)).toEqual(messages);
  });
});

describe("sink: verify_predicate — deep failure.actual masking (the unbounded-depth sink)", () => {
  // verify_predicate is the one shipped sink with no depth ceiling: `data` is
  // `z.record(z.string(), z.unknown())` and `failure.actual` is a subtree lifted
  // straight out of it, so the caller controls how deep the masker has to walk.
  // Real predicate engine, not a hand-built failure: `equals` against a
  // non-scalar key lifts the whole resolved subtree into `failure.actual`.
  let deep30: unknown = { code: "your code is 987654" };
  for (let i = 0; i < 30; i++) deep30 = { level: deep30 };

  it.each<[string, string, string, string, Record<string, unknown>, string[]]>([
    [
      "masks a registered value nested ~10 deep in the caller's data bag",
      "PASSWORD",
      "hunter2",
      "actionResult",
      {
        actionResult: {
          page: {
            frames: [
              {
                dom: {
                  form: {
                    fields: [
                      { element: { attrs: { value: "hunter2" } } },
                      { element: { attrs: { value: "not-a-secret" } } },
                    ],
                  },
                },
              },
            ],
          },
        },
      },
      // non-secret leaves survive intact
      ["<PASSWORD>", "not-a-secret"],
    ],
    [
      "masks a registered value in a long accessor chain (depth 30)",
      "OTP",
      "987654",
      "snapshot",
      { snapshot: deep30 },
      ["your code is <OTP>"],
    ],
  ])("%s", (_label, name, value, key, data, survivors) => {
    const r = new SecretRegistry();
    r.register({ name, value });
    const res = verifyPredicate({ kind: "equals", key, value: "never" }, data);
    expect(res.ok).toBe(false);
    const rawBody = res.ok ? { ok: true as const } : { ok: false as const, failure: res.failure };
    const json = JSON.stringify(r.applyMaskDeep(rawBody));
    expect(json).not.toContain(value);
    for (const keep of survivors) expect(json).toContain(keep);
  });
});

// The page-data readers below return what the page holds and never called the
// egress sanitiser themselves. They are covered by the `register` wrapper's one
// masking pass (`maskToolResponse`), so each row runs that tool's result shape
// through it, in the JSON layout the tool emits.
describe("sink: page-data readers through the register wrapper", () => {
  const secretsWith = (): SecretRegistry => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    return r;
  };
  const viaWrapper = (body: unknown): string => {
    const res = maskToolResponse(
      { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] },
      [secretsWith()],
    );
    return (res.content[0] as { text: string }).text;
  };
  const cachedEntry = {
    found: true,
    kind: "text",
    text: '{"password":"hunter2"}',
    contentType: "application/json",
    status: 200,
    headers: { "x-echo": "hunter2" },
    cacheName: "v1",
    url: "https://app.test/me",
    origin: "https://app.test",
  };

  it.each<[string, unknown, (out: string) => unknown, unknown]>([
    [
      "extract: a filled field read back by a schema",
      {
        ok: true,
        data: { email: "a@b.test", password: "hunter2", rows: [{ note: "pw hunter2" }] },
        tokensEstimate: 20,
      },
      (out) => JSON.parse(out).data,
      { email: "a@b.test", password: "<PASSWORD>", rows: [{ note: "pw <PASSWORD>" }] },
    ],
    [
      "shadow_trees: an input value inside a shadow root",
      {
        ok: true,
        hosts: [{ host: "login-form", tree: { tag: "input", value: "hunter2", children: [] } }],
      },
      (out) => JSON.parse(out).hosts[0].tree.value,
      "<PASSWORD>",
    ],
    [
      "cookies_get: a cookie value carrying the password",
      {
        ok: true,
        cookie: { name: "remember", value: "user%3Dalice%26pw%3Dhunter2", domain: "app.test" },
      },
      (out) => JSON.parse(out).cookie.value,
      "user%3Dalice%26pw%3D<PASSWORD>",
    ],
    [
      "idb_get: a stored record, value and key",
      { ok: true, found: true, key: "hunter2", value: { draft: { password: "hunter2" } } },
      (out) => {
        const b = JSON.parse(out);
        return { key: b.key, value: b.value };
      },
      { key: "<PASSWORD>", value: { draft: { password: "<PASSWORD>" } } },
    ],
    [
      "caches_get: a cached text body, with network-body on",
      { ok: true, ...cacheEntryForCaps(cachedEntry, true) },
      (out) => JSON.parse(out).text,
      '{"password":"<PASSWORD>"}',
    ],
  ])("%s", (_label, body, pick, expected) => {
    const out = viaWrapper(body);
    expect(out).not.toContain("hunter2");
    expect(pick(out)).toEqual(expected);
  });

  it("caches_get: without network-body the body is left out and the headers are masked", () => {
    const body = JSON.parse(viaWrapper({ ok: true, ...cacheEntryForCaps(cachedEntry, false) }));
    expect(body.text).toBeUndefined();
    expect(body.bodyOmitted).toBe(true);
    expect(body.requiredCapability).toBe("network-body");
    expect(body.byteLength).toBe(22);
    expect(body.headers).toEqual({ "x-echo": "<PASSWORD>" });
    expect(body.status).toBe(200);
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
