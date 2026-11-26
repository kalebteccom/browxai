import { describe, expect, it } from "vitest";
import { classifyNavigationUrl, resolveNavigateExtraSchemes } from "./navigation-scheme.js";

describe("classifyNavigationUrl", () => {
  it.each([
    ["https://app.example.com/login", "web", "https"],
    ["http://127.0.0.1:3000/", "web", "http"],
    ["HTTPS://APP.EXAMPLE.COM/", "web", "https"],
    ["about:blank", "blank", "about"],
    ["about:blank#x", "blank", "about"],
    ["about:blank?x=1", "blank", "about"],
    ["data:text/html,<p>hi</p>", "data", "data"],
    ["file:///etc/hosts", "file", "file"],
    ["FILE:///etc/hosts", "file", "file"],
    ["  file:///etc/hosts", "file", "file"],
    ["\tfile:///etc/hosts\n", "file", "file"],
    ["fi\nle:///etc/hosts", "file", "file"],
    ["file://localhost/etc/hosts", "file", "file"],
    ["javascript:void 0", "script", "javascript"],
    ["JavaScript:alert(1)", "script", "javascript"],
    ["chrome-extension://abcdefghijklmnop/popup.html", "extension", "chrome-extension"],
    ["moz-extension://0a1b2c3d/popup.html", "extension", "moz-extension"],
    ["chrome://version", "other", "chrome"],
    ["devtools://devtools/bundled/inspector.html", "other", "devtools"],
    ["about:srcdoc", "other", "about"],
    ["about:config", "other", "about"],
    ["blob:https://app.example.com/0f8b", "other", "blob"],
    ["ftp://files.example.com/a.txt", "other", "ftp"],
    ["ws://app.example.com/socket", "other", "ws"],
    ["view-source:https://app.example.com/", "other", "view-source"],
    ["", "unparseable", ""],
    ["   ", "unparseable", ""],
    ["app.example.com/login", "unparseable", ""],
    ["/relative/path", "unparseable", ""],
  ])("%j is %s", (url, kind, scheme) => {
    const c = classifyNavigationUrl(url);
    expect(c.kind).toBe(kind);
    expect(c.scheme).toBe(scheme);
  });

  it("returns the URL a wrapping scheme wraps", () => {
    expect(classifyNavigationUrl("view-source:file:///etc/hosts")).toEqual({
      kind: "other",
      scheme: "view-source",
      inner: "file:///etc/hosts",
    });
    expect(classifyNavigationUrl("VIEW-SOURCE:https://app.example.com/a").inner).toBe(
      "https://app.example.com/a",
    );
  });

  it("gives no inner URL for a scheme that wraps nothing", () => {
    expect(classifyNavigationUrl("chrome://version").inner).toBeUndefined();
    expect(classifyNavigationUrl("https://app.example.com/").inner).toBeUndefined();
  });
});

describe("resolveNavigateExtraSchemes", () => {
  const parse = (v?: string) => [
    ...resolveNavigateExtraSchemes({ BROWX_NAVIGATE_EXTRA_SCHEMES: v }),
  ];

  it("is empty when unset or blank", () => {
    expect(parse(undefined)).toEqual([]);
    expect(parse("")).toEqual([]);
    expect(parse("  ")).toEqual([]);
  });

  it("reads scheme names with or without the colon, in any case", () => {
    expect(parse("chrome, View-Source:, devtools://,about")).toEqual([
      "chrome",
      "view-source",
      "devtools",
      "about",
    ]);
  });

  it("skips empty entries and schemes that are always open", () => {
    expect(parse("chrome,,https,data, http")).toEqual(["chrome"]);
  });

  it.each([
    ["file", "file-io"],
    ["FILE:", "file-io"],
    ["javascript", "eval"],
    ["chrome-extension", "extensions"],
    ["moz-extension", "extensions"],
  ])("refuses %s and names the %s capability", (entry, capability) => {
    expect(() => parse(`chrome,${entry}`)).toThrow(
      new RegExp(`BROWX_NAVIGATE_EXTRA_SCHEMES: .*\`${capability}\` capability`),
    );
  });

  it.each(["chrome://version", "1chrome", "view source", "*"])("throws on %j", (entry) => {
    expect(() => parse(entry)).toThrow(/BROWX_NAVIGATE_EXTRA_SCHEMES: invalid scheme/);
  });

  it("reads only its own variable", () => {
    expect([
      ...resolveNavigateExtraSchemes({ BROWX_ALLOWED_ORIGINS: "https://app.example.com" }),
    ]).toEqual([]);
  });
});
