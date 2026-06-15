import { describe, it, expect } from "vitest";
import { SecretRegistry, composeUrlAndSecretsInText } from "./secrets.js";
import { sanitizeUrlsInText } from "./url-sanitizer.js";
import { EgressSanitiser } from "./egress-sanitiser.js";

// The EgressSanitiser is the single masking chokepoint (RFC 0004 P3 / D4). Its
// behaviour must be byte-identical to the prior hand-calls — these assertions pin
// it against the existing primitives (`composeUrlAndSecretsInText` /
// `applyMaskDeep` / `containsAnySecret`) so a divergence fails loudly.

describe("EgressSanitiser", () => {
  it("maskText composes URL-sanitisation then secrets-masking, identical to composeUrlAndSecretsInText", () => {
    const reg = new SecretRegistry();
    reg.register({ name: "TOKEN", value: "hunter2" });
    const san = new EgressSanitiser(reg);
    const input = "visit https://x.test/u/123?token=abc with hunter2 inside";
    expect(san.maskText(input)).toBe(
      composeUrlAndSecretsInText(input, sanitizeUrlsInText, reg),
    );
    // the secret value is masked and the URL is sanitised
    expect(san.maskText(input)).not.toContain("hunter2");
    expect(san.maskText(input)).toContain("<TOKEN>");
  });

  it("with a null registry, maskText still URL-sanitises but does not secrets-mask", () => {
    const san = new EgressSanitiser(null);
    const input = "https://x.test/u/123?token=abc and hunter2";
    expect(san.maskText(input)).toBe(sanitizeUrlsInText(input));
    // no secrets registry → the literal value is untouched (capability off)
    expect(san.maskText(input)).toContain("hunter2");
  });

  it("maskDeep masks string leaves like applyMaskDeep; null registry is a pass-through", () => {
    const reg = new SecretRegistry();
    reg.register({ name: "PWD", value: "s3cret" });
    const withReg = new EgressSanitiser(reg);
    const payload = { a: "s3cret", b: { c: ["x", "s3cret"] }, n: 7 };
    expect(withReg.maskDeep(payload)).toEqual(reg.applyMaskDeep(payload));
    expect(JSON.stringify(withReg.maskDeep(payload))).not.toContain("s3cret");

    const noReg = new EgressSanitiser(null);
    expect(noReg.maskDeep(payload)).toEqual(payload);
  });

  it("active reflects whether a non-empty registry is attached", () => {
    expect(new EgressSanitiser(null).active).toBe(false);
    const empty = new SecretRegistry();
    expect(new EgressSanitiser(empty).active).toBe(false);
    empty.register({ name: "K", value: "v" });
    expect(new EgressSanitiser(empty).active).toBe(true);
  });

  it("containsAnySecret mirrors the registry probe and is empty for a null registry", () => {
    const reg = new SecretRegistry();
    reg.register({ name: "API", value: "zzz999" });
    const san = new EgressSanitiser(reg);
    expect(san.containsAnySecret("text with zzz999")).toEqual(reg.containsAnySecret("text with zzz999"));
    expect(san.containsAnySecret("nothing here").hit).toBe(false);
    expect(new EgressSanitiser(null).containsAnySecret("zzz999")).toEqual({ hit: false, names: [] });
  });
});
