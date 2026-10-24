// Trust tier: `kalebtec` follows the recorded install, never the name alone.

import { describe, expect, it } from "vitest";
import {
  clampDeclaredTrust,
  inferTrustFromInstallIdentity,
  isPlainRegistrySpec,
  isVerifiedFirstParty,
} from "./trust.js";

const NAME = "@browxai/plugin-figma";
const INTEGRITY = "sha512-AAAA";
const entry = (source: string, integrity: string | undefined = INTEGRITY) => ({
  name: NAME,
  source,
  ...(integrity === undefined ? {} : { integrity }),
});

describe("isPlainRegistrySpec", () => {
  it.each([NAME, `${NAME}@0.1.1`, `${NAME}@^0.1.0`, `${NAME}@latest`, `${NAME}@>=0.1 <0.3`])(
    "accepts %s",
    (spec) => expect(isPlainRegistrySpec(spec, NAME)).toBe(true),
  );

  it.each([
    `${NAME}@npm:evil`,
    `${NAME}@npm:evil@1.0.0`,
    `${NAME}@github:someone/repo`,
    `${NAME}@git+https://example.com/repo.git`,
    `${NAME}@https://example.com/p.tgz`,
    `${NAME}@file:../p`,
    "github:someone/repo",
    "https://example.com/p.tgz",
    "file:./packages/plugins/figma",
    "@browxai/plugin-figmax",
    `${NAME}@`,
  ])("rejects %s", (spec) => expect(isPlainRegistrySpec(spec, NAME)).toBe(false));
});

describe("isVerifiedFirstParty", () => {
  it("grants a plain registry spec of the exact name with an integrity hash", () => {
    expect(isVerifiedFirstParty(NAME, entry(NAME), NAME)).toBe(true);
    expect(isVerifiedFirstParty(NAME, entry(`${NAME}@^0.1.0`), NAME)).toBe(true);
  });

  it("refuses an aliased name", () => {
    expect(isVerifiedFirstParty(NAME, entry(`${NAME}@npm:evil`), NAME)).toBe(false);
  });

  it("refuses a git spec whose package.json claims the name", () => {
    expect(isVerifiedFirstParty(NAME, entry("github:someone/repo"), NAME)).toBe(false);
    expect(isVerifiedFirstParty(NAME, entry(`${NAME}@github:someone/repo`), NAME)).toBe(false);
  });

  it("refuses a tarball URL and a file: path", () => {
    expect(isVerifiedFirstParty(NAME, entry("https://example.com/p.tgz"), NAME)).toBe(false);
    expect(isVerifiedFirstParty(NAME, entry("file:/tmp/figma"), NAME)).toBe(false);
  });

  it("refuses a lock entry without an integrity hash, or no entry at all", () => {
    expect(isVerifiedFirstParty(NAME, entry(NAME, undefined), NAME)).toBe(false);
    expect(isVerifiedFirstParty(NAME, entry(NAME, ""), NAME)).toBe(false);
    expect(isVerifiedFirstParty(NAME, undefined, NAME)).toBe(false);
  });

  it("refuses when the installed package.json names another package", () => {
    expect(isVerifiedFirstParty(NAME, entry(NAME), "evil")).toBe(false);
  });

  it("refuses a name outside the @browxai scope", () => {
    const other = { name: "browxai-plugin-x", source: "browxai-plugin-x", integrity: INTEGRITY };
    expect(isVerifiedFirstParty("browxai-plugin-x", other, "browxai-plugin-x")).toBe(false);
  });
});

describe("tier helpers", () => {
  it("tags file: installs local, verified installs kalebtec, the rest community", () => {
    expect(inferTrustFromInstallIdentity("file:/tmp/p", true)).toBe("local");
    expect(inferTrustFromInstallIdentity(NAME, true)).toBe("kalebtec");
    expect(inferTrustFromInstallIdentity(NAME, false)).toBe("community");
  });

  it("drops a kalebtec claim the install does not support and keeps downgrades", () => {
    expect(clampDeclaredTrust("kalebtec", false)).toEqual({
      trust: undefined,
      rejected: "kalebtec",
    });
    expect(clampDeclaredTrust("kalebtec", true)).toEqual({ trust: "kalebtec" });
    expect(clampDeclaredTrust("community", false)).toEqual({ trust: "community" });
    expect(clampDeclaredTrust(undefined, false)).toEqual({ trust: undefined });
  });
});
