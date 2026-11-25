import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigStore,
  envLayer,
  isHeadlessEnv,
  resolvedToEnv,
  BUILTIN_DEFAULTS,
} from "./config-store.js";

// File-handling suite: real temp-dir IO runs past the 5 s default when the CI box is loaded.
vi.setConfig({ testTimeout: 15_000 });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browx-cfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ConfigStore precedence", () => {
  it("returns built-in defaults with no env and no file", () => {
    const s = new ConfigStore(dir, {});
    expect(s.resolve()).toEqual(BUILTIN_DEFAULTS);
  });

  it("user layer overrides env; project overrides user; session overrides project", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        user: { testAttributes: ["data-u"] },
        project: { testAttributes: ["data-p"] },
      }),
    );
    const s = new ConfigStore(dir, { BROWX_TEST_ATTRIBUTES: "data-env" });
    expect(s.resolve().testAttributes).toEqual(["data-p"]); // project wins
    expect(s.resolve({ testAttributes: ["data-s"] }).testAttributes).toEqual(["data-s"]); // session wins
  });

  it("unstable.* shallow-merges across layers instead of replacing", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        user: { unstable: { flagA: true, flagB: 1 } },
      }),
    );
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

  it("a malformed config.json fails loudly instead of dropping saved restrictions", () => {
    writeFileSync(join(dir, "config.json"), "{ not valid json");
    expect(() => new ConfigStore(dir, {})).toThrow(/config\.json is malformed/);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: ["x"] }));
    expect(() => new ConfigStore(dir, {})).toThrow(/"user" is not an object/);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { allowedOrigins: "x" } }));
    expect(() => new ConfigStore(dir, {})).toThrow(/user\.allowedOrigins/);
    // The metadata collector's lenient mode still degrades to defaults.
    writeFileSync(join(dir, "config.json"), "{ not valid json");
    expect(new ConfigStore(dir, {}, { onMalformed: "ignore" }).resolve()).toEqual(BUILTIN_DEFAULTS);
  });

  it("ignores unknown sections in config.json", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        user: { headless: true },
        bogus: { capabilities: ["nope"] },
      }),
    );
    const s = new ConfigStore(dir, {});
    expect(s.resolve().headless).toBe(true);
    expect(s.resolve().capabilities).toEqual(BUILTIN_DEFAULTS.capabilities);
  });
});

describe("toolList", () => {
  it("defaults to enabled and the env layer sets it, ignoring case and spacing", () => {
    expect(new ConfigStore(dir, {}).resolve().toolList).toBe("enabled");
    expect(envLayer({ BROWX_TOOL_LIST: " Enabled " })).toEqual({ toolList: "enabled" });
    expect(envLayer({ BROWX_TOOL_LIST: "" })).toEqual({});
    expect(new ConfigStore(dir, { BROWX_TOOL_LIST: "all" }).resolve().toolList).toBe("all");
  });

  it("stops on an unknown env value and names the valid ones", () => {
    expect(() => envLayer({ BROWX_TOOL_LIST: "some" })).toThrow(
      /BROWX_TOOL_LIST: unknown value "some"\. Valid: all, enabled/,
    );
  });

  it("a saved layer overrides the env, and a bad saved value is a malformed file", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { toolList: "all" } }));
    expect(new ConfigStore(dir, { BROWX_TOOL_LIST: "enabled" }).resolve().toolList).toBe("all");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { toolList: "none" } }));
    expect(() => new ConfigStore(dir, {})).toThrow(/user\.toolList/);
  });
});

describe("toolProfile", () => {
  it("defaults to full and the env layer sets it, ignoring case and spacing", () => {
    expect(new ConfigStore(dir, {}).resolve().toolProfile).toBe("full");
    expect(envLayer({ BROWX_TOOL_PROFILE: " Core " })).toEqual({ toolProfile: "core" });
    expect(envLayer({ BROWX_TOOL_PROFILE: "" })).toEqual({});
    expect(new ConfigStore(dir, { BROWX_TOOL_PROFILE: "core" }).resolve().toolProfile).toBe("core");
  });

  it("stops on an unknown env value and names the valid ones", () => {
    expect(() => envLayer({ BROWX_TOOL_PROFILE: "lean" })).toThrow(
      /BROWX_TOOL_PROFILE: unknown value "lean"\. Valid: full, core/,
    );
  });

  it("a saved layer overrides the env, and a bad saved value is a malformed file", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { toolProfile: "full" } }));
    expect(new ConfigStore(dir, { BROWX_TOOL_PROFILE: "core" }).resolve().toolProfile).toBe("full");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { toolProfile: "lean" } }));
    expect(() => new ConfigStore(dir, {})).toThrow(/user\.toolProfile/);
  });

  it("round trips through setLayer and a fresh store", () => {
    const first = new ConfigStore(dir, {});
    first.setLayer("user", { toolProfile: "core" });
    const second = new ConfigStore(dir, {});
    expect(second.getLayer("user")).toEqual({ toolProfile: "core" });
    expect(second.resolve().toolProfile).toBe("core");
    second.resetLayer("user");
    expect(new ConfigStore(dir, {}).resolve().toolProfile).toBe("full");
  });
});

describe("chromiumSandbox", () => {
  it("defaults to auto and the env layer sets it, ignoring case and spacing", () => {
    expect(new ConfigStore(dir, {}).resolve().chromiumSandbox).toBe("auto");
    expect(envLayer({ BROWX_CHROMIUM_SANDBOX: " On " })).toEqual({ chromiumSandbox: "on" });
    expect(envLayer({ BROWX_CHROMIUM_SANDBOX: "" })).toEqual({});
    expect(new ConfigStore(dir, { BROWX_CHROMIUM_SANDBOX: "off" }).resolve().chromiumSandbox).toBe(
      "off",
    );
  });

  it("stops on an unknown env value and names the valid ones", () => {
    expect(() => envLayer({ BROWX_CHROMIUM_SANDBOX: "yes" })).toThrow(
      /BROWX_CHROMIUM_SANDBOX: unknown value "yes"\. Valid: auto, on, off/,
    );
    expect(() => new ConfigStore(dir, { BROWX_CHROMIUM_SANDBOX: "true" })).toThrow(
      /BROWX_CHROMIUM_SANDBOX/,
    );
  });

  it("a bad saved value is a malformed file", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { chromiumSandbox: "maybe" } }));
    expect(() => new ConfigStore(dir, {})).toThrow(/user\.chromiumSandbox/);
  });

  it("a saved layer can raise the level above the default and above the env", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { chromiumSandbox: "on" } }));
    expect(new ConfigStore(dir, {}).resolve().chromiumSandbox).toBe("on");
    expect(new ConfigStore(dir, { BROWX_CHROMIUM_SANDBOX: "off" }).resolve().chromiumSandbox).toBe(
      "on",
    );
  });

  it("a saved off cannot loosen the default or an env on, and the server is told", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { chromiumSandbox: "off" } }));
    const byDefault = new ConfigStore(dir, {});
    expect(byDefault.resolve().chromiumSandbox).toBe("auto");
    expect(byDefault.policyAdjustments()).toEqual(["chromiumSandbox"]);
    const underOn = new ConfigStore(dir, { BROWX_CHROMIUM_SANDBOX: "on" });
    expect(underOn.resolve().chromiumSandbox).toBe("on");
  });

  it("an env off lets a saved layer pick any level", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { chromiumSandbox: "auto" } }));
    const store = new ConfigStore(dir, { BROWX_CHROMIUM_SANDBOX: "off" });
    expect(store.resolve().chromiumSandbox).toBe("auto");
    expect(store.policyAdjustments()).toEqual([]);
  });

  it("round trips through setLayer and a fresh store", () => {
    const first = new ConfigStore(dir, {});
    first.setLayer("user", { chromiumSandbox: "on" });
    const second = new ConfigStore(dir, {});
    expect(second.getLayer("user")).toEqual({ chromiumSandbox: "on" });
    expect(second.resolve().chromiumSandbox).toBe("on");
    second.resetLayer("user");
    expect(new ConfigStore(dir, {}).resolve().chromiumSandbox).toBe("auto");
  });

  it("reports which layer the effective value came from", () => {
    expect(new ConfigStore(dir, {}).chromiumSandboxSource()).toBe("default");
    expect(new ConfigStore(dir, { BROWX_CHROMIUM_SANDBOX: "on" }).chromiumSandboxSource()).toBe(
      "env",
    );
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { chromiumSandbox: "on" } }));
    expect(new ConfigStore(dir, { BROWX_CHROMIUM_SANDBOX: "off" }).chromiumSandboxSource()).toBe(
      "user",
    );
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ user: { chromiumSandbox: "on" }, project: { chromiumSandbox: "on" } }),
    );
    expect(new ConfigStore(dir, {}).chromiumSandboxSource()).toBe("project");
  });

  it("names the env when a saved value is clamped up to it", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { chromiumSandbox: "auto" } }));
    const store = new ConfigStore(dir, { BROWX_CHROMIUM_SANDBOX: "on" });
    expect(store.resolve().chromiumSandbox).toBe("on");
    expect(store.chromiumSandboxSource()).toBe("env");
  });

  it("a session patch below the ceiling is clamped back up", () => {
    const store = new ConfigStore(dir, {});
    expect(store.resolve({ chromiumSandbox: "off" }).chromiumSandbox).toBe("auto");
    expect(store.resolve({ chromiumSandbox: "on" }).chromiumSandbox).toBe("on");
  });
});

describe("envLayer", () => {
  it("parses comma lists and the boolean headless flag", () => {
    expect(
      envLayer({ BROWX_TEST_ATTRIBUTES: "data-testid, data-x ", BROWX_HEADLESS: "1" }),
    ).toEqual({ testAttributes: ["data-testid", "data-x"], headless: true });
  });
  it("isHeadlessEnv accepts '1' and 'true' in any case, nothing else", () => {
    for (const v of ["1", "true", "TRUE", "True", " 1 "]) expect(isHeadlessEnv(v)).toBe(true);
    for (const v of [undefined, "", "0", "false", "yes", "on"])
      expect(isHeadlessEnv(v)).toBe(false);
    expect(envLayer({ BROWX_HEADLESS: "TRUE" }).headless).toBe(true);
  });

  it("disableWebSecurity maps only from the exact BROWX_DISABLE_WEB_SECURITY opt-in", () => {
    // The env is the operator's channel; `set_config` is the agent's. SOP-off is
    // the operator's call, so only the env can turn it on, and only by this name.
    expect(envLayer({ BROWX_DISABLE_WEB_SECURITY: "1" }).disableWebSecurity).toBe(true);
    const l = envLayer({ BROWX_DISABLEWEBSECURITY: "true", BROWX_INSECURE: "1" });
    expect(l.disableWebSecurity).toBeUndefined();
    expect(envLayer({ BROWX_DISABLE_WEB_SECURITY: "0" }).disableWebSecurity).toBeUndefined();
  });

  it("maps BROWX_CHANNEL onto `channel`, and omits it when blank", () => {
    expect(envLayer({ BROWX_CHANNEL: " chrome " }).channel).toBe("chrome");
    expect(envLayer({ BROWX_CHANNEL: "" }).channel).toBeUndefined();
    expect(envLayer({}).channel).toBeUndefined();
  });
});

describe("ConfigStore capability ceiling", () => {
  it("a saved list narrows the env set but never widens it", () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        user: { capabilities: ["read", "navigation", "eval", "self-approval"] },
        project: { capabilities: ["read", "eval", "byob-attach"] },
      }),
    );
    const s = new ConfigStore(dir, { BROWX_CAPABILITIES: "read,navigation,eval" });
    // project wins the precedence, then the ceiling drops byob-attach.
    expect(s.resolve().capabilities).toEqual(["read", "eval"]);
    expect(s.droppedCapabilities().sort()).toEqual(["byob-attach", "self-approval"]);
  });

  it("with no BROWX_CAPABILITIES the ceiling is the built-in default set", () => {
    const s = new ConfigStore(dir, {});
    s.setLayer("user", { capabilities: ["read", "eval", "network-body"] });
    const fresh = new ConfigStore(dir, {});
    expect(fresh.resolve().capabilities).toEqual(["read"]);
    expect(fresh.capabilityCeiling()).toEqual(BUILTIN_DEFAULTS.capabilities);
    expect(fresh.droppedCapabilities().sort()).toEqual(["eval", "network-body"]);
  });

  it("a session patch cannot widen either", () => {
    const s = new ConfigStore(dir, { BROWX_CAPABILITIES: "read" });
    expect(s.resolve({ capabilities: ["read", "eval"] }).capabilities).toEqual(["read"]);
  });

  it("an unknown name in a saved list is dropped, so it cannot fail the next start", () => {
    const s = new ConfigStore(dir, {});
    s.setLayer("user", { capabilities: ["read", "not-a-capability"] });
    expect(new ConfigStore(dir, {}).resolve().capabilities).toEqual(["read"]);
  });
});

describe("ConfigStore BROWX_CONFIG_READONLY", () => {
  it("refuses setLayer and resetLayer and leaves config.json untouched", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ user: { headless: true } }));
    const before = readFileSync(join(dir, "config.json"), "utf8");
    const s = new ConfigStore(dir, { BROWX_CONFIG_READONLY: "1" });
    expect(s.readonly).toBe(true);
    expect(() => s.setLayer("user", { headless: false })).toThrow(/^config-readonly/);
    expect(() => s.resetLayer("user")).toThrow(/^config-readonly/);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
    // Reads still resolve the persisted layers.
    expect(s.resolve().headless).toBe(true);
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
