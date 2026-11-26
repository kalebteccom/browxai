import { describe, expect, it } from "vitest";
import type { CDPSession } from "playwright-core";
import { SecretRegistry } from "../util/secrets.js";
import { fetchResponseBody } from "./network-cdp.js";

function cdpReturning(body: string, base64Encoded = false): CDPSession {
  return { send: () => Promise.resolve({ body, base64Encoded }) } as unknown as CDPSession;
}

describe("fetchResponseBody body cap", () => {
  const secrets = new SecretRegistry();
  secrets.register({ name: "TOKEN", value: "tok_0123456789abcdef" });

  it("masks a value that crosses the 256,000-character cut before cutting", async () => {
    const body = "x".repeat(255_995) + "tok_0123456789abcdef" + "y".repeat(10_000);
    const r = await fetchResponseBody(cdpReturning(body), "r1", 256_000, secrets);
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.body).toHaveLength(256_000);
    expect(r.body).not.toContain("tok_");
    expect(r.body!.endsWith("<TOKE")).toBe(true);
  });

  it("masks a body within the cap whole", async () => {
    const r = await fetchResponseBody(
      cdpReturning("a tok_0123456789abcdef b"),
      "r1",
      256_000,
      secrets,
    );
    expect(r).toEqual({ ok: true, body: "a <TOKEN> b", base64Encoded: false });
  });

  it("cuts a base64 body without masking it, as before", async () => {
    const r = await fetchResponseBody(cdpReturning("QUJD".repeat(10), true), "r1", 8, secrets);
    expect(r).toEqual({ ok: true, body: "QUJDQUJD", base64Encoded: true, truncated: true });
  });

  it("cuts a text body with no secret registered as before", async () => {
    const r = await fetchResponseBody(cdpReturning("abcdef"), "r1", 3, null);
    expect(r).toEqual({ ok: true, body: "abc", base64Encoded: false, truncated: true });
  });
});
