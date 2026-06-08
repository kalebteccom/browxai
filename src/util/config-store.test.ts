import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, envLayer, resolvedToEnv, BUILTIN_DEFAULTS } from "./config-store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "browx-cfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ConfigStore precedence", () => {
  it("returns built-in defaults with no env and no file", () => {
    const s = new ConfigStore(dir, {});
    expect(s.resolve()).toEqual(BUILTIN_DEFAULTS);
  });

  it("env layer overrides defaults", () => {
    const s = new ConfigStore(dir, { BROWX_CAPABILITIES: "read", BROWX_HEADLESS: "1" });
    const r = s.resolve();
    expect(r.capabilities).toEqual(["read"]);
    expect(r.headless).toBe(true);
    // untouched keys keep defaults
    expect(r.testAttributes).toEqual(BUILTIN_DEFAULTS.testAttributes);
  });

  it("user layer overrides env; project overrides user; session overrides project", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      user: { capabilities: ["read", "navigation"] },
      project: { capabilities: ["read", "navigation", "action"] },
    }));
    const s = new ConfigStore(dir, { BROWX_CAPABILITIES: "read" });
    expect(s.resolve().capabilities).toEqual(["read", "navigation", "action"]); // project wins
    expect(s.resolve({ capabilities: ["read", "navigation", "action", "human", "eval"] }).capabilities)
      .toEqual(["read", "navigation", "action", "human", "eval"]); // session wins
  });

  it("arrays replace (not merge) across layers", () => {
    const s = new ConfigStore(dir, { BROWX_ALLOWED_ORIGINS: "https://a.com,https://b.com" });
    expect(s.resolve({ allowedOrigins: ["https://c.com"] }).allowedOrigins).toEqual(["https://c.com"]);
  });

  it("unstable.* shallow-merges across layers instead of replacing", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      user: { unstable: { flagA: true, flagB: 1 } },
    }));
    const s = new ConfigStore(dir, {});
    const r = s.resolve({ unstable: { flagB: 2, flagC: "x" } });
    expect(r.unstable).toEqual({ flagA: true, flagB: 2, flagC: "x" });
  });

  it("setLayer persists to config.json and is the only writer", () => {
    const s = new ConfigStore(dir, {});
    s.setLayer("user", { capabilities: ["read"] });
    const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(onDisk.user.capabilities).toEqual(["read"]);
    // a fresh store reads it back
    expect(new ConfigStore(dir, {}).resolve().capabilities).toEqual(["read"]);
  });

  it("setLayer merges into the existing layer (and unstable sub-merges)", () => {
    const s = new ConfigStore(dir, {});
    s.setLayer("project", { capabilities: ["read"], unstable: { a: 1 } });
    s.setLayer("project", { headless: true, unstable: { b: 2 } });
    const r = s.resolve();
    expect(r.capabilities).toEqual(["read"]);
    expect(r.headless).toBe(true);
    expect(r.unstable).toEqual({ a: 1, b: 2 });
  });

  it("resetLayer clears a persistent layer", () => {
    const s = new ConfigStore(dir, {});
    s.setLayer("user", { headless: true });
    s.resetLayer("user");
    expect(s.resolve().headless).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).user).toBeUndefined();
  });

  it("a malformed config.json degrades to defaults + warn, never throws", () => {
    writeFileSync(join(dir, "config.json"), "{ not valid json");
    const s = new ConfigStore(dir, {});
    expect(s.resolve()).toEqual(BUILTIN_DEFAULTS);
  });

  it("ignores unknown sections in config.json", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      user: { headless: true },
      bogus: { capabilities: ["nope"] },
    }));
    const s = new ConfigStore(dir, {});
    expect(s.resolve().headless).toBe(true);
    expect(s.resolve().capabilities).toEqual(BUILTIN_DEFAULTS.capabilities);
  });

  it("getLayer returns raw pre-merge layers", () => {
    const s = new ConfigStore(dir, { BROWX_HEADLESS: "true" });
    expect(s.getLayer("defaults")).toEqual(BUILTIN_DEFAULTS);
    expect(s.getLayer("env")).toEqual({ headless: true });
    expect(s.getLayer("user")).toEqual({});
    expect(s.getLayer("session")).toEqual({});
  });
});

describe("envLayer", () => {
  it("parses comma lists and the boolean headless flag", () => {
    expect(envLayer({ BROWX_TEST_ATTRIBUTES: "data-testid, data-x ", BROWX_HEADLESS: "1" }))
      .toEqual({ testAttributes: ["data-testid", "data-x"], headless: true });
  });
  it("omits keys with no env present (so defaults survive)", () => {
    expect(envLayer({})).toEqual({});
  });
  it("treats only '1'/'true' as headless-on", () => {
    expect(envLayer({ BROWX_HEADLESS: "0" }).headless).toBe(false);
    expect(envLayer({ BROWX_HEADLESS: "true" }).headless).toBe(true);
  });

  it("disableWebSecurity is NOT mappable from any env var (security invariant)", () => {
    // Deliberately excluded from the legacy layer — must never be ambiently
    // enabled via the environment. Any plausible env spelling stays undefined.
    const l = envLayer({
      BROWX_DISABLE_WEB_SECURITY: "1",
      BROWX_DISABLEWEBSECURITY: "true",
      BROWX_INSECURE: "1",
    } as NodeJS.ProcessEnv);
    expect(l.disableWebSecurity).toBeUndefined();
  });
});

describe("actionTimeoutMs precedence", () => {
  it("defaults undefined (server falls back to 5000); set via any persistent layer or session", () => {
    const dir = mkdtempSync(join(tmpdir(), "browx-wm1-"));
    try {
      const s = new ConfigStore(dir, {});
      expect(s.resolve().actionTimeoutMs).toBeUndefined();
      s.setLayer("user", { actionTimeoutMs: 3000 });
      expect(s.resolve().actionTimeoutMs).toBe(3000);
      s.setLayer("project", { actionTimeoutMs: 1500 });
      expect(s.resolve().actionTimeoutMs).toBe(1500); // project > user
      expect(s.resolve({ actionTimeoutMs: 20000 }).actionTimeoutMs).toBe(20000); // session > project
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("disableWebSecurity precedence", () => {
  it("defaults off; settable only via user/project/session layers", () => {
    const dir = mkdtempSync(join(tmpdir(), "browx-wl1-"));
    try {
      const s = new ConfigStore(dir, { BROWX_DISABLE_WEB_SECURITY: "1" } as NodeJS.ProcessEnv);
      expect(s.resolve().disableWebSecurity).toBeUndefined(); // env can't enable it
      s.setLayer("project", { disableWebSecurity: true });
      expect(s.resolve().disableWebSecurity).toBe(true);
      // session layer can still override back off
      expect(s.resolve({ disableWebSecurity: false }).disableWebSecurity).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hideOverlaySelectors precedence", () => {
  it("defaults []; env layer parses; project/session override", () => {
    const dir = mkdtempSync(join(tmpdir(), "browx-hos-"));
    try {
      const s = new ConfigStore(dir, {
        BROWX_HIDE_OVERLAY_SELECTORS: "#hmr, .devtools-iframe ",
      } as NodeJS.ProcessEnv);
      expect(s.resolve().hideOverlaySelectors).toEqual(["#hmr", ".devtools-iframe"]);
      s.setLayer("project", { hideOverlaySelectors: ["#cookie-banner"] });
      expect(s.resolve().hideOverlaySelectors).toEqual(["#cookie-banner"]);
      // session layer wins (e.g. opt back out)
      expect(s.resolve({ hideOverlaySelectors: [] }).hideOverlaySelectors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("absent env leaves the built-in [] default", () => {
    const dir = mkdtempSync(join(tmpdir(), "browx-hos2-"));
    try {
      expect(new ConfigStore(dir, {}).resolve().hideOverlaySelectors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolvedToEnv adapter", () => {
  it("round-trips through the env-shaped resolvers", () => {
    const env = resolvedToEnv({
      testAttributes: ["data-testid"],
      capabilities: ["read", "navigation"],
      confirmRequired: ["byob_action"],
      allowedOrigins: ["https://a.com"],
      blockedOrigins: [],
      headless: true,
      hideOverlaySelectors: [],
      plugins: [],
      unstable: {},
    });
    expect(env.BROWX_CAPABILITIES).toBe("read,navigation");
    expect(env.BROWX_HEADLESS).toBe("1");
    expect(env.BROWX_BLOCKED_ORIGINS).toBe("");
  });
});

// Sanity: config file path lands in the workspace root, not cwd (no-trace).
describe("ConfigStore no-trace", () => {
  it("writes config.json under the given workspace root only", () => {
    const s = new ConfigStore(dir, {});
    s.setLayer("user", { headless: true });
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  });
});
