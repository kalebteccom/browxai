import { describe, it, expect } from "vitest";
import { resolveOriginPolicy, isOriginAllowed, blockedByPattern } from "./origin.js";

type Env = { BROWX_ALLOWED_ORIGINS?: string; BROWX_BLOCKED_ORIGINS?: string };

describe("resolveOriginPolicy + isOriginAllowed", () => {
  it.each<[string, Env, Array<[string, boolean]>]>([
    ["empty policy = no restriction (default)", {}, [["https://anything.example.com/", true]]],
    [
      "wildcard subdomain (bare suffix is NOT a sub-domain match)",
      { BROWX_ALLOWED_ORIGINS: "https://*.example.com" },
      [
        ["https://api.example.com/", true],
        ["https://x.y.example.com/", true],
        ["https://example.com/", false],
        ["https://malicious.example.org/", false],
      ],
    ],
    [
      "blocklist overrides allowlist",
      {
        BROWX_ALLOWED_ORIGINS: "https://*.example.com",
        BROWX_BLOCKED_ORIGINS: "https://blocked.example.com",
      },
      [
        ["https://api.example.com/", true],
        ["https://blocked.example.com/", false],
      ],
    ],
    [
      "protocol mismatch fails",
      { BROWX_ALLOWED_ORIGINS: "https://app.example.com" },
      [["http://app.example.com/", false]],
    ],
    [
      "port honoured when specified",
      { BROWX_ALLOWED_ORIGINS: "http://localhost:3000" },
      [
        ["http://localhost:3000/", true],
        ["http://localhost:8080/", false],
      ],
    ],
    [
      "unparseable URLs aren't trusted",
      { BROWX_ALLOWED_ORIGINS: "https://app.example.com" },
      [["not-a-url", false]],
    ],
    [
      "multiple allowed origins, any match wins",
      { BROWX_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com" },
      [
        ["https://a.example.com/x", true],
        ["https://b.example.com/y", true],
        ["https://c.example.com/z", false],
      ],
    ],
    [
      "a trailing-dot host matches the entry for the same host",
      { BROWX_BLOCKED_ORIGINS: "https://ads.example.com" },
      [
        ["https://ads.example.com./x", false],
        ["https://ads.example.com../x", false],
        ["https://other.example.com./x", true],
      ],
    ],
    [
      "a trailing-dot host matches a wildcard blocklist entry",
      { BROWX_BLOCKED_ORIGINS: "https://*.tracking.example.com" },
      [["https://a.tracking.example.com./", false]],
    ],
    [
      "a trailing-dot host matches an allowlist entry",
      { BROWX_ALLOWED_ORIGINS: "https://app.example.com." },
      [
        ["https://app.example.com/", true],
        ["https://app.example.com./", true],
      ],
    ],
    [
      "host case and punycode forms compare equal",
      { BROWX_BLOCKED_ORIGINS: "https://bücher.example" },
      [
        ["https://XN--BCHER-KVA.example/", false],
        ["https://BÜCHER.example./", false],
      ],
    ],
    [
      "an entry with an explicit port does not match the default port",
      { BROWX_BLOCKED_ORIGINS: "https://ads.example.com:8443" },
      [
        ["https://ads.example.com:8443/", false],
        ["https://ads.example.com/", true],
        ["https://ads.example.com:443/", true],
      ],
    ],
    [
      "an entry without a port matches the scheme default port only",
      { BROWX_BLOCKED_ORIGINS: "http://ads.example.com" },
      [
        ["http://ads.example.com/", false],
        ["http://ads.example.com:80/", false],
        ["http://ads.example.com:8080/", true],
      ],
    ],
    [
      "an entry that spells out the default port matches the bare host",
      { BROWX_BLOCKED_ORIGINS: "https://ads.example.com:443" },
      [
        ["https://ads.example.com/", false],
        ["https://ads.example.com:8443/", true],
      ],
    ],
    [
      "blob: and filesystem: URLs take the origin they wrap",
      { BROWX_BLOCKED_ORIGINS: "https://blocked.example" },
      [
        ["blob:https://blocked.example/6f1c", false],
        ["blob:https://blocked.example./6f1c", false],
        ["filesystem:https://blocked.example/temporary/x.txt", false],
        ["blob:https://fine.example/6f1c", true],
      ],
    ],
    [
      "a blob: URL is held to the allowlist through its inner origin",
      { BROWX_ALLOWED_ORIGINS: "https://app.example.com" },
      [
        ["blob:https://app.example.com/6f1c", true],
        ["blob:https://other.example.com/6f1c", false],
        ["blob:null/6f1c", false],
      ],
    ],
  ])("%s", (_label, env, checks) => {
    const p = resolveOriginPolicy(env);
    for (const [url, allowed] of checks) expect(isOriginAllowed(url, p), url).toBe(allowed);
  });

  it("unwraps a wrapper inside a wrapper, and refuses a third level", () => {
    const p = resolveOriginPolicy({ BROWX_BLOCKED_ORIGINS: "https://blocked.example" });
    // Two wrapper schemes reach the origin underneath.
    expect(isOriginAllowed("blob:blob:https://blocked.example/a/b", p)).toBe(false);
    expect(isOriginAllowed("filesystem:blob:https://blocked.example/a/b", p)).toBe(false);
    // Three do not: the URL has no origin the policy trusts, whatever it wraps.
    expect(isOriginAllowed("blob:blob:blob:https://blocked.example/a/b", p)).toBe(false);
    const open = resolveOriginPolicy({});
    expect(isOriginAllowed("blob:blob:https://fine.example/a/b", open)).toBe(true);
    expect(isOriginAllowed("blob:blob:blob:https://fine.example/a/b", open)).toBe(false);
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
