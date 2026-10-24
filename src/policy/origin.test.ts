import { describe, it, expect } from "vitest";
import { resolveOriginPolicy, isOriginAllowed, blockedByPattern } from "./origin.js";

describe("resolveOriginPolicy + isOriginAllowed", () => {
  it("empty policy = no restriction ( default)", () => {
    const p = resolveOriginPolicy({});
    expect(isOriginAllowed("https://anything.example.com/", p)).toBe(true);
  });

  it("wildcard subdomain", () => {
    const p = resolveOriginPolicy({
      BROWX_ALLOWED_ORIGINS: "https://*.example.com",
    });
    expect(isOriginAllowed("https://api.example.com/", p)).toBe(true);
    expect(isOriginAllowed("https://x.y.example.com/", p)).toBe(true);
    expect(isOriginAllowed("https://example.com/", p)).toBe(false); // bare suffix is NOT a sub-domain match
    expect(isOriginAllowed("https://malicious.example.org/", p)).toBe(false);
  });

  it("blocklist overrides allowlist", () => {
    const p = resolveOriginPolicy({
      BROWX_ALLOWED_ORIGINS: "https://*.example.com",
      BROWX_BLOCKED_ORIGINS: "https://blocked.example.com",
    });
    expect(isOriginAllowed("https://api.example.com/", p)).toBe(true);
    expect(isOriginAllowed("https://blocked.example.com/", p)).toBe(false);
  });

  it("protocol mismatch fails", () => {
    const p = resolveOriginPolicy({
      BROWX_ALLOWED_ORIGINS: "https://app.example.com",
    });
    expect(isOriginAllowed("http://app.example.com/", p)).toBe(false);
  });

  it("port honoured when specified", () => {
    const p = resolveOriginPolicy({
      BROWX_ALLOWED_ORIGINS: "http://localhost:3000",
    });
    expect(isOriginAllowed("http://localhost:3000/", p)).toBe(true);
    expect(isOriginAllowed("http://localhost:8080/", p)).toBe(false);
  });

  it("unparseable URLs aren't trusted", () => {
    const p = resolveOriginPolicy({
      BROWX_ALLOWED_ORIGINS: "https://app.example.com",
    });
    expect(isOriginAllowed("not-a-url", p)).toBe(false);
  });

  it("multiple allowed origins, any match wins", () => {
    const p = resolveOriginPolicy({
      BROWX_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com",
    });
    expect(isOriginAllowed("https://a.example.com/x", p)).toBe(true);
    expect(isOriginAllowed("https://b.example.com/y", p)).toBe(true);
    expect(isOriginAllowed("https://c.example.com/z", p)).toBe(false);
  });

  it("a trailing-dot host matches the entry for the same host", () => {
    const p = resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "https://ads.example.com" });
    expect(isOriginAllowed("https://ads.example.com./x", p)).toBe(false);
    expect(isOriginAllowed("https://ads.example.com../x", p)).toBe(false);
    expect(isOriginAllowed("https://other.example.com./x", p)).toBe(true);
  });

  it("a trailing-dot host matches a wildcard entry and an allowlist entry", () => {
    const wild = resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "https://*.tracking.example.com" });
    expect(isOriginAllowed("https://a.tracking.example.com./", wild)).toBe(false);
    const allow = resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: "https://app.example.com." });
    expect(isOriginAllowed("https://app.example.com/", allow)).toBe(true);
    expect(isOriginAllowed("https://app.example.com./", allow)).toBe(true);
  });

  it("host case and punycode forms compare equal", () => {
    const p = resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "https://bücher.example" });
    expect(isOriginAllowed("https://XN--BCHER-KVA.example/", p)).toBe(false);
    expect(isOriginAllowed("https://BÜCHER.example./", p)).toBe(false);
  });

  it("an entry with an explicit port does not match the default port", () => {
    const p = resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "https://ads.example.com:8443" });
    expect(isOriginAllowed("https://ads.example.com:8443/", p)).toBe(false);
    expect(isOriginAllowed("https://ads.example.com/", p)).toBe(true);
    expect(isOriginAllowed("https://ads.example.com:443/", p)).toBe(true);
  });

  it("an entry without a port matches the scheme default port only", () => {
    const p = resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "http://ads.example.com" });
    expect(isOriginAllowed("http://ads.example.com/", p)).toBe(false);
    expect(isOriginAllowed("http://ads.example.com:80/", p)).toBe(false);
    expect(isOriginAllowed("http://ads.example.com:8080/", p)).toBe(true);
  });

  it("an entry that spells out the default port matches the bare host", () => {
    const p = resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "https://ads.example.com:443" });
    expect(isOriginAllowed("https://ads.example.com/", p)).toBe(false);
    expect(isOriginAllowed("https://ads.example.com:8443/", p)).toBe(true);
  });

  it("blob: and filesystem: URLs take the origin they wrap", () => {
    const p = resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "https://blocked.example" });
    expect(isOriginAllowed("blob:https://blocked.example/6f1c", p)).toBe(false);
    expect(isOriginAllowed("blob:https://blocked.example./6f1c", p)).toBe(false);
    expect(isOriginAllowed("filesystem:https://blocked.example/temporary/x.txt", p)).toBe(false);
    expect(isOriginAllowed("blob:https://fine.example/6f1c", p)).toBe(true);
  });

  it("a blob: URL is held to the allowlist through its inner origin", () => {
    const p = resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: "https://app.example.com" });
    expect(isOriginAllowed("blob:https://app.example.com/6f1c", p)).toBe(true);
    expect(isOriginAllowed("blob:https://other.example.com/6f1c", p)).toBe(false);
    expect(isOriginAllowed("blob:null/6f1c", p)).toBe(false);
  });

  it("blockedByPattern names the matching entry", () => {
    const p = resolveOriginPolicy({
      BROWX_BLOCKED_ORIGINS: "https://a.example,https://*.b.example",
    });
    expect(blockedByPattern("https://x.b.example./", p)).toBe("https://*.b.example");
    expect(blockedByPattern("https://a.example/", p)).toBe("https://a.example");
    expect(blockedByPattern("https://c.example/", p)).toBeNull();
  });

  it("invalid URL pattern throws at parse time", () => {
    expect(() => resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: "not-a-url" })).toThrow(
      /invalid URL/,
    );
  });
});
