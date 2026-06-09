import { describe, it, expect } from "vitest";
import { sanitizeUrl, sanitizeUrlsInText, patterniseSegment } from "./url-sanitizer.js";

describe("sanitizeUrl — credential/identity redaction", () => {
  it("strips the query string but signals one was present", () => {
    expect(sanitizeUrl("https://api.example.com/v1/stream?token=abc.def.ghi&u=42")).toBe(
      "https://api.example.com/v1/stream?…",
    );
  });

  it("strips the fragment too", () => {
    expect(sanitizeUrl("https://example.com/p#access_token=xyz")).toBe("https://example.com/p#…");
  });

  it("strips user:pass@ userinfo", () => {
    expect(sanitizeUrl("https://user:secret@example.com/path")).toBe("https://example.com/path");
  });

  it("patternises id / token-shaped path segments, keeps route words", () => {
    expect(sanitizeUrl("https://api.example.com/users/12345/profile")).toBe(
      "https://api.example.com/users/:id/profile",
    );
    expect(sanitizeUrl("https://cdn.example.com/s/eyJhbGciOiJI1NiJ9aGVsbG8x/clip.m3u8")).toBe(
      "https://cdn.example.com/s/:id/clip.m3u8",
    );
  });

  it("preserves ws/wss scheme + host + path, drops the credentialled query", () => {
    expect(sanitizeUrl("wss://rt.example.com/socket?sid=AAAA1111bearer&jwt=h.p.s")).toBe(
      "wss://rt.example.com/socket?…",
    );
  });

  it("collapses opaque blob:/data: urls to just the scheme", () => {
    expect(sanitizeUrl("blob:https://example.com/9f1c-uuid-here")).toBe("blob:…");
    expect(sanitizeUrl("data:text/html;base64,SGVsbG8=")).toBe("data:…");
  });

  it("returns non-URL input unchanged", () => {
    expect(sanitizeUrl("not a url")).toBe("not a url");
  });
});

describe("patterniseSegment — token heuristic is conservative", () => {
  it("keeps human route words (no digit → never a token)", () => {
    expect(patterniseSegment("documentation")).toBe("documentation");
    expect(patterniseSegment("profile")).toBe("profile");
    expect(patterniseSegment("v2")).toBe("v2"); // short, under the length floor
  });

  it("redacts long high-entropy mixed tokens", () => {
    expect(patterniseSegment("aB3xK9zQ1mN7pR2tV5wL")).toBe(":id");
  });
});

describe("sanitizeUrlsInText — url substrings inside free text", () => {
  it("redacts a credentialled url embedded in a console message", () => {
    const msg = 'WebSocket connection to "wss://rt.example.com/ws?token=SEKRET99" failed';
    expect(sanitizeUrlsInText(msg)).toBe(
      'WebSocket connection to "wss://rt.example.com/ws?…" failed',
    );
  });

  it("leaves text with no urls untouched", () => {
    expect(sanitizeUrlsInText("plain log line, no urls here")).toBe("plain log line, no urls here");
  });

  it("redacts multiple urls in one line independently", () => {
    const t = "from https://a.example.com/x?k=1 to http://b.example.com/y/12345";
    expect(sanitizeUrlsInText(t)).toBe(
      "from https://a.example.com/x?… to http://b.example.com/y/:id",
    );
  });
});
