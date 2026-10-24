import { describe, it, expect } from "vitest";
import { SecretRegistry, composeUrlAndSecretsInText } from "./secrets.js";
import { sanitizeUrlsInText } from "./url-sanitizer.js";

describe("SecretRegistry — register flow", () => {
  it("rejects lowercase / mixed-case / whitespace-bearing names", () => {
    const r = new SecretRegistry();
    expect(() => r.register({ name: "password", value: "v" })).toThrow(/must match/);
    expect(() => r.register({ name: "Password", value: "v" })).toThrow(/must match/);
    expect(() => r.register({ name: "MY PASS", value: "v" })).toThrow(/must match/);
    expect(() => r.register({ name: "<PWD>", value: "v" })).toThrow(/must match/);
  });

  it("rejects an empty value (would mask everything)", () => {
    const r = new SecretRegistry();
    expect(() => r.register({ name: "X", value: "" })).toThrow(/non-empty/);
  });

  it("enforces a capacity cap", () => {
    const r = new SecretRegistry(2);
    r.register({ name: "A", value: "a" });
    r.register({ name: "B", value: "b" });
    expect(() => r.register({ name: "C", value: "c" })).toThrow(/capacity/);
    // replacing an existing name is allowed
    r.register({ name: "A", value: "aa" });
    expect(r.size()).toBe(2);
  });
});

describe("SecretRegistry.materialize — dispatch-side substitution", () => {
  it("substitutes <NAME> with the real value at dispatch", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const m = r.materialize("<PASSWORD>", "https://app.example.com/login");
    expect(m.ok).toBe(true);
    expect(m.materialised).toBe(true);
    expect(m.value).toBe("hunter2");
    expect(m.alias).toBe("PASSWORD");
  });

  it("passes plain strings through unchanged", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const m = r.materialize("typed by hand", "https://app.example.com/");
    expect(m.ok).toBe(true);
    expect(m.materialised).toBe(false);
    expect(m.value).toBe("typed by hand");
    expect(m.alias).toBeUndefined();
  });

  it("does NOT match angle-bracket text that isn't a registered alias", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    // partial-match shapes that should NOT trigger:
    expect(r.materialize("<PASSWORD", "u").materialised).toBe(false);
    expect(r.materialize("PASSWORD>", "u").materialised).toBe(false);
    expect(r.materialize("hello <PASSWORD> world", "u").materialised).toBe(false);
    expect(r.materialize("<password>", "u").materialised).toBe(false); // lowercase
  });

  it("returns ok:false when the alias isn't registered", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const m = r.materialize("<OTP>", "u");
    expect(m.ok).toBe(false);
    expect(m.error).toMatch(/no secret named "OTP"/);
  });

  it("refuses materialisation when scope doesn't match the page URL", () => {
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "tok-xyz", scope: "app.example.com" });
    const ok = r.materialize("<TOKEN>", "https://app.example.com/dashboard");
    expect(ok.ok).toBe(true);
    expect(ok.value).toBe("tok-xyz");
    const refused = r.materialize("<TOKEN>", "https://other.example/");
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/scoped to "https:\/\/app.example.com"/);
    expect(refused.value).toBe("<TOKEN>");
  });

  it("matches the scope as an origin, never as a substring of the URL", () => {
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "tok-xyz", scope: "app.example.com" });
    for (const url of [
      "https://evil.test/?app.example.com",
      "https://evil.test/app.example.com/login",
      "https://app.example.com.evil.test/",
      "https://evil.test/#https://app.example.com",
      "https://app.example.com@evil.test/",
      "about:blank",
      "about:srcdoc",
      "data:text/html,app.example.com",
      "not a url",
    ]) {
      const m = r.materialize("<TOKEN>", url);
      expect(m.ok, url).toBe(false);
      expect(m.materialised, url).toBe(false);
    }
    expect(r.materialize("<TOKEN>", "https://APP.example.com/x?y=1").ok).toBe(true);
    expect(r.materialize("<TOKEN>", "https://app.example.com:443/").ok).toBe(true);
  });

  it("compares scheme and port", () => {
    const r = new SecretRegistry();
    r.register({ name: "BARE", value: "v-bare", scope: "app.example.com" });
    r.register({ name: "DEV", value: "v-dev", scope: "http://localhost:3000" });
    expect(r.materialize("<BARE>", "http://app.example.com/").ok).toBe(false);
    expect(r.materialize("<BARE>", "https://app.example.com:8443/").ok).toBe(false);
    expect(r.materialize("<DEV>", "http://localhost:3000/login").ok).toBe(true);
    expect(r.materialize("<DEV>", "https://localhost:3000/login").ok).toBe(false);
    expect(r.materialize("<DEV>", "http://localhost:3001/login").ok).toBe(false);
    expect(r.materialize("<DEV>", "http://localhost/login").ok).toBe(false);
  });

  it("accepts a list of origins and matches any one of them exactly", () => {
    const r = new SecretRegistry();
    r.register({
      name: "SSO",
      value: "v-sso",
      scope: ["https://app.example.com", "https://sso.example.com/"],
    });
    expect(r.scopeOrigins("SSO")).toEqual(["https://app.example.com", "https://sso.example.com"]);
    expect(r.materialize("<SSO>", "https://sso.example.com/auth").ok).toBe(true);
    expect(r.materialize("<SSO>", "https://app.example.com/").ok).toBe(true);
    expect(r.materialize("<SSO>", "https://example.com/").ok).toBe(false);
  });

  it("rejects a scope that is not an origin at registration", () => {
    const r = new SecretRegistry();
    for (const scope of [
      "https://app.example.com/login",
      "https://app.example.com/?x=1",
      "https://user@app.example.com",
      "*.example.com",
      "app.example.com/login",
      "",
    ]) {
      expect(() => r.register({ name: "X", value: "v", scope }), scope).toThrow(/scope/);
    }
    expect(() => r.register({ name: "X", value: "v", scope: [] })).toThrow(/empty/);
    expect(r.size()).toBe(0);
  });

  it("only asks callers to resolve the receiving frame for a scoped alias", () => {
    const r = new SecretRegistry();
    r.register({ name: "OPEN", value: "v-open" });
    r.register({ name: "SCOPED", value: "v-scoped", scope: "app.example.com" });
    expect(r.needsScopeCheck("<OPEN>")).toBe(false);
    expect(r.needsScopeCheck("<SCOPED>")).toBe(true);
    expect(r.needsScopeCheck("plain text")).toBe(false);
    expect(r.needsScopeCheck("<MISSING>")).toBe(false);
    // Re-registering without a scope drops the old one.
    r.register({ name: "SCOPED", value: "v-scoped" });
    expect(r.needsScopeCheck("<SCOPED>")).toBe(false);
    expect(r.scopeOrigins("SCOPED")).toBeNull();
  });

  it("matches a native app scope against the app:// target url", () => {
    const r = new SecretRegistry();
    r.register({ name: "PIN", value: "4321", scope: "app://com.acme.app" });
    expect(r.materialize("<PIN>", "app://com.acme.app/CheckoutActivity").ok).toBe(true);
    expect(r.materialize("<PIN>", "app://com.acme.app.evil/Main").ok).toBe(false);
    expect(r.materialize("<PIN>", "https://com.acme.app/").ok).toBe(false);
  });
});

describe("SecretRegistry.applyMaskInText — egress masking", () => {
  it("substitutes every occurrence of the real value with <NAME>", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    expect(r.applyMaskInText("typed hunter2 into the field; got hunter2 back")).toBe(
      "typed <PASSWORD> into the field; got <PASSWORD> back",
    );
  });

  it("is idempotent — re-masking is a no-op (the mask never contains a secret)", () => {
    const r = new SecretRegistry();
    r.register({ name: "X", value: "secret" });
    const once = r.applyMaskInText("got secret value");
    const twice = r.applyMaskInText(once);
    expect(twice).toBe(once);
  });

  it("masks longer values before shorter ones (no partial leak)", () => {
    const r = new SecretRegistry();
    r.register({ name: "SHORT", value: "abc" });
    r.register({ name: "LONG", value: "abc12345" });
    // LONG is a superstring of SHORT — masking SHORT first would corrupt LONG.
    expect(r.applyMaskInText("value=abc12345")).toBe("value=<LONG>");
    expect(r.applyMaskInText("value=abc")).toBe("value=<SHORT>");
  });

  it("handles regex-metachar values via literal split/join", () => {
    const r = new SecretRegistry();
    r.register({ name: "PATTERN", value: "a+b.c*d" });
    expect(r.applyMaskInText("payload=a+b.c*d end")).toBe("payload=<PATTERN> end");
  });
});

describe("SecretRegistry.applyMaskInText — encoded forms", () => {
  const VALUE = "p@ss word/+é!";
  const reg = (): SecretRegistry => {
    const r = new SecretRegistry();
    r.register({ name: "PW", value: VALUE });
    return r;
  };

  it("masks the value percent-encoded in a URL query", () => {
    const url = `https://app.test/login?user=alice&pw=${encodeURIComponent(VALUE)}&x=1`;
    expect(reg().applyMaskInText(url)).toBe("https://app.test/login?user=alice&pw=<PW>&x=1");
  });

  it("masks the value form-encoded in a request body", () => {
    const body = new URLSearchParams({ user: "alice", pw: VALUE }).toString();
    expect(body).toContain("+word"); // the space became `+`
    expect(reg().applyMaskInText(body)).toBe("user=alice&pw=<PW>");
  });

  it("masks the value's own base64 and base64url, padded or not", () => {
    const b64 = Buffer.from(VALUE, "utf8").toString("base64");
    const b64url = Buffer.from(VALUE, "utf8").toString("base64url");
    const r = reg();
    expect(r.applyMaskInText(`token=${b64};`)).toBe("token=<PW>;");
    expect(r.applyMaskInText(`token=${b64url};`)).toBe("token=<PW>;");
    expect(r.applyMaskInText(`token=${b64.replace(/=+$/, "")};`)).toBe("token=<PW>;");
  });

  it("does not reach a base64 of a larger string such as Basic credentials", () => {
    // `bob:` is 4 bytes, so the value's base64 starts off a 3-byte boundary.
    const basic = Buffer.from(`bob:${VALUE}`, "utf8").toString("base64");
    expect(reg().applyMaskInText(`Authorization: Basic ${basic}`)).toBe(
      `Authorization: Basic ${basic}`,
    );
  });

  it("masks the tail of a larger base64 when the prefix is a multiple of 3 bytes", () => {
    // `alice:` is 6 bytes, so the value's base64 lands on the same boundary.
    const basic = Buffer.from(`alice:${VALUE}`, "utf8").toString("base64");
    expect(reg().applyMaskInText(`Authorization: Basic ${basic}`)).toContain("<PW>");
  });

  it("matches only the value itself for values shorter than six characters", () => {
    const r = new SecretRegistry();
    r.register({ name: "PIN", value: "a b!" });
    expect(r.applyMaskInText("pin=a%20b!")).toBe("pin=a%20b!");
    expect(r.applyMaskInText(`pin=${Buffer.from("a b!").toString("base64")}`)).not.toContain(
      "<PIN>",
    );
    expect(r.applyMaskInText("pin=a b!")).toBe("pin=<PIN>");
  });

  it("is idempotent across every form", () => {
    const r = reg();
    const text = [
      VALUE,
      encodeURIComponent(VALUE),
      new URLSearchParams({ pw: VALUE }).toString(),
      Buffer.from(VALUE, "utf8").toString("base64"),
    ].join(" | ");
    const once = r.applyMaskInText(text);
    expect(once).not.toMatch(/word|cEBz/);
    expect(r.applyMaskInText(once)).toBe(once);
    expect(r.applyMaskInResultText(once)).toBe(once);
  });

  it("masks an encoded form inside a JSON tool result and keeps it valid", () => {
    const text = JSON.stringify({ url: `https://a.test/?pw=${encodeURIComponent(VALUE)}` });
    expect(JSON.parse(reg().applyMaskInResultText(text))).toEqual({
      url: "https://a.test/?pw=<PW>",
    });
  });

  it("picks up a value registered after the first mask", () => {
    const r = reg();
    expect(r.applyMaskInText("Zm9vYmFyYmF6")).toBe("Zm9vYmFyYmF6");
    r.register({ name: "OTHER", value: "foobarbaz" });
    expect(r.applyMaskInText("Zm9vYmFyYmF6")).toBe("<OTHER>");
  });
});

describe("SecretRegistry.containsAnySecret — screenshot warning probe", () => {
  it("flags every registered name whose value appears in the text", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    r.register({ name: "OTP", value: "123456" });
    const probe = r.containsAnySecret("password is hunter2, otp 123456");
    expect(probe.hit).toBe(true);
    expect(probe.names.sort()).toEqual(["OTP", "PASSWORD"]);
  });
});

describe("SecretRegistry.applyMaskDeep — recursive object/array masking", () => {
  it("masks string leaves anywhere in the structure", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const input = {
      candidates: [
        { name: "got hunter2", testId: "pwd-input" },
        { name: "elsewhere", context: { rowText: "row with hunter2" } },
      ],
      total: 2,
    };
    const out = r.applyMaskDeep(input);
    expect(out.candidates[0]?.name).toBe("got <PASSWORD>");
    expect(out.candidates[1]?.context?.rowText).toBe("row with <PASSWORD>");
    expect(out.total).toBe(2); // non-string passes through
  });

  it("masks a leaf at depth 50 — no depth cap", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    let obj: unknown = { value: "the password is hunter2" };
    for (let i = 0; i < 50; i++) obj = { child: obj };
    const json = JSON.stringify(r.applyMaskDeep(obj));
    expect(json).not.toContain("hunter2");
    expect(json).toContain("the password is <PASSWORD>");
  });

  it("a cyclic graph terminates, masks every reachable leaf, and stays cyclic", () => {
    // The cycle-guard replaces the old depth cap. Before the fix this walk
    // bounced off `depth > 8` and returned the raw (unmasked) input node as
    // the tail of the copy — a silent partial leak, not a safe bound.
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    const node: Record<string, unknown> = { secret: "value hunter2" };
    node.self = node;
    node.children = [{ also: "hunter2 here", parent: node }];

    const out = r.applyMaskDeep(node);

    expect(out.secret).toBe("value <PASSWORD>");
    // The back-edge points at the MASKED copy, not at the raw input.
    expect(out.self).toBe(out);
    expect(out).not.toBe(node);
    const child = (out.children as Record<string, unknown>[])[0]!;
    expect(child.also).toBe("<PASSWORD> here");
    expect(child.parent).toBe(out);
    // Walk 200 hops of the cycle: no unmasked value survives anywhere on it.
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < 200; i++) {
      expect(cur.secret).toBe("value <PASSWORD>");
      cur = cur.self as Record<string, unknown>;
    }
    // The input is untouched — masking never mutates its argument.
    expect(node.secret).toBe("value hunter2");
  });

  it("collapses a shared (non-cyclic) sub-tree to one masked copy", () => {
    const r = new SecretRegistry();
    r.register({ name: "OTP", value: "987654" });
    const shared = { code: "otp 987654" };
    const out = r.applyMaskDeep({ a: shared, b: shared });
    expect(out.a.code).toBe("otp <OTP>");
    expect(out.b.code).toBe("otp <OTP>");
    expect(out.a).toBe(out.b);
  });
});

describe("composeUrlAndSecretsInText — sanitiser composition (URL + secrets)", () => {
  it("applies the URL sanitiser first, then the secrets layer", () => {
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "raw-token-12345" });
    const input = `connected to https://api.example.com/x?key=raw-token-12345 and stored raw-token-12345 locally`;
    const out = composeUrlAndSecretsInText(input, sanitizeUrlsInText, r);
    // The URL's query was redacted by the URL sanitiser (?…); the LITERAL
    // value that landed outside the URL is masked by the secrets layer.
    expect(out).toBe("connected to https://api.example.com/x?… and stored <TOKEN> locally");
  });

  it("falls back to URL-sanitisation-only when no registry is given", () => {
    const input = `goto https://api.example.com/x?token=raw-token-12345`;
    expect(composeUrlAndSecretsInText(input, sanitizeUrlsInText, null)).toBe(
      "goto https://api.example.com/x?…",
    );
  });
});
