import { describe, it, expect } from "vitest";
import { MAX_UNWRAP_DEPTH, safeUrl, unwrapOrigin } from "./origin-unwrap.js";
import { originOf, parseScope, scopeMatches, targetOrigin } from "./secret-scope.js";
import { isOriginAllowed, resolveOriginPolicy } from "../policy/origin.js";

const unwrapped = (url: string): string | null => {
  const u = safeUrl(url);
  const inner = u && unwrapOrigin(u);
  return inner ? inner.href : null;
};

describe("unwrapOrigin", () => {
  it("returns an unwrapped URL as it is", () => {
    expect(unwrapped("https://a.example/x")).toBe("https://a.example/x");
  });

  it("peels blob: and filesystem: to the URL they wrap", () => {
    expect(unwrapped("blob:https://a.example/6f1c")).toBe("https://a.example/6f1c");
    expect(unwrapped("filesystem:https://a.example/temporary/x.txt")).toBe(
      "https://a.example/temporary/x.txt",
    );
  });

  it("peels up to MAX_UNWRAP_DEPTH wrappers and returns null past it", () => {
    expect(MAX_UNWRAP_DEPTH).toBe(2);
    expect(unwrapped("blob:blob:https://a.example/x")).toBe("https://a.example/x");
    expect(unwrapped("filesystem:blob:https://a.example/x")).toBe("https://a.example/x");
    expect(unwrapped("blob:blob:blob:https://a.example/x")).toBeNull();
  });

  it("returns null when the wrapped part does not parse", () => {
    expect(unwrapped("blob:null/6f1c")).toBeNull();
    expect(unwrapped("blob:not a url")).toBeNull();
  });
});

describe("the secret scope and the origin allowlist read the same origin", () => {
  const urls = [
    "https://app.example.com/page",
    "blob:https://app.example.com/6f1c",
    "filesystem:https://app.example.com/temporary/x.txt",
    "blob:blob:https://app.example.com/a/b",
    "blob:blob:blob:https://app.example.com/a/b",
    "blob:null/6f1c",
    "about:blank",
    "data:text/plain,hi",
    "https://other.example.com/page",
    "blob:https://other.example.com/6f1c",
    "filesystem:https://other.example.com/temporary/x.txt",
  ];
  const policy = resolveOriginPolicy({ BROWX_ALLOWED_ORIGINS: "https://app.example.com" });
  const scope = parseScope("https://app.example.com");

  it.each(urls)("agree on %s", (url) => {
    expect(scopeMatches(scope, url)).toBe(isOriginAllowed(url, policy));
  });

  it("a scope matches a filesystem: URL through its inner origin", () => {
    expect(scopeMatches(scope, "filesystem:https://app.example.com/temporary/x.txt")).toBe(true);
    expect(scopeMatches(scope, "filesystem:https://other.example.com/temporary/x.txt")).toBe(false);
    expect(originOf("filesystem:https://app.example.com/temporary/x.txt")).toBe(
      "https://app.example.com",
    );
  });

  it("a scope matches a blob: URL through its inner origin", () => {
    expect(scopeMatches(scope, "blob:https://app.example.com/6f1c")).toBe(true);
    expect(scopeMatches(scope, "blob:https://other.example.com/6f1c")).toBe(false);
    expect(targetOrigin("blob:null/6f1c")).toBeNull();
  });

  it("a scope refuses a wrapper nested three deep", () => {
    expect(scopeMatches(scope, "blob:blob:https://app.example.com/a/b")).toBe(true);
    expect(scopeMatches(scope, "blob:blob:blob:https://app.example.com/a/b")).toBe(false);
  });
});
