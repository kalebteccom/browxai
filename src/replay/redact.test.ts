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
  const user = JSON.stringify({ user: { name: "ada", password: "hunter2" } });

  it.each<[string, string[], string, unknown]>([
    [
      "replaces a matched leaf with a marker and leaves its siblings",
      ["user.password"],
      user,
      { user: { name: "ada", password: redactedMarker("body-rule") } },
    ],
    [
      "matches any array index through a wildcard segment",
      ["items.*.token"],
      JSON.stringify({ items: [{ token: "a" }, { token: "b" }] }),
      { items: [{ token: redactedMarker("body-rule") }, { token: redactedMarker("body-rule") }] },
    ],
    [
      "drops the whole body on the root path",
      [ROOT_PATH],
      '{"anything":1}',
      redactedMarker("body-rule"),
    ],
  ])("%s", (_label, bodyPaths, body, expected) => {
    const out = new Redactor({ bodyPaths }).payload(body);
    expect(typeof out === "string" ? JSON.parse(out) : out).toEqual(expected);
  });

  it.each<[string, string[], string | undefined]>([
    ["passes a non-JSON body through instead of failing", ["user.password"], "not json at all"],
    [
      "leaves a body with no matching path untouched",
      ["user.password"],
      JSON.stringify({ user: { name: "ada" } }),
    ],
    [
      "returns undefined for an absent body, since nothing there is not the same as taken out",
      [ROOT_PATH],
      undefined,
    ],
  ])("%s", (_label, bodyPaths, body) => {
    expect(new Redactor({ bodyPaths }).payload(body)).toBe(body);
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
});
