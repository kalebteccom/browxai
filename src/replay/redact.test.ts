import { describe, expect, it } from "vitest";
import { SecretRegistry } from "../util/secrets.js";
import {
  DEFAULT_DROPPED_HEADERS,
  Redactor,
  redactEvent,
  redactedMarker,
  ROOT_PATH,
} from "./redact.js";
import { isRedacted, type ReplayEvent } from "./schema.js";

function registryWith(name: string, value: string): SecretRegistry {
  const r = new SecretRegistry();
  r.register({ name, value });
  return r;
}

describe("header rules", () => {
  it("drops authorization / cookie / set-cookie by default", () => {
    expect([...DEFAULT_DROPPED_HEADERS]).toEqual(["authorization", "cookie", "set-cookie"]);
    const out = new Redactor().headers({
      Authorization: "Bearer abc",
      Cookie: "sid=1",
      "set-cookie": "sid=2",
      "content-type": "application/json",
    });
    expect(out).toEqual({
      Authorization: redactedMarker("header"),
      Cookie: redactedMarker("header"),
      "set-cookie": redactedMarker("header"),
      "content-type": "application/json",
    });
  });

  it("replaces the authorization value with a marker rather than deleting the key", () => {
    const out = new Redactor().headers({ authorization: "Bearer abc" })!;
    expect(Object.keys(out)).toContain("authorization");
    expect(isRedacted(out.authorization)).toBe(true);
    expect(JSON.stringify(out)).not.toContain("Bearer abc");
  });

  it("is configurable — a custom list replaces the defaults", () => {
    const out = new Redactor({ headers: ["x-api-key"] }).headers({
      "X-API-Key": "k",
      authorization: "Bearer abc",
    })!;
    expect(isRedacted(out["X-API-Key"])).toBe(true);
    expect(out.authorization).toBe("Bearer abc");
  });

  it("masks a registered secret that landed in a header not on the drop list", () => {
    const out = new Redactor({ secrets: registryWith("TOKEN", "s3cr3t") }).headers({
      "x-trace": "trace s3cr3t",
    })!;
    expect(out["x-trace"]).toBe("trace <TOKEN>");
  });
});

describe("body rules by JSON path", () => {
  it("replaces a matched leaf with a marker and leaves its siblings", () => {
    const body = JSON.stringify({ user: { name: "ada", password: "hunter2" } });
    const out = new Redactor({ bodyPaths: ["user.password"] }).payload(body);
    expect(JSON.parse(out as string)).toEqual({
      user: { name: "ada", password: redactedMarker("body-rule") },
    });
  });

  it("matches any array index through a wildcard segment", () => {
    const body = JSON.stringify({ items: [{ token: "a" }, { token: "b" }] });
    const out = new Redactor({ bodyPaths: ["items.*.token"] }).payload(body);
    expect(out).not.toContain('"a"');
    expect(JSON.parse(out as string)).toEqual({
      items: [{ token: redactedMarker("body-rule") }, { token: redactedMarker("body-rule") }],
    });
  });

  it("drops the whole body on the root path", () => {
    const out = new Redactor({ bodyPaths: [ROOT_PATH] }).payload('{"anything":1}');
    expect(out).toEqual(redactedMarker("body-rule"));
  });

  it("passes a non-JSON body through instead of failing", () => {
    const out = new Redactor({ bodyPaths: ["user.password"] }).payload("not json at all");
    expect(out).toBe("not json at all");
  });

  it("leaves a body with no matching path untouched", () => {
    const body = JSON.stringify({ user: { name: "ada" } });
    expect(new Redactor({ bodyPaths: ["user.password"] }).payload(body)).toBe(body);
  });

  it("returns undefined for an absent body — nothing there is not the same as taken out", () => {
    expect(new Redactor({ bodyPaths: [ROOT_PATH] }).payload(undefined)).toBeUndefined();
  });
});

describe("a WS frame gets the same treatment as an HTTP body", () => {
  it("applies the identical rule to both", () => {
    const r = new Redactor({
      bodyPaths: ["auth.token"],
      secrets: registryWith("PASSWORD", "hunter2"),
    });
    const wire = JSON.stringify({ auth: { token: "t" }, echo: "hunter2" });
    const httpBody = r.payload(wire);
    const wsFrame = r.payload(wire);
    expect(wsFrame).toEqual(httpBody);
    expect(JSON.parse(wsFrame as string)).toEqual({
      auth: { token: redactedMarker("body-rule") },
      echo: "<PASSWORD>",
    });
  });
});

describe("registered secrets", () => {
  it("masks through the SecretRegistry chokepoint, deeply", () => {
    const r = new Redactor({ secrets: registryWith("PASSWORD", "hunter2") });
    const masked = r.mask({ a: ["hunter2", { b: "x hunter2 y" }], n: 1 });
    expect(masked).toEqual({ a: ["<PASSWORD>", { b: "x <PASSWORD> y" }], n: 1 });
  });

  it("cannot survive redactEvent, including in a field no rule knows about", () => {
    const r = new Redactor({ secrets: registryWith("PASSWORD", "hunter2") });
    const ev: ReplayEvent = {
      t: 12,
      type: "console/message",
      v: 1,
      payload: { text: "login hunter2", futureFieldNobodyDeclared: { deep: ["hunter2"] } },
    };
    const out = redactEvent(ev, r);
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).toContain("<PASSWORD>");
    expect(out.t).toBe(12);
  });

  it("is a no-op when no secret is registered", () => {
    const body = '{"a":"b"}';
    expect(new Redactor().payload(body)).toBe(body);
  });
});
