// Registry integrity: read from the package manager's lockfile only for a
// registry fetch of the package under its own name and version.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistryIntegrity } from "./registry-integrity.js";

const NAME = "@browxai/plugin-figma";
const SRI = "sha512-QUJDREVGR0g=";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browxai-integrity-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const npmLock = (pkg: Record<string, unknown>) =>
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${NAME}`]: pkg } }),
  );

describe("npm package-lock.json", () => {
  it("returns the integrity of a registry fetch", () => {
    npmLock({
      version: "0.1.1",
      resolved: "https://registry.npmjs.org/@browxai/plugin-figma/-/plugin-figma-0.1.1.tgz",
      integrity: SRI,
    });
    expect(readRegistryIntegrity(dir, NAME, "0.1.1")).toBe(SRI);
  });

  it("returns nothing for an alias", () => {
    npmLock({
      name: "evil",
      version: "0.1.1",
      resolved: "https://registry.npmjs.org/evil/-/evil-0.1.1.tgz",
      integrity: SRI,
    });
    expect(readRegistryIntegrity(dir, NAME, "0.1.1")).toBeUndefined();
  });

  it("returns nothing for a git or tarball install", () => {
    npmLock({ version: "0.1.1", resolved: "git+ssh://git@github.com/someone/repo.git#abc" });
    expect(readRegistryIntegrity(dir, NAME, "0.1.1")).toBeUndefined();
    npmLock({ version: "0.1.1", resolved: "https://example.com/p.tgz", integrity: SRI });
    expect(readRegistryIntegrity(dir, NAME, "0.1.1")).toBeUndefined();
  });
});

describe("pnpm-lock.yaml", () => {
  const pnpmLock = (importerVersion: string, packages: string) =>
    writeFileSync(
      join(dir, "pnpm-lock.yaml"),
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        `      '${NAME}':`,
        "        specifier: ^0.1.1",
        `        version: ${importerVersion}`,
        "",
        "packages:",
        "",
        packages,
        "",
      ].join("\n"),
    );

  it("returns the integrity of a registry fetch", () => {
    pnpmLock("0.1.1", `  '${NAME}@0.1.1':\n    resolution: {integrity: ${SRI}}\n`);
    expect(readRegistryIntegrity(dir, NAME, "0.1.1")).toBe(SRI);
  });

  it("returns nothing for an alias, even when the real package is also in the lock", () => {
    pnpmLock(
      "evil@0.1.1",
      `  'evil@0.1.1':\n    resolution: {integrity: ${SRI}}\n\n  '${NAME}@0.1.1':\n    resolution: {integrity: ${SRI}}\n`,
    );
    expect(readRegistryIntegrity(dir, NAME, "0.1.1")).toBeUndefined();
  });

  it("returns nothing for a git dependency", () => {
    pnpmLock(
      "0.1.1",
      `  '${NAME}@0.1.1':\n    resolution: {commit: abc, repo: https://github.com/someone/repo, type: git}\n`,
    );
    expect(readRegistryIntegrity(dir, NAME, "0.1.1")).toBeUndefined();
  });
});

it("returns nothing when no lockfile exists", () => {
  expect(readRegistryIntegrity(dir, NAME, "0.1.1")).toBeUndefined();
});
