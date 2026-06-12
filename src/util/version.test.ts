// Regression gate for version drift: the MCP handshake / SDK version must
// always equal package.json#version. The old hand-maintained constant in
// server.ts drifted (0.1.0 vs a 0.7.0 package); deriving it from
// package.json makes drift structurally impossible — this test guards
// against anyone reintroducing a literal.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "./version.js";

const pkgJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version: string };

describe("PACKAGE_VERSION", () => {
  it("equals package.json#version", () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it("is a concrete semver", () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("is re-exported as the server VERSION", async () => {
    const { VERSION } = await import("../server.js");
    expect(VERSION).toBe(pkg.version);
  });
});
