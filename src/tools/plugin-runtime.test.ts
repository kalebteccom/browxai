import { describe, expect, it, vi, afterEach } from "vitest";
import { warnNonFirstPartyPlugins } from "./plugin-runtime.js";
import { log } from "../util/logging.js";
import type { PluginRecord } from "../plugin/types.js";
import type { TrustTier } from "../plugin/manifest.js";

function record(name: string, trust: TrustTier, capabilities: string[] = []): PluginRecord {
  return {
    manifest: {
      name,
      version: "1.0.0",
      path: `/tmp/${name}`,
      entryPath: `/tmp/${name}/index.js`,
      trust,
      browxai: {
        apiVersion: "1.0.0",
        namespace: name.replace(/[^a-z]/g, ""),
        register: "index.js",
        capabilities,
        dependsOn: [],
      },
    },
    status: "loaded",
    tools: [],
    transitiveDeps: [],
    declaredCapabilities: capabilities,
    declaredAt: "plugins.json",
  } as unknown as PluginRecord;
}

afterEach(() => vi.restoreAllMocks());

describe("warnNonFirstPartyPlugins", () => {
  it("stays silent when every loaded plugin is first-party", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    warnNonFirstPartyPlugins([record("@browxai/plugin-a", "kalebtec", ["eval"])]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent when nothing loaded", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    warnNonFirstPartyPlugins([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("names each community plugin with its declared capabilities", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    warnNonFirstPartyPlugins([
      record("@browxai/plugin-first", "kalebtec"),
      record("browxai-plugin-third", "community", ["eval", "file-io"]),
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0];
    expect(msg).toContain("1 non-first-party plugin(s)");
    expect(msg).toContain("browxai-plugin-third@1.0.0 [community]");
    expect(msg).toContain("eval, file-io");
    expect(msg).not.toContain("plugin-first");
  });

  it("says so explicitly when a plugin declared no capabilities", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    warnNonFirstPartyPlugins([record("local-dev-plugin", "local")]);
    const msg = warn.mock.calls[0]![0];
    expect(msg).toContain("[local]");
    expect(msg).toContain("none declared");
  });

  it("states that the capability list is disclosure, not enforcement", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    warnNonFirstPartyPlugins([record("browxai-plugin-third", "community", ["eval"])]);
    const msg = warn.mock.calls[0]![0];
    expect(msg).toContain("does not sandbox plugins");
    expect(msg).toContain("disclosure, not enforcement");
  });
});
