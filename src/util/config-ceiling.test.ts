import { describe, it, expect } from "vitest";
import { BUILTIN_DEFAULTS, envLayer, type ResolvedConfig } from "./config-store.js";
import { clampPolicy, policyCeiling, policyWidening } from "./config-ceiling.js";

const ceil = (env: NodeJS.ProcessEnv) => policyCeiling(envLayer(env), BUILTIN_DEFAULTS);
const cfg = (over: Partial<ResolvedConfig>): ResolvedConfig => ({ ...BUILTIN_DEFAULTS, ...over });

describe("clampPolicy", () => {
  it("confirmRequired keeps every ceiling hook and accepts added ones", () => {
    const c = ceil({});
    expect(clampPolicy(cfg({ confirmRequired: [] }), c).confirmRequired).toEqual([
      "navigate_off_allowlist",
      "byob_action",
    ]);
    expect(clampPolicy(cfg({ confirmRequired: ["file_upload"] }), c).confirmRequired).toEqual([
      "navigate_off_allowlist",
      "byob_action",
      "file_upload",
    ]);
  });

  it("allowedOrigins narrows a set env list; empty or disjoint falls back to it", () => {
    const c = ceil({ BROWX_ALLOWED_ORIGINS: "https://a.example,https://b.example" });
    expect(clampPolicy(cfg({ allowedOrigins: ["https://a.example"] }), c).allowedOrigins).toEqual([
      "https://a.example",
    ]);
    expect(clampPolicy(cfg({ allowedOrigins: [] }), c).allowedOrigins).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(
      clampPolicy(cfg({ allowedOrigins: ["https://evil.example"] }), c).allowedOrigins,
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("allowedOrigins with no env list: a saved list is a narrowing and stands", () => {
    expect(
      clampPolicy(cfg({ allowedOrigins: ["https://x.example"] }), ceil({})).allowedOrigins,
    ).toEqual(["https://x.example"]);
  });

  it("blockedOrigins keeps the env list", () => {
    const c = ceil({ BROWX_BLOCKED_ORIGINS: "https://t.example" });
    expect(clampPolicy(cfg({ blockedOrigins: [] }), c).blockedOrigins).toEqual([
      "https://t.example",
    ]);
  });

  it("disableWebSecurity is true only when the env turned it on and config did not turn it off", () => {
    expect(
      clampPolicy(cfg({ disableWebSecurity: true }), ceil({})).disableWebSecurity,
    ).toBeUndefined();
    const on = ceil({ BROWX_DISABLE_WEB_SECURITY: "1" });
    expect(clampPolicy(cfg({ disableWebSecurity: true }), on).disableWebSecurity).toBe(true);
    expect(clampPolicy(cfg({ disableWebSecurity: false }), on).disableWebSecurity).toBeUndefined();
  });

  it("plugins is a subset of BROWX_PLUGINS", () => {
    expect(clampPolicy(cfg({ plugins: ["@x/p"] }), ceil({})).plugins).toEqual([]);
    const c = ceil({ BROWX_PLUGINS: "@x/p,@x/q" });
    expect(clampPolicy(cfg({ plugins: ["@x/p", "@x/r"] }), c).plugins).toEqual(["@x/p"]);
  });
});

describe("policyWidening", () => {
  const c = ceil({
    BROWX_ALLOWED_ORIGINS: "https://a.example",
    BROWX_BLOCKED_ORIGINS: "https://t.example",
    BROWX_PLUGINS: "@x/p",
  });
  it("names every loosening", () => {
    expect(
      policyWidening(
        {
          confirmRequired: ["file_upload"],
          allowedOrigins: [],
          blockedOrigins: [],
          disableWebSecurity: true,
          plugins: ["@x/p", "@x/evil"],
        },
        c,
      ),
    ).toEqual({
      confirmRequired: ["navigate_off_allowlist", "byob_action"],
      allowedOrigins: ["(empty list: any origin)"],
      blockedOrigins: ["https://t.example"],
      disableWebSecurity: [true],
      plugins: ["@x/evil"],
    });
    expect(policyWidening({ allowedOrigins: ["https://evil.example"] }, c)).toEqual({
      allowedOrigins: ["https://evil.example"],
    });
  });
  it("accepts a tightening patch", () => {
    expect(
      policyWidening(
        {
          confirmRequired: ["navigate_off_allowlist", "byob_action", "file_upload"],
          allowedOrigins: ["https://a.example"],
          blockedOrigins: ["https://t.example", "https://u.example"],
          disableWebSecurity: false,
          plugins: [],
        },
        c,
      ),
    ).toEqual({});
  });
});
