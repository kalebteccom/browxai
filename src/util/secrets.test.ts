import { describe, it, expect } from "vitest";
import { SecretRegistry, composeUrlAndSecretsInText } from "./secrets.js";
import { sanitizeUrlsInText } from "./url-sanitizer.js";

describe("SecretRegistry — register flow", () => {
  it("accepts an uppercase identifier name with a non-empty value", () => {
    const r = new SecretRegistry();
    r.register({ name: "PASSWORD", value: "hunter2" });
    expect(r.size()).toBe(1);
    expect(r.names()).toEqual(["PASSWORD"]);
  });

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
    const refused = r.materialize("<TOKEN>", "https://attacker.example/");
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/scoped to "app.example.com"/);
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

  it("is a no-op when the registry is empty", () => {
    const r = new SecretRegistry();
    expect(r.applyMaskInText("nothing to mask")).toBe("nothing to mask");
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

  it("returns hit:false when no value appears", () => {
    const r = new SecretRegistry();
    r.register({ name: "X", value: "secret" });
    expect(r.containsAnySecret("page text without it").hit).toBe(false);
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

  it("is bounded — extremely deep nesting doesn't blow the stack", () => {
    const r = new SecretRegistry();
    r.register({ name: "X", value: "x" });
    // build a 20-deep object
    let obj: unknown = "leaf with x";
    for (let i = 0; i < 20; i++) obj = { nested: obj };
    expect(() => r.applyMaskDeep(obj)).not.toThrow();
  });
});

describe("composeUrlAndSecretsInText — sanitiser composition (W-O1 + secrets)", () => {
  it("applies the URL sanitiser first, then the secrets layer", () => {
    const r = new SecretRegistry();
    r.register({ name: "TOKEN", value: "raw-token-12345" });
    const input = `connected to https://api.example.com/x?key=raw-token-12345 and stored raw-token-12345 locally`;
    const out = composeUrlAndSecretsInText(input, sanitizeUrlsInText, r);
    // The URL's query was redacted by the W-O1 sanitiser (?…); the LITERAL
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
