import { describe, expect, it } from "vitest";
import {
  DATA_RESOURCE_TYPES,
  executableContentTypeReason,
  isDataResourceType,
  isExecutableContentType,
} from "./fulfil-policy.js";

describe("isDataResourceType", () => {
  it("pins the resource types a canned response answers without eval", () => {
    expect([...DATA_RESOURCE_TYPES].sort()).toEqual([
      "eventsource",
      "fetch",
      "font",
      "image",
      "manifest",
      "media",
      "stylesheet",
      "texttrack",
      "xhr",
    ]);
  });

  it.each(["xhr", "fetch", "XHR", "Fetch", "EventSource", "TextTrack", "Stylesheet", "Image"])(
    "accepts %s in either the Playwright or the CDP spelling",
    (type) => {
      expect(isDataResourceType(type)).toBe(true);
    },
  );

  it.each(["document", "Document", "script", "Script", "other", "Other", "websocket", "ping", ""])(
    "rejects %s",
    (type) => {
      expect(isDataResourceType(type)).toBe(false);
    },
  );

  it("rejects an absent type", () => {
    expect(isDataResourceType(undefined)).toBe(false);
  });
});

describe("isExecutableContentType", () => {
  it.each([
    "text/html",
    "TEXT/HTML; charset=utf-8",
    "  text/html  ",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
    "text/x-javascript",
    "text/ecmascript",
    "application/ecmascript",
    "text/jscript",
    "text/livescript",
    "text/javascript1.5",
    "Text/JavaScript;charset=UTF-8",
    // A comma-separated value: the browser takes the last valid type.
    "application/json, text/javascript",
    "text/javascript, application/json",
    "application/json,TEXT/HTML; charset=utf-8",
    "  application/json ;q=1 ,  Application/X-JavaScript  ",
  ])("is true for %s", (ct) => {
    expect(isExecutableContentType(ct)).toBe(true);
  });

  it.each([
    "application/json",
    "application/ld+json",
    "text/plain",
    "text/css",
    "image/png",
    "text/event-stream",
    "application/octet-stream",
    "",
    "application/json, text/plain",
    " Application/JSON ,text/css ",
  ])("is false for %s", (ct) => {
    expect(isExecutableContentType(ct)).toBe(false);
  });

  it("is false for an absent content type", () => {
    expect(isExecutableContentType(undefined)).toBe(false);
  });
});

describe("executableContentTypeReason", () => {
  it("names the content type, the capability and the answered types", () => {
    const reason = executableContentTypeReason("text/html");
    expect(reason).toContain('"text/html"');
    expect(reason).toContain("`eval`");
    expect(reason).toContain("xhr, fetch, eventsource");
  });
});
