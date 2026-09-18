// Unit tests for the WebDriverAgent transport and the source-JSON → `NativeNode`
// conversion, against a faked `Http` — the same shape `safaridriver-hybrid.test.ts`
// uses for its faked WebDriver client. What they pin is what a fake CAN pin: the
// endpoints, the envelope unwrapping, the error classification, and the lossy
// parts of the field mapping. Whether a real WebDriverAgent answers those
// endpoints is the simulator-gated keystone's claim, not this file's.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_WDA_URL,
  WdaClient,
  WdaCommandError,
  WdaUnreachableError,
  defaultHttp,
  type Http,
} from "./wda-client.js";
import { elementType, identifierOf, toNativeTree } from "./xcui-driver.js";

interface Call {
  url: string;
  method: string;
  body?: string;
}

/** A fake WebDriverAgent that records every call and answers from a table. The
 *  table holds the `value` payload; the fake wraps it in WebDriver's `{value: …}`
 *  envelope, so the unwrapping under test is genuinely exercised. The longest
 *  matching key wins, so `/element/E42/value` beats `/element`. */
function fakeHttp(answers: Record<string, unknown>): { http: Http; calls: Call[] } {
  const calls: Call[] = [];
  const keys = Object.keys(answers).sort((a, b) => b.length - a.length);
  // Match on the route AFTER `/session/<id>`, so `/element` does not also match
  // the session-creation URL that every scoped call is built on top of.
  const routeOf = (url: string): string => {
    const at = url.indexOf("/session/");
    return at === -1 ? url : url.slice(url.indexOf("/", at + "/session/".length));
  };
  const http: Http = (url, init) => {
    calls.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
    const route = routeOf(url);
    const key = keys.find((k) => route.includes(k));
    const value = key ? answers[key] : null;
    return Promise.resolve({ ok: true, status: 200, text: JSON.stringify({ value }) });
  };
  return { http, calls };
}

async function openedClient(answers: Record<string, unknown> = {}): Promise<{
  client: WdaClient;
  calls: Call[];
}> {
  const { http, calls } = fakeHttp({ "/session": { sessionId: "S1" }, ...answers });
  const client = new WdaClient(DEFAULT_WDA_URL, http);
  await client.newSession("com.acme.checkout");
  calls.length = 0;
  return { client, calls };
}

describe("WdaClient session lifecycle", () => {
  it("creates a session scoped to the app under test", async () => {
    const { http, calls } = fakeHttp({ "/session": { sessionId: "S1" } });
    const client = new WdaClient(DEFAULT_WDA_URL, http);
    expect(await client.newSession("com.acme.checkout")).toBe("S1");
    expect(client.session).toBe("S1");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8100/session");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      capabilities: { alwaysMatch: { bundleId: "com.acme.checkout" } },
    });
  });

  it("refuses a session-scoped call before a session exists", async () => {
    const { http } = fakeHttp({});
    const client = new WdaClient(DEFAULT_WDA_URL, http);
    await expect(client.source()).rejects.toThrow(/no WebDriverAgent session is open/);
  });

  it("forgets the session id after delete, so a later call refuses instead of using a dead id", async () => {
    const { client } = await openedClient();
    await client.deleteSession();
    expect(client.session).toBeUndefined();
    await expect(client.screenshot()).rejects.toThrow(WdaCommandError);
  });
});

describe("WdaClient endpoints", () => {
  it("asks for the hierarchy as JSON, not XML", async () => {
    const { client, calls } = await openedClient({ "/source": {} });
    await client.source();
    expect(calls[0]!.url).toBe("http://127.0.0.1:8100/session/S1/source?format=json");
  });

  it("sets a value element-scoped, never as a shell string", async () => {
    // RFC 0008 §6: the materialised secret exists only inside the driver
    // dispatch. A per-character array is WebDriverAgent's own value form.
    const { client, calls } = await openedClient({ "/value": null });
    await client.setValue("E42", "hunter2");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8100/session/S1/element/E42/value");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ value: ["h", "u", "n", "t", "e", "r", "2"] });
  });

  it("drags with the XCUITest duration primitive, in seconds", async () => {
    const { client, calls } = await openedClient({ dragfromto: null });
    await client.drag({ x: 10, y: 20 }, { x: 10, y: 400 }, 0.25);
    expect(calls[0]!.url).toContain("/wda/dragfromtoforduration");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      fromX: 10,
      fromY: 20,
      toX: 10,
      toY: 400,
      duration: 0.25,
    });
  });

  it("queries the accessibility identifier strategy, which is what a testID compiles to", async () => {
    const { client, calls } = await openedClient({ "/element": { "element-6066-e4a": "E7" } });
    expect(await client.findByAccessibilityId("checkout-submit")).toBe("E7");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      using: "accessibility id",
      value: "checkout-submit",
    });
  });
});

describe("WdaClient error classification", () => {
  it("reports a missing element as null, not as a failure", async () => {
    const http: Http = () =>
      Promise.resolve({
        ok: false,
        status: 404,
        text: JSON.stringify({ value: { error: "no such element", message: "nope" } }),
      });
    const { http: open } = fakeHttp({ "/session": { sessionId: "S1" } });
    const client = new WdaClient(DEFAULT_WDA_URL, (url, init) =>
      url.endsWith("/session") ? open(url, init) : http(url, init),
    );
    await client.newSession("com.acme.checkout");
    expect(await client.findByAccessibilityId("absent")).toBeNull();
  });

  it("carries WebDriverAgent's own error code so a caller can classify it", async () => {
    const http: Http = () =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: JSON.stringify({ value: { error: "invalid session id", message: "gone" } }),
      });
    const client = new WdaClient(DEFAULT_WDA_URL, http);
    await expect(client.newSession("com.acme.checkout")).rejects.toMatchObject({
      name: "WdaCommandError",
      code: "invalid session id",
    });
  });

  it("turns a transport failure into an error that names the fix", async () => {
    const http = defaultHttp(1);
    const client = new WdaClient("http://127.0.0.1:1/", http);
    const err = await client.status().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WdaUnreachableError);
    expect((err as Error).message).toMatch(/operator-supplied/);
    // And it says what still works without WebDriverAgent, so the operator is not
    // left thinking the whole engine is down.
    expect((err as Error).message).toMatch(/simctl/);
  });
});

describe("source JSON → NativeNode", () => {
  const SOURCE = {
    type: "XCUIElementTypeApplication",
    name: "Checkout",
    label: "Checkout",
    rect: { x: 0, y: 0, width: 393, height: 852 },
    isEnabled: "true",
    isVisible: "1",
    children: [
      {
        type: "XCUIElementTypeButton",
        rawIdentifier: "checkout-submit",
        name: "checkout-submit",
        label: "Pay now",
        rect: { x: 20, y: 700, width: 353, height: 48 },
        isEnabled: true,
        isVisible: true,
        children: [],
      },
      {
        type: "XCUIElementTypeTextField",
        name: "Card number",
        label: "Card number",
        value: "4242",
        placeholderValue: "0000 0000 0000 0000",
        rect: { x: 20, y: 300, width: 353, height: 44 },
        isEnabled: "false",
        isVisible: "0",
        children: [],
      },
    ],
  };

  const tree = toNativeTree(SOURCE);

  it("strips the XCUIElementType prefix off the element type", () => {
    expect(elementType("XCUIElementTypeButton")).toBe("Button");
    // Idempotent — older WebDriverAgent builds already strip it.
    expect(elementType("Button")).toBe("Button");
    expect(elementType(undefined)).toBe("Other");
    expect(tree.type).toBe("Application");
    expect(tree.children.map((c) => c.type)).toEqual(["Button", "TextField"]);
  });

  it("reads the identifier, the label, the value and the placeholder apart", () => {
    const button = tree.children[0]!;
    expect(button.identifier).toBe("checkout-submit");
    expect(button.label).toBe("Pay now");
    const field = tree.children[1]!;
    expect(field.value).toBe("4242");
    expect(field.placeholder).toBe("0000 0000 0000 0000");
  });

  it("coerces WebDriverAgent's three spellings of a boolean", () => {
    expect(tree.children[0]!.enabled).toBe(true);
    expect(tree.children[0]!.visible).toBe(true);
    expect(tree.children[1]!.enabled).toBe(false);
    expect(tree.children[1]!.visible).toBe(false);
  });

  it("never invents an identifier when the build reports only `name`", () => {
    // The lossy read, pinned in the safe direction. A fabricated identifier would
    // mint a ref that survives a layout change it should not survive.
    expect(identifierOf({ name: "Card number", label: "Card number" })).toBeUndefined();
    expect(identifierOf({ name: "submit-btn", label: "Submit" })).toBe("submit-btn");
    // `rawIdentifier` is exact and wins over the heuristic.
    expect(identifierOf({ rawIdentifier: "real-id", name: "x", label: "y" })).toBe("real-id");
    expect(identifierOf({ rawIdentifier: "", name: "x", label: "y" })).toBe("x");
  });

  it("truncates a pathological tree at the depth cap instead of walking it out", () => {
    let deep: Record<string, unknown> = { type: "Other", children: [] };
    for (let i = 0; i < 20; i++) deep = { type: "Other", children: [deep] };
    const capped = toNativeTree(deep, 3);
    let depth = 0;
    for (let n = capped; n.children.length; n = n.children[0]!) depth++;
    expect(depth).toBe(3);
  });

  it("answers with a well-formed empty root for an empty dump", () => {
    const empty = toNativeTree(null);
    expect(empty).toMatchObject({ type: "Other", enabled: false, visible: false, children: [] });
  });
});
