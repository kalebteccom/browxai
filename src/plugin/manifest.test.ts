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

  it("rejects a missing namespace", () => {
    expect(() => parseManifestField({ apiVersion: "1.0.0", register: "dist/index.js" })).toThrow(
      /namespace/,
    );
  });

  it("rejects an empty namespace", () => {
    expect(() =>
      parseManifestField({ apiVersion: "1.0.0", namespace: "", register: "dist/index.js" }),
    ).toThrow(/namespace/);
  });

  it("rejects an invalid namespace shape", () => {
    expect(() =>
      parseManifestField({
        apiVersion: "1.0.0",
        namespace: "Bad-NS!",
        register: "dist/index.js",
      }),
    ).toThrow(/namespace/);
  });

  it("rejects a reserved namespace", () => {
    for (const ns of RESERVED_NAMESPACES) {
      expect(() =>
        parseManifestField({
          apiVersion: "1.0.0",
          namespace: ns,
          register: "dist/index.js",
        }),
      ).toThrow(/reserved/);
    }
  });

  it("parses dependsOn entries", () => {
    const m = parseManifestField({
      apiVersion: "1.0.0",
      namespace: "demo",
      register: "dist/index.js",
      dependsOn: [{ plugin: "@browxai/plugin-example", version: "^1.0.0" }],
    });
    expect(m.dependsOn).toHaveLength(1);
    expect(m.dependsOn[0]?.plugin).toBe("@browxai/plugin-example");
  });

  it("rejects a dependsOn entry without plugin/version", () => {
    expect(() =>
      parseManifestField({
        apiVersion: "1.0.0",
        namespace: "demo",
        register: "dist/index.js",
        dependsOn: [{ plugin: "" }],
      }),
    ).toThrow();
  });
});

describe("isApiVersionCompatible", () => {
  it("accepts same major + same/lower minor", () => {
    expect(isApiVersionCompatible("1.0.0", "1.0.0")).toBe(true);
    expect(isApiVersionCompatible("1.0.0", "1.5.0")).toBe(true);
    expect(isApiVersionCompatible("1.5.0", "1.5.0")).toBe(true);
  });

  it("rejects newer minor than runtime", () => {
    expect(isApiVersionCompatible("1.5.0", "1.0.0")).toBe(false);
  });

  it("rejects different major", () => {
    expect(isApiVersionCompatible("2.0.0", "1.0.0")).toBe(false);
    expect(isApiVersionCompatible("0.5.0", "1.0.0")).toBe(false);
  });

  it("tolerates leading semver operators", () => {
    expect(isApiVersionCompatible("^1.0.0", "1.0.0")).toBe(true);
  });
});

describe("satisfiesRange", () => {
  it("* matches anything", () => {
    expect(satisfiesRange("0.0.1", "*")).toBe(true);
  });

  it("^ allows compatible-within-major", () => {
    expect(satisfiesRange("1.2.3", "^1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", "^1.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesRange("0.5.0", "^1.0.0")).toBe(false);
  });

  it("^0.x.y locks minor too", () => {
    expect(satisfiesRange("0.1.2", "^0.1.0")).toBe(true);
    expect(satisfiesRange("0.2.0", "^0.1.0")).toBe(false);
  });

  it("~ allows patch bumps only", () => {
    expect(satisfiesRange("1.0.5", "~1.0.0")).toBe(true);
    expect(satisfiesRange("1.1.0", "~1.0.0")).toBe(false);
  });

  it(">= matches anything at or above", () => {
    expect(satisfiesRange("2.0.0", ">=1.5.0")).toBe(true);
    expect(satisfiesRange("1.0.0", ">=1.5.0")).toBe(false);
  });

  it("exact requires byte match", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
  });
});
