import { describe, expect, it } from "vitest";
import { SecretRegistry } from "../util/secrets.js";
import { Redactor, redactedMarker } from "./redact.js";
import { isRedacted } from "./schema.js";
import {
  actionCallEvent,
  annotateSpanEvent,
  consoleMessageEvent,
  createClock,
  isAssertion,
  netFailedEvent,
  netRequestEvent,
  netResponseEvent,
  pageErrorEvent,
  pageLifecycleEvent,
  resultEvent,
  wsCloseEvent,
  wsFrameEvent,
  wsOpenEvent,
  type SourceContext,
} from "./sources.js";

const ORIGIN = 1_700_000_000_000;

function ctx(over: Partial<SourceContext> = {}): SourceContext {
  return { clock: createClock(ORIGIN), redact: new Redactor(), ...over };
}

function withSecret(name: string, value: string): SourceContext {
  const secrets = new SecretRegistry();
  secrets.register({ name, value });
  return ctx({ redact: new Redactor({ secrets }) });
}

describe("the clock", () => {
  it("puts every source on one origin-relative timeline", () => {
    const c = ctx();
    const net = netFailedEvent(c, { requestId: "1" }, ORIGIN + 250);
    const con = consoleMessageEvent(c, { type: "error", text: "boom", ts: ORIGIN + 400 });
    expect(net.t).toBe(250);
    expect(con.t).toBe(400);
  });

  it("clamps a pre-origin timestamp to zero so `t` stays monotonic", () => {
    expect(netFailedEvent(ctx(), { requestId: "1" }, ORIGIN - 500).t).toBe(0);
  });

  it("stamps targetId only when the session has one", () => {
    expect(netFailedEvent(ctx(), { requestId: "1" }).targetId).toBeUndefined();
    expect(netFailedEvent(ctx({ targetId: "tab-2" }), { requestId: "1" }).targetId).toBe("tab-2");
  });
});

describe("network sources", () => {
  const request = {
    requestId: "42",
    type: "XHR",
    request: {
      url: "https://app.example.com/api/login",
      method: "POST",
      headers: { authorization: "Bearer abc", "content-type": "application/json" },
      postData: '{"user":"ada"}',
    },
  };

  it("carries the request close to the wire and redacts the authorization header", () => {
    const ev = netRequestEvent(ctx(), request);
    expect(ev.type).toBe("net/request");
    expect(ev.v).toBe(1);
    expect(ev.payload.request.url).toBe("https://app.example.com/api/login");
    expect(ev.payload.request.method).toBe("POST");
    expect(ev.payload.type).toBe("XHR");
    expect(ev.payload.request.postData).toBe('{"user":"ada"}');
    expect(ev.payload.request.headers).toEqual({
      authorization: redactedMarker("header"),
      "content-type": "application/json",
    });
  });

  it("keeps the listed fields of a request and leaves out any other", () => {
    const ev = netRequestEvent(ctx(), {
      ...request,
      frameId: "F1",
      loaderId: "L1",
      timestamp: 12.5,
      wallTime: 1_700_000_000.25,
      hasUserGesture: true,
      initiator: { type: "script", stack: { callFrames: [{ url: "https://a.test/app.js?k=1" }] } },
      someFieldCdpAddsIn2027: { nested: true },
    });
    expect(ev.payload).toEqual({
      requestId: "42",
      type: "XHR",
      frameId: "F1",
      loaderId: "L1",
      timestamp: 12.5,
      wallTime: 1_700_000_000.25,
      hasUserGesture: true,
      request: {
        url: "https://app.example.com/api/login",
        method: "POST",
        headers: { authorization: redactedMarker("header"), "content-type": "application/json" },
        postData: '{"user":"ada"}',
      },
    });
  });

  it("leaves out a listed field that does not hold a scalar", () => {
    const ev = netRequestEvent(ctx(), { ...request, frameId: { nested: "F1" }, loaderId: ["L1"] });
    expect("frameId" in ev.payload).toBe(false);
    expect("loaderId" in ev.payload).toBe(false);
  });

  it("keeps the listed fields of a response and leaves out any other", () => {
    const ev = netResponseEvent(ctx(), {
      requestId: "42",
      type: "XHR",
      frameId: "F1",
      hasExtraInfo: true,
      response: {
        url: "https://app.example.com/api/login",
        status: 200,
        statusText: "OK",
        mimeType: "application/json",
        protocol: "h2",
        encodedDataLength: 321,
        headers: { "set-cookie": "sid=1", "content-length": "9" },
        headersText: "HTTP/1.1 200 OK\r\nSet-Cookie: sid=1\r\n",
        requestHeaders: { cookie: "sid=1" },
        requestHeadersText: "POST /api/login HTTP/1.1\r\nCookie: sid=1\r\n",
        securityDetails: { subjectName: "app.example.com" },
        timing: { requestTime: 1 },
      },
    });
    expect(ev.payload).toEqual({
      requestId: "42",
      type: "XHR",
      frameId: "F1",
      response: {
        url: "https://app.example.com/api/login",
        status: 200,
        statusText: "OK",
        mimeType: "application/json",
        protocol: "h2",
        encodedDataLength: 321,
        headers: { "set-cookie": redactedMarker("header"), "content-length": "9" },
      },
    });
  });

  it("records a URL without its query string, fragment or userinfo", () => {
    const ev = netRequestEvent(ctx(), {
      requestId: "7",
      documentURL: "https://user:pw@app.example.com/home?session=abc#top",
      request: { url: "https://user:pw@app.example.com/api/items?token=abc#frag", method: "GET" },
      redirectResponse: {
        url: "https://app.example.com/old?token=abc",
        status: 302,
        headers: { location: "/api/items", "set-cookie": "sid=1" },
      },
    });
    expect(ev.payload.request.url).toBe("https://app.example.com/api/items?…#…");
    expect(ev.payload.documentURL).toBe("https://app.example.com/home?…#…");
    expect(ev.payload.redirectResponse).toEqual({
      url: "https://app.example.com/old?…",
      status: 302,
      headers: { location: "/api/items", "set-cookie": redactedMarker("header") },
    });
    const res = netResponseEvent(ctx(), {
      requestId: "7",
      response: { url: "https://user:pw@app.example.com/api/items?token=abc", status: 200 },
    });
    expect(res.payload.response.url).toBe("https://app.example.com/api/items?…");
  });

  it("records the base64 request body parts at the re-executable tier only", () => {
    const withParts = {
      requestId: "8",
      request: {
        url: "https://app.example.com/api/login",
        method: "POST",
        postData: '{"user":"ada"}',
        postDataEntries: [{ bytes: Buffer.from('{"user":"ada"}', "utf8").toString("base64") }],
      },
    };
    expect("postDataEntries" in netRequestEvent(ctx(), withParts).payload.request).toBe(false);
    expect(
      "postDataEntries" in netRequestEvent(ctx({ tier: "replay" }), withParts).payload.request,
    ).toBe(false);
    const kept = netRequestEvent(ctx({ tier: "reexecutable" }), withParts);
    expect(kept.payload.request.postDataEntries).toEqual(withParts.request.postDataEntries);
  });

  it("gives a request body part the body rules, and drops bytes that are not text", () => {
    const redact = new Redactor({ bodyPaths: ["token"] });
    const ev = netRequestEvent(ctx({ redact, tier: "reexecutable" }), {
      requestId: "9",
      request: {
        url: "https://app.example.com/api",
        method: "POST",
        postDataEntries: [
          { bytes: Buffer.from('{"token":"t","ok":true}', "utf8").toString("base64") },
          { bytes: Buffer.from([0xff, 0xfe, 0x00, 0x80]).toString("base64") },
          {},
        ],
      },
    });
    const [json, binary, empty] = ev.payload.request.postDataEntries ?? [];
    expect(JSON.parse(Buffer.from(json?.bytes as string, "base64").toString("utf8"))).toEqual({
      token: redactedMarker("body-rule"),
      ok: true,
    });
    expect(binary).toEqual({});
    expect(empty).toEqual({});
    const dropped = netRequestEvent(
      ctx({ redact: new Redactor({ bodyPaths: ["$"] }), tier: "reexecutable" }),
      {
        requestId: "9",
        request: {
          url: "https://app.example.com/api",
          method: "POST",
          postDataEntries: [{ bytes: Buffer.from("a=1", "utf8").toString("base64") }],
        },
      },
    );
    expect(dropped.payload.request.postDataEntries).toEqual([
      { bytes: redactedMarker("body-rule") },
    ]);
  });

  it("redacts response headers and the optional re-executable-tier body", () => {
    const ev = netResponseEvent(
      ctx({ redact: new Redactor({ bodyPaths: ["token"] }) }),
      {
        requestId: "42",
        response: {
          url: "https://app.example.com/api/login",
          status: 200,
          mimeType: "application/json",
          headers: { "set-cookie": "sid=1", "content-length": "9" },
        },
      },
      { body: '{"token":"t","ok":true}' },
    );
    expect(ev.type).toBe("net/response");
    expect(ev.payload.response.status).toBe(200);
    expect(ev.payload.response.headers).toEqual({
      "set-cookie": redactedMarker("header"),
      "content-length": "9",
    });
    expect(JSON.parse(ev.payload.body as string)).toEqual({
      token: redactedMarker("body-rule"),
      ok: true,
    });
  });

  it("omits the body entirely when no body was captured", () => {
    const ev = netResponseEvent(ctx(), {
      requestId: "42",
      response: { url: "https://x.test/", status: 204 },
    });
    expect("body" in ev.payload).toBe(false);
  });
});

describe("websocket sources", () => {
  it("gives a frame payload the same body rule an HTTP body gets", () => {
    const redact = new Redactor({ bodyPaths: ["auth.token"] });
    const wire = JSON.stringify({ auth: { token: "t" }, msg: "hi" });
    const frame = wsFrameEvent(ctx({ redact }), {
      url: "wss://app.example.com/socket",
      dir: "recv",
      kind: "ws",
      opcode: 1,
      payload: wire,
      ts: ORIGIN + 10,
    });
    const body = netResponseEvent(
      ctx({ redact }),
      { requestId: "1", response: { url: "https://app.example.com/api", status: 200 } },
      { body: wire },
    );
    expect(frame.payload.payload).toEqual(body.payload.body);
    expect(JSON.parse(frame.payload.payload as string)).toEqual({
      auth: { token: redactedMarker("body-rule") },
      msg: "hi",
    });
    expect(frame.payload.dir).toBe("recv");
    expect(frame.t).toBe(10);
  });
});

describe("the agent timeline", () => {
  it("carries the whole ActionResult through rather than summarising it", () => {
    const ev = resultEvent(
      ctx(),
      "click",
      {
        ok: true,
        navigation: { changed: true, from: "https://a.test/", to: "https://a.test/b", kind: "spa" },
        warnings: ["slow"],
        tokensEstimate: 120,
      },
      { screenshot: 3 },
    );
    expect(ev.type).toBe("action/result");
    expect(ev.payload.ok).toBe(true);
    expect(ev.payload.screenshot).toBe(3);
    expect(ev.payload.navigation).toEqual({
      changed: true,
      from: "https://a.test/",
      to: "https://a.test/b",
      kind: "spa",
    });
    expect(ev.payload.warnings).toEqual(["slow"]);
    expect(ev.payload.tokensEstimate).toBe(120);
  });
});

describe("a register_secret call on the agent timeline", () => {
  it("is recorded without its value, before the value is in any registry", () => {
    const value = "not-registered-yet-hunter2";
    // `ctx()` has no registry: the state when action/call is emitted, ahead of
    // the handler that registers the value.
    const ev = actionCallEvent(ctx(), {
      tool: "register_secret",
      args: { name: "PASSWORD", value, session: "s1" },
    });
    expect(JSON.stringify(ev)).not.toContain(value);
    expect(ev.payload).toEqual({
      tool: "register_secret",
      args: { name: "PASSWORD", value: redactedMarker("secret"), session: "s1" },
    });
  });
});

describe("what counts as an assertion", () => {
  type Outcome = Parameters<typeof resultEvent>[2];
  it.each<[string, string, Outcome, boolean]>([
    ["routes verify_visible onto assert/result", "verify_visible", { ok: true }, true],
    ["routes verify_predicate onto assert/result", "verify_predicate", { ok: true }, true],
    ["routes a plugin's namespaced verify_* too", "figma.verify_frame", { ok: true }, true],
    [
      "routes an unknown tool that returned the fail-emitting verify contract",
      "check_invariant",
      { ok: false, failure: { source: "app", kind: "count-equals", expected: "3", actual: 2 } },
      true,
    ],
    ["leaves click on action/result", "click", { ok: true }, false],
    ["leaves the permissive wait_for on action/result", "wait_for", { ok: false }, false],
    [
      "leaves a browxai-sourced failure on action/result",
      "navigate",
      { ok: false, failure: { source: "browxai", hint: "context torn down" } },
      false,
    ],
  ])("%s", (_label, tool, outcome, assertion) => {
    expect(isAssertion(tool, outcome)).toBe(assertion);
    expect(resultEvent(ctx(), tool, outcome).type).toBe(
      assertion ? "assert/result" : "action/result",
    );
  });

  it("lifts expected/actual out of the failure and keeps the failure itself", () => {
    const ev = resultEvent(ctx(), "verify_text", {
      ok: false,
      failure: { source: "app", kind: "text-equals", expected: "Welcome", actual: "Goodbye" },
    });
    expect(ev.type).toBe("assert/result");
    expect(ev.payload).toMatchObject({
      tool: "verify_text",
      ok: false,
      expected: "Welcome",
      actual: "Goodbye",
      failure: { source: "app", kind: "text-equals" },
    });
  });

  it("omits expected/actual on a pass", () => {
    const ev = resultEvent(ctx(), "verify_visible", { ok: true });
    expect("expected" in ev.payload).toBe(false);
    expect(ev.payload.ok).toBe(true);
  });
});

describe("annotation spans", () => {
  it.each<[string, Parameters<typeof annotateSpanEvent>[1], Record<string, unknown>]>([
    [
      "prefers an explicit label and carries the phase and note",
      { label: "AC-4", copy: "checkout works", phase: "end" },
      { label: "AC-4", phase: "end", note: "checkout works" },
    ],
    [
      "falls back to the annotation copy, defaults the phase to start and keeps record_annotate's own fields",
      { copy: "login page", arrow: "top-left", stepId: "s2" },
      { label: "login page", phase: "start", arrow: "top-left", stepId: "s2" },
    ],
  ])("%s", (_label, args, payload) => {
    const ev = annotateSpanEvent(ctx(), args);
    expect(ev.type).toBe("annotate/span");
    expect(ev.payload).toMatchObject(payload);
  });
});

describe("a registered secret never survives into an event", () => {
  const SECRET = "hunter2-real-password";

  it("is masked on every source, including fields no adapter declares", () => {
    const c = withSecret("PASSWORD", SECRET);
    const events = [
      netRequestEvent(c, {
        requestId: "1",
        request: {
          url: `https://app.example.com/login?p=${SECRET}`,
          method: "POST",
          headers: { "x-echo": SECRET },
          postData: JSON.stringify({ password: SECRET }),
        },
        undeclaredExtra: { deep: [SECRET] },
      }),
      netResponseEvent(
        c,
        { requestId: "1", response: { url: "https://app.example.com/login", status: 200 } },
        { body: JSON.stringify({ echoed: SECRET }) },
      ),
      netFailedEvent(c, { requestId: "1", errorText: `failed for ${SECRET}` }),
      wsOpenEvent(c, { requestId: "w", url: `wss://app.example.com/s?t=${SECRET}` }),
      wsFrameEvent(c, {
        url: "wss://app.example.com/s",
        dir: "recv",
        kind: "ws",
        payload: JSON.stringify({ broadcast: SECRET }),
      }),
      wsCloseEvent(c, { requestId: "w", reason: SECRET }),
      consoleMessageEvent(c, { type: "log", text: `typed ${SECRET}` }),
      pageErrorEvent(c, { text: `Error: ${SECRET}` }),
      pageLifecycleEvent(c, { name: "framenavigated", url: `https://a.test/?x=${SECRET}` }),
      actionCallEvent(c, { tool: "fill", args: { value: SECRET } }),
      resultEvent(c, "fill", { ok: true, element: { value: SECRET } }),
      resultEvent(c, "verify_value", {
        ok: false,
        failure: { source: "app", kind: "value-equals", expected: "x", actual: SECRET },
      }),
      annotateSpanEvent(c, { copy: `used ${SECRET}` }),
    ];
    for (const ev of events) {
      const line = JSON.stringify(ev);
      expect(line, `${ev.type} leaked the registered secret`).not.toContain(SECRET);
      expect(line).toContain("<PASSWORD>");
    }
  });

  it("is in no field of a CDP-shaped request or response", () => {
    const c = { ...withSecret("PASSWORD", SECRET), tier: "reexecutable" as const };
    const body = JSON.stringify({ email: "a@b.co", password: SECRET });
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
    const request = netRequestEvent(c, {
      requestId: "1",
      loaderId: "L1",
      documentURL: `https://${SECRET}:x@app.example.com/login?next=${SECRET}`,
      type: "Fetch",
      request: {
        url: `https://user:${SECRET}@app.example.com/api/login?p=${SECRET}#${SECRET}`,
        urlFragment: `#${SECRET}`,
        method: "POST",
        headers: { "x-echo": SECRET, cookie: `sid=${SECRET}` },
        postData: body,
        postDataEntries: [{ bytes: b64(body) }, { bytes: b64(`tail ${SECRET}`) }],
      },
      redirectResponse: {
        url: `https://app.example.com/sso?ticket=${SECRET}`,
        status: 302,
        statusText: `Found ${SECRET}`,
        headers: { location: `/cb?ticket=${SECRET}`, "set-cookie": `sid=${SECRET}` },
        headersText: `HTTP/1.1 302 Found\r\nSet-Cookie: sid=${SECRET}\r\n`,
        requestHeaders: { cookie: `sid=${SECRET}` },
        requestHeadersText: `GET /sso HTTP/1.1\r\nCookie: sid=${SECRET}\r\n`,
      },
      initiator: { type: "script", url: `https://app.example.com/app.js?k=${SECRET}` },
    });
    const response = netResponseEvent(
      c,
      {
        requestId: "1",
        response: {
          url: `https://app.example.com/api/login?p=${SECRET}`,
          status: 200,
          headers: { "x-echo": SECRET, "set-cookie": `sid=${SECRET}` },
          headersText: `HTTP/1.1 200 OK\r\nSet-Cookie: sid=${SECRET}\r\n`,
          requestHeaders: { authorization: `Bearer ${SECRET}` },
          requestHeadersText: `POST /api/login HTTP/1.1\r\nAuthorization: Bearer ${SECRET}\r\n`,
        },
      },
      { body: JSON.stringify({ echoed: SECRET }) },
    );
    for (const ev of [request, response]) {
      const line = JSON.stringify(ev);
      expect(line, `${ev.type} holds the registered value`).not.toContain(SECRET);
      // No base64 part holds it either, once decoded.
      for (const part of line.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
        expect(Buffer.from(part, "base64").toString("utf8")).not.toContain(SECRET);
      }
      expect(line).toContain("<PASSWORD>");
    }
    const parts = request.payload.request.postDataEntries ?? [];
    expect(parts.map((p) => Buffer.from(p.bytes as string, "base64").toString("utf8"))).toEqual([
      JSON.stringify({ email: "a@b.co", password: "<PASSWORD>" }),
      "tail <PASSWORD>",
    ]);
    expect(request.payload.request.url).toBe("https://app.example.com/api/login?…#…");
    expect(request.payload.documentURL).toBe("https://app.example.com/login?…");
    expect(request.payload.redirectResponse?.url).toBe("https://app.example.com/sso?…");
    expect(request.payload.redirectResponse?.headers).toEqual({
      location: "/cb?ticket=<PASSWORD>",
      "set-cookie": redactedMarker("header"),
    });
    expect(Object.keys(response.payload.response).sort()).toEqual(["headers", "status", "url"]);
  });

  it("still masks when a header rule already dropped the value", () => {
    const ev = netRequestEvent(withSecret("TOKEN", SECRET), {
      requestId: "1",
      request: {
        url: "https://app.example.com/",
        method: "GET",
        headers: { authorization: `Bearer ${SECRET}` },
      },
    });
    expect(isRedacted(ev.payload.request.headers?.authorization)).toBe(true);
    expect(JSON.stringify(ev)).not.toContain(SECRET);
  });
});
