import { describe, it, expect } from "vitest";
import { patterniseUrl, extractTopLevelKeys, cdpTypeFromPlaywright } from "./network.js";

describe("patterniseUrl — url redaction", () => {
  it.each([
    [
      "strips query strings",
      "https://api.example.com/v1/records?id=42&date=2026-05-15",
      "https://api.example.com/v1/records",
    ],
    [
      "replaces UUID path segments with :id",
      "https://api.example.com/orders/550e8400-e29b-41d4-a716-446655440000",
      "https://api.example.com/orders/:id",
    ],
    [
      "replaces long hex path segments with :id (object id shapes)",
      "https://api.example.com/items/507f1f77bcf86cd799439011",
      "https://api.example.com/items/:id",
    ],
    ["returns the raw url when URL parsing fails", "not a url", "not a url"],
  ])("patterniseUrl %s", (_name, url, expected) => {
    expect(patterniseUrl(url)).toBe(expected);
  });
});

describe("extractTopLevelKeys — response shape redaction", () => {
  const big: Record<string, number> = {};
  for (let i = 0; i < 30; i++) big[`k${i}`] = i;

  it.each([
    [
      "top-level keys of a plain JSON object",
      { id: 1, name: "x", nested: { a: 1 } },
      ["id", "name", "nested"],
    ],
    [
      "the [].key prefix for an array of objects",
      [
        { id: 1, label: "a" },
        { id: 2, label: "b" },
      ],
      ["[].id", "[].label"],
    ],
    ["null for a string primitive", "just a string", null],
    ["null for a number primitive", 42, null],
    ["null for null", null, null],
    ["null for an array of non-objects", [1, 2, 3], null],
  ])("extractTopLevelKeys returns %s", (_name, input, expected) => {
    expect(extractTopLevelKeys(input)).toEqual(expected);
  });

  it("caps keys at 20", () => {
    expect(extractTopLevelKeys(big)).toHaveLength(20);
  });
});

describe("cdpTypeFromPlaywright — cross-engine resourceType reconciliation", () => {
  it("maps Playwright lowercase types onto the CDP-capitalised bucket names", () => {
    // The names the NOISE_TYPES fold + the byType summary key on must be the CDP
    // capitalisation so the network_read shape is engine-blind.
    expect(cdpTypeFromPlaywright("stylesheet")).toBe("Stylesheet");
    expect(cdpTypeFromPlaywright("image")).toBe("Image");
    expect(cdpTypeFromPlaywright("font")).toBe("Font");
    expect(cdpTypeFromPlaywright("media")).toBe("Media");
    expect(cdpTypeFromPlaywright("manifest")).toBe("Manifest");
    expect(cdpTypeFromPlaywright("document")).toBe("Document");
    expect(cdpTypeFromPlaywright("script")).toBe("Script");
    expect(cdpTypeFromPlaywright("xhr")).toBe("XHR");
    expect(cdpTypeFromPlaywright("fetch")).toBe("Fetch");
    expect(cdpTypeFromPlaywright("eventsource")).toBe("EventSource");
    expect(cdpTypeFromPlaywright("websocket")).toBe("WebSocket");
  });

  it("degrades an unknown / CDP-only type to Other (no Playwright equivalent)", () => {
    // CDP types like Ping / CSPViolationReport / Preflight have no Playwright form.
    expect(cdpTypeFromPlaywright("ping")).toBe("Other");
    expect(cdpTypeFromPlaywright("cspviolationreport")).toBe("Other");
    expect(cdpTypeFromPlaywright("")).toBe("Other");
    expect(cdpTypeFromPlaywright("other")).toBe("Other");
  });
});
