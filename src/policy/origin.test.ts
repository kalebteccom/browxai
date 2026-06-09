import { describe, it, expect } from "vitest";
import { resolveOriginPolicy, isOriginAllowed } from "./origin.js";

describe("resolveOriginPolicy + isOriginAllowed", () => {
  it("empty policy = no restriction (Phase-1 default)", () => {
    const p = resolveOriginPolicy({});
    expect(isOriginAllowed("https://anything.example.com/", p)).toBe(true);
  });

  it("exact origin match in allowlist", () => {
    const p = resolveOriginPolicy({
      BROWX_ALLOWED_ORIGINS: "https://app.example.com",
    });
    expect(isOriginAllowed("https://app.example.com/x", p)).toBe(true);
    expect(isOriginAllowed("https://other.example.com/", p)).toBe(false);
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
      BROWX_BLOCKED_ORIGINS: "https://evil.example.com",
    });
    expect(isOriginAllowed("https://api.example.com/", p)).toBe(true);
    expect(isOriginAllowed("https://evil.example.com/", p)).toBe(false);
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

  it("invalid URL pattern throws at parse time", () => {
    expect(() => resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: "not-a-url" })).toThrow(
      /invalid URL/,
    );
  });
});
