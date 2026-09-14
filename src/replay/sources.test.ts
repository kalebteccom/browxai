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

  it("passes an unknown field on the source payload through instead of dropping it", () => {
    const ev = netRequestEvent(ctx(), {
      ...request,
      frameId: "F1",
      initiator: { type: "script" },
      someFieldCdpAddsIn2027: { nested: true },
    });
    expect(ev.payload.frameId).toBe("F1");
    expect(ev.payload.initiator).toEqual({ type: "script" });
    expect(ev.payload.someFieldCdpAddsIn2027).toEqual({ nested: true });
    expect(ev.payload.request.url).toBe("https://app.example.com/api/login");
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

  it("carries the failure text verbatim", () => {
    const ev = netFailedEvent(ctx(), {
      requestId: "42",
      errorText: "net::ERR_CONNECTION_REFUSED",
      canceled: false,
    });
    expect(ev.type).toBe("net/failed");
    expect(ev.payload.errorText).toBe("net::ERR_CONNECTION_REFUSED");
    expect(ev.payload.canceled).toBe(false);
  });
});

describe("websocket sources", () => {
  it("does not carry handshake headers on open", () => {
    // Handshake headers (`Authorization` / `Cookie`) sit on CDP's
    // `Network.webSocketWillSendHandshakeRequest`; the replay layer does NOT
    // tap that event and the schema no longer has a slot for the request
    // object. Capturing the handshake would broaden the archive's disclosure
    // surface without a corresponding review use case — the WS panel keys
    // off frames.
    const ev = wsOpenEvent(ctx(), {
      requestId: "ws-1",
      url: "wss://app.example.com/socket",
    });
    expect(ev.type).toBe("ws/open");
    expect(ev.payload.url).toBe("wss://app.example.com/socket");
    expect((ev.payload as Record<string, unknown>).request).toBeUndefined();
  });

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

  it("keeps a frame's unrecognised fields", () => {
    const ev = wsFrameEvent(ctx(), {
      url: "",
      dir: "sent",
      kind: "sse",
      event: "tick",
      payload: "1",
      futureFrameField: 7,
    });
    expect(ev.payload.futureFrameField).toBe(7);
    expect(ev.payload.event).toBe("tick");
  });

  it("records the close", () => {
    expect(wsCloseEvent(ctx(), { requestId: "ws-1" }).type).toBe("ws/close");
  });
});

describe("console, page errors and lifecycle", () => {
  it("carries a console message and a page error onto the log", () => {
    const msg = consoleMessageEvent(ctx(), { type: "warning", text: "deprecated", ts: ORIGIN + 5 });
    const err = pageErrorEvent(ctx(), { text: "TypeError: x", stack: "at f()" });
    expect(msg.type).toBe("console/message");
    expect(msg.payload.text).toBe("deprecated");
    expect(err.type).toBe("page/error");
    expect(err.payload.stack).toBe("at f()");
  });

  it("carries a lifecycle event as the page reported it", () => {
    const ev = pageLifecycleEvent(ctx(), {
      name: "framenavigated",
      url: "https://app.example.com/next",
      isMainFrame: true,
    });
    expect(ev.type).toBe("page/lifecycle");
    expect(ev.payload.name).toBe("framenavigated");
    expect(ev.payload.isMainFrame).toBe(true);
  });
});

describe("the agent timeline", () => {
  it("records the call with its args and target", () => {
    const ev = actionCallEvent(ctx(), {
      tool: "click",
      args: { ref: "e3" },
      target: { ref: "e3", bbox: [0, 0, 10, 10] },
    });
    expect(ev.type).toBe("action/call");
    expect(ev.payload.tool).toBe("click");
    expect(ev.payload.target).toEqual({ ref: "e3", bbox: [0, 0, 10, 10] });
  });

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

describe("what counts as an assertion", () => {
  it("routes the whole registered verify_* family onto assert/result", () => {
    for (const tool of [
      "verify_visible",
      "verify_text",
      "verify_value",
      "verify_count",
      "verify_attribute",
      "verify_predicate",
    ]) {
      expect(isAssertion(tool)).toBe(true);
      expect(resultEvent(ctx(), tool, { ok: true }).type).toBe("assert/result");
    }
  });

  it("routes a plugin's namespaced verify_* too", () => {
    expect(isAssertion("figma.verify_frame")).toBe(true);
  });

  it("routes an unknown tool that returned the fail-emitting verify contract", () => {
    expect(
      isAssertion("check_invariant", {
        ok: false,
        failure: { source: "app", kind: "count-equals", expected: "3", actual: 2 },
      }),
    ).toBe(true);
  });

  it("leaves the permissive and ordinary tools on action/result", () => {
    expect(isAssertion("click")).toBe(false);
    expect(isAssertion("wait_for", { ok: false })).toBe(false);
    expect(
      isAssertion("navigate", {
        ok: false,
        failure: { source: "browxai", hint: "context torn down" },
      }),
    ).toBe(false);
    expect(resultEvent(ctx(), "wait_for", { ok: false }).type).toBe("action/result");
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
  it("prefers an explicit label and defaults the phase to start", () => {
    const ev = annotateSpanEvent(ctx(), { label: "AC-4", copy: "checkout works", phase: "end" });
    expect(ev.type).toBe("annotate/span");
    expect(ev.payload.label).toBe("AC-4");
    expect(ev.payload.phase).toBe("end");
    expect(ev.payload.note).toBe("checkout works");
  });

  it("falls back to the annotation copy, and keeps record_annotate's own fields", () => {
    const ev = annotateSpanEvent(ctx(), { copy: "login page", arrow: "top-left", stepId: "s2" });
    expect(ev.payload.label).toBe("login page");
    expect(ev.payload.phase).toBe("start");
    expect(ev.payload.arrow).toBe("top-left");
    expect(ev.payload.stepId).toBe("s2");
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
