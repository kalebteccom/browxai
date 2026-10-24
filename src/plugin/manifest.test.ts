// Manifest parser + semver helpers.

import { describe, it, expect } from "vitest";
import {
  isApiVersionCompatible,
  parseManifestField,
  RESERVED_NAMESPACES,
  satisfiesRange,
} from "./manifest.js";

describe("parseManifestField", () => {
  it("accepts a minimal valid manifest", () => {
    const m = parseManifestField({
      apiVersion: "1.0.0",
      namespace: "demo",
      register: "dist/index.js",
    });
    expect(m.namespace).toBe("demo");
    expect(m.capabilities).toEqual([]);
    expect(m.dependsOn).toEqual([]);
  });

  const base = { apiVersion: "1.0.0", register: "dist/index.js" };
  it.each([
    { label: "an empty namespace", manifests: [{ ...base, namespace: "" }], error: /namespace/ },
    {
      label: "an invalid namespace shape",
      manifests: [{ ...base, namespace: "Bad-NS!" }],
      error: /namespace/,
    },
    {
      label: "a reserved namespace",
      manifests: [...RESERVED_NAMESPACES].map((namespace) => ({ ...base, namespace })),
      error: /reserved/,
    },
    {
      label: "a dependsOn entry without plugin/version",
      manifests: [{ ...base, namespace: "demo", dependsOn: [{ plugin: "" }] }],
      error: /./,
    },
  ])("rejects $label", ({ manifests, error }) => {
    for (const m of manifests) expect(() => parseManifestField(m)).toThrow(error);
  });
});

describe("isApiVersionCompatible", () => {
  it.each([
    ["1.0.0", "1.0.0", true],
    ["1.0.0", "1.5.0", true],
    ["1.5.0", "1.5.0", true],
    ["1.5.0", "1.0.0", false],
    ["2.0.0", "1.0.0", false],
    ["0.5.0", "1.0.0", false],
    ["^1.0.0", "1.0.0", true],
  ])("plugin %s on runtime %s is compatible: %s", (plugin, runtime, expected) => {
    expect(isApiVersionCompatible(plugin, runtime)).toBe(expected);
  });
});

describe("satisfiesRange", () => {
  it.each([
    ["0.0.1", "*", true],
    ["1.2.3", "^1.0.0", true],
    ["1.0.0", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.5.0", "^1.0.0", false],
    ["0.1.2", "^0.1.0", true],
    ["0.2.0", "^0.1.0", false],
    ["1.0.5", "~1.0.0", true],
    ["1.1.0", "~1.0.0", false],
    ["2.0.0", ">=1.5.0", true],
    ["1.0.0", ">=1.5.0", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
  ])("version %s against range %s: %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});
