import { describe, it, expect } from "vitest";
import {
  redactUrlForLog,
  sanitizeUrl,
  sanitizeUrlsInText,
  patterniseSegment,
} from "./url-sanitizer.js";

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

describe("redactUrlForLog: a URL as a log line prints it", () => {
  const userinfo = ["user", "hunter2"].join(":");
  it.each<[string, string, string]>([
    [
      "drops userinfo",
      `http://${userinfo}@127.0.0.1:9222/json/version`,
      "http://127.0.0.1:9222/json/version",
    ],
    [
      "replaces a query with a marker",
      "https://x.test/reset?token=abc123&next=home",
      "https://x.test/reset?…",
    ],
    [
      "replaces a fragment with a marker",
      "https://x.test/cb#access_token=abc123",
      "https://x.test/cb#…",
    ],
    [
      "userinfo, query and fragment together",
      `wss://${userinfo}@rt.x.test:8443/ws?ticket=abc#frag`,
      "wss://rt.x.test:8443/ws?…#…",
    ],
    ["keeps an IPv6 host and port", "http://[::1]:9222/json?key=abc", "http://[::1]:9222/json?…"],
    [
      "prints an identifier in the path as :id, as tool output does",
      "ws://127.0.0.1:9222/devtools/browser/0a1b2c3d-1111-2222-3333-444455556666",
      "ws://127.0.0.1:9222/devtools/browser/:id",
    ],
    ["keeps a file path", "file:///srv/site/page.html?draft=1", "file:///srv/site/page.html?…"],
    ["collapses a data: URL to its scheme", "data:text/html,<p>hi</p>", "data:…"],
    ["leaves a URL with nothing to strip alone", "https://x.test/a/b", "https://x.test/a/b"],
    ["leaves a bare host and port alone", "localhost:9222", "localhost:9222"],
    ["leaves about:blank alone", "about:blank", "about:blank"],
    [
      "drops userinfo from a bare host and port",
      `${userinfo}@127.0.0.1:9222/json?x=1`,
      "127.0.0.1:9222/json?…",
    ],
    ["cuts text that is no URL at its first ? or #", "not a url ?token=abc#frag", "not a url ?…"],
    ["cuts at a # that comes first", "page#section?x=1", "page#…"],
    ["leaves plain text alone", "no url here", "no url here"],
    ["leaves an empty string alone", "", ""],
  ])("%s", (_label, input, expected) => {
    expect(redactUrlForLog(input)).toBe(expected);
  });

  it("never returns a query value, fragment or password for any row shape", () => {
    const out = [
      redactUrlForLog(`https://${userinfo}@x.test/p?token=tok-12345#frag-67890`),
      redactUrlForLog("x.test/p?token=tok-12345#frag-67890"),
    ].join(" ");
    expect(out).not.toMatch(/hunter2|tok-12345|frag-67890/);
  });
});
