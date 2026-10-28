import { describe, it, expect } from "vitest";
import { sanitizeUrl, sanitizeUrlsInText, patterniseSegment } from "./url-sanitizer.js";

describe("sanitizeUrl — credential/identity redaction", () => {
  it.each<[string, Array<[string, string]>]>([
    [
      "strips the query string but signals one was present",
      [
        [
          "https://api.example.com/v1/stream?token=abc.def.ghi&u=42",
          "https://api.example.com/v1/stream?…",
        ],
      ],
    ],
    [
      "strips the fragment too",
      [["https://example.com/p#access_token=xyz", "https://example.com/p#…"]],
    ],
    [
      "strips user:pass@ userinfo",
      [[["https://user", "secret"].join(":") + "@example.com/path", "https://example.com/path"]],
    ],
    [
      "patternises id / token-shaped path segments, keeps route words",
      [
        [
          "https://api.example.com/users/12345/profile",
          "https://api.example.com/users/:id/profile",
        ],
        [
          "https://cdn.example.com/s/eyJhbGciOiJI1NiJ9aGVsbG8x/clip.m3u8",
          "https://cdn.example.com/s/:id/clip.m3u8",
        ],
      ],
    ],
    [
      "collapses opaque blob:/data: urls to just the scheme",
      [
        ["blob:https://example.com/9f1c-uuid-here", "blob:…"],
        ["data:text/html;base64,SGVsbG8=", "data:…"],
      ],
    ],
    ["returns non-URL input unchanged", [["not a url", "not a url"]]],
  ])("sanitizeUrl: %s", (_label, pairs) => {
    for (const [input, expected] of pairs) expect(sanitizeUrl(input)).toBe(expected);
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
  it.each([
    [
      "redacts a credentialled url embedded in a console message",
      'WebSocket connection to "wss://rt.example.com/ws?token=SEKRET99" failed',
      'WebSocket connection to "wss://rt.example.com/ws?…" failed',
    ],
    [
      "redacts multiple urls in one line independently",
      "from https://a.example.com/x?k=1 to http://b.example.com/y/12345",
      "from https://a.example.com/x?… to http://b.example.com/y/:id",
    ],
  ])("sanitizeUrlsInText: %s", (_label, input, expected) => {
    expect(sanitizeUrlsInText(input)).toBe(expected);
  });
});
