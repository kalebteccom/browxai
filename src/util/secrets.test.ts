import { describe, it, expect } from "vitest";
import { SecretRegistry, composeUrlAndSecretsInText } from "./secrets.js";
import { sanitizeUrlsInText } from "./url-sanitizer.js";

describe("SecretRegistry — register flow", () => {
  it.each([
    ["rejects a lowercase name", { name: "password", value: "v" }, /must match/],
    ["rejects a mixed-case name", { name: "Password", value: "v" }, /must match/],
    ["rejects a whitespace-bearing name", { name: "MY PASS", value: "v" }, /must match/],
    ["rejects an angle-bracketed name", { name: "<PWD>", value: "v" }, /must match/],
    ["rejects an empty value (would mask everything)", { name: "X", value: "" }, /non-empty/],
  ])("%s", (_label, spec, message) => {
    expect(() => new SecretRegistry().register(spec)).toThrow(message);
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

  it.each<[string, string | string[], Array<[string, boolean]>, string[] | undefined]>([
    [
      "matches the scope as an origin, never as a substring of the URL",
      "app.example.com",
      [
        ["https://evil.test/?app.example.com", false],
        ["https://evil.test/app.example.com/login", false],
        ["https://app.example.com.evil.test/", false],
        ["https://evil.test/#https://app.example.com", false],
        ["https://app.example.com@evil.test/", false],
        ["about:blank", false],
        ["about:srcdoc", false],
        ["data:text/html,app.example.com", false],
        ["not a url", false],
        ["https://APP.example.com/x?y=1", true],
        ["https://app.example.com:443/", true],
      ],
      undefined,
    ],
    [
      "compares scheme and port for a bare-host scope",
      "app.example.com",
      [
        ["http://app.example.com/", false],
        ["https://app.example.com:8443/", false],
      ],
      undefined,
    ],
    [
      "compares scheme and port for an explicit http://localhost:3000 scope",
      "http://localhost:3000",
      [
        ["http://localhost:3000/login", true],
        ["https://localhost:3000/login", false],
        ["http://localhost:3001/login", false],
        ["http://localhost/login", false],
      ],
      undefined,
    ],
    [
      "accepts a list of origins and matches any one of them exactly",
      ["https://app.example.com", "https://sso.example.com/"],
      [
        ["https://sso.example.com/auth", true],
        ["https://app.example.com/", true],
        ["https://example.com/", false],
      ],
      ["https://app.example.com", "https://sso.example.com"],
    ],
    [
      "matches a native app scope against the app:// target url",
      "app://com.acme.app",
      [
        ["app://com.acme.app/CheckoutActivity", true],
        ["app://com.acme.app.evil/Main", false],
        ["https://com.acme.app/", false],
      ],
      undefined,
    ],
  ])("%s", (_label, scope, checks, origins) => {
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "tok-xyz", scope });
    if (origins) expect(r.scopeOrigins("TOKEN")).toEqual(origins);
    for (const [url, ok] of checks) {
      const m = r.materialize("<TOKEN>", url);
      expect(m.ok, url).toBe(ok);
      if (!ok) expect(m.materialised, url).toBe(false);
    }
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
});

describe("SecretRegistry.applyMaskInText — egress masking", () => {
  // Every row is also checked for idempotence: re-masking is a no-op because
  // the mask never contains a secret.
  it.each<[string, Array<[string, string]>, Array<[string, string]>]>([
    [
      "substitutes every occurrence of the real value with <NAME>",
      [["PASSWORD", "hunter2"]],
      [
        [
          "typed hunter2 into the field; got hunter2 back",
          "typed <PASSWORD> into the field; got <PASSWORD> back",
        ],
      ],
    ],
    [
      "masks longer values before shorter ones (no partial leak)",
      [
        ["SHORT", "abc"],
        ["LONG", "abc12345"],
      ],
      [
        ["value=abc12345", "value=<LONG>"],
        ["value=abc", "value=<SHORT>"],
      ],
    ],
    [
      "handles regex-metachar values via literal split/join",
      [["PATTERN", "a+b.c*d"]],
      [["payload=a+b.c*d end", "payload=<PATTERN> end"]],
    ],
  ])("%s", (_label, secrets, pairs) => {
    const r = new SecretRegistry();
    for (const [name, value] of secrets) r.register({ name, value });
    for (const [input, expected] of pairs) {
      const once = r.applyMaskInText(input);
      expect(once).toBe(expected);
      expect(r.applyMaskInText(once)).toBe(once);
    }
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
  // The URL's query is redacted by the URL sanitiser (?…); a LITERAL value that
  // landed outside the URL is masked by the secrets layer.
  it.each<[string, boolean, string, string]>([
    [
      "applies the URL sanitiser first, then the secrets layer",
      true,
      "connected to https://api.example.com/x?key=raw-token-12345 and stored raw-token-12345 locally",
      "connected to https://api.example.com/x?… and stored <TOKEN> locally",
    ],
    [
      "falls back to URL-sanitisation-only when no registry is given",
      false,
      "goto https://api.example.com/x?token=raw-token-12345",
      "goto https://api.example.com/x?…",
    ],
  ])("%s", (_label, withRegistry, input, expected) => {
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "raw-token-12345" });
    expect(composeUrlAndSecretsInText(input, sanitizeUrlsInText, withRegistry ? r : null)).toBe(
      expected,
    );
  });
});
