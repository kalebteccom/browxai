// `browxai doctor` byob-attach warning — env set/unset x capability on/off.

import { describe, expect, it } from "vitest";
import { attachCapabilityCheck } from "./doctor-attach.js";
import { DEFAULT_CAPABILITIES, type Capability } from "../util/capabilities.js";

const DEFAULTS: ReadonlySet<Capability> = new Set(DEFAULT_CAPABILITIES);
const WITH_ATTACH: ReadonlySet<Capability> = new Set([...DEFAULT_CAPABILITIES, "byob-attach"]);

describe("attachCapabilityCheck", () => {
  it("warns, without failing, when BROWX_ATTACH_CDP is set and byob-attach is off", () => {
    const row = attachCapabilityCheck("http://127.0.0.1:9222", DEFAULTS);
    expect(row).not.toBeNull();
    expect(row!.ok).toBe(true);
    expect(row!.warn).toBe(true);
    expect(row!.info).toBeUndefined();
    expect(row!.fix).toContain("BROWX_CAPABILITIES=read,navigation,action,human,byob-attach");
  });

  it("is silent when byob-attach is enabled", () => {
    expect(attachCapabilityCheck("http://127.0.0.1:9222", WITH_ATTACH)).toBeNull();
  });

  it("is silent when BROWX_ATTACH_CDP is unset or blank", () => {
    expect(attachCapabilityCheck(undefined, DEFAULTS)).toBeNull();
    expect(attachCapabilityCheck("  ", DEFAULTS)).toBeNull();
  });
});
